import { app, BrowserWindow, ipcMain, net, session, shell, safeStorage, clipboard } from 'electron';
import { z } from 'zod';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { release } from 'node:os';
import type { ZodType } from 'zod';
import { LauncherError, LauncherService } from '@hunaumcl/application';
import {
  channels,
  createInstanceSchema,
  emptyRequestSchema,
  instanceIdSchema,
  launchOfflineSchema,
  accountInputSchema,
  updateAccountSchema,
  updateInstanceSchema,
  launchAccountSchema,
  configureComponentsSchema,
  microsoftConfigSchema,
  microsoftLoginSchema,
} from '@hunaumcl/contracts';
import type { Result } from '@hunaumcl/contracts';
import { toGameOS } from '@hunaumcl/domain';
import {
  ActivityManager,
  FileInstanceRepository,
  LocalJavaProvider,
  MojangVersionProvider,
  VanillaGameRuntime,
  FileAccountRepository,
  LoaderCatalogProvider,
  gameDirectory,
  recoverComponentTransactions,
  setLoaderTransport,
  MicrosoftLoginManager,
} from '@hunaumcl/runtime-node';

let window: BrowserWindow | undefined;
// electron-builder's portable target extracts the app to a temporary folder and exposes the
// directory that contains the single executable; keep all profile data next to that executable.
const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDirectory) app.setPath('userData', join(portableDirectory, 'profile'));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('org.hunaumcl.desktop');
      // A process environment override is useful for portable development and isolated tests.
      const root = process.env.HUNAUMCL_DATA_DIR ?? join(app.getPath('userData'), 'data');
      setLoaderTransport((input, init) =>
        net.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
      );
      await recoverComponentTransactions(root);
      const versions = new MojangVersionProvider();
      const java = new LocalJavaProvider();
      const host = {
        os: toGameOS(process.platform),
        osVersion: release(),
        architecture: process.arch,
        appVersion: app.getVersion(),
      };
      const components = new LoaderCatalogProvider();
      const repository = new FileInstanceRepository(root);
      const runtime = new VanillaGameRuntime(root, versions, java, host, undefined, components);
      const accounts = new FileAccountRepository(root, {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
      });
      const microsoft = new MicrosoftLoginManager(root, accounts);
      const activity = new ActivityManager(runtime, microsoft);
      const service = new LauncherService(
        repository,
        versions,
        java,
        host,
        runtime,
        activity,
        accounts,
        components,
      );
      const productionURL = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
      const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
      const expectedURL = devURL ? new URL(devURL).href : productionURL;

      function handle<Input, Output>(
        channel: string,
        schema: ZodType<Input>,
        operation: (input: Input) => Promise<Output>,
      ) {
        ipcMain.handle(
          channel,
          async (event: IpcMainInvokeEvent, input: unknown): Promise<Result<Output>> => {
            const frame = event.senderFrame;
            if (
              !window ||
              event.sender !== window.webContents ||
              frame !== event.sender.mainFrame ||
              frame.url !== expectedURL
            ) {
              return { ok: false, error: { code: 'FORBIDDEN', message: '此窗口无法执行该操作' } };
            }
            const validated = schema.safeParse(input);
            if (!validated.success)
              return {
                ok: false,
                error: {
                  code: 'INVALID_INPUT',
                  message: validated.error.issues[0]?.message ?? '请求格式不正确',
                },
              };
            try {
              return { ok: true, value: await operation(validated.data) };
            } catch (error) {
              return {
                ok: false,
                error:
                  error instanceof LauncherError
                    ? { code: error.code, message: error.message }
                    : { code: 'OPERATION_FAILED', message: '操作未完成，请确认启动器可以写入文件后重试' },
              };
            }
          },
        );
      }
      handle(channels.listInstances, emptyRequestSchema, () => service.listInstances());
      handle(channels.microsoftConfiguration, emptyRequestSchema, () => microsoft.configuration());
      handle(channels.configureMicrosoft, microsoftConfigSchema, (input) => microsoft.configure(input));
      handle(channels.startMicrosoftLogin, microsoftLoginSchema, (input) => microsoft.start(input.accountId));
      handle(channels.microsoftLoginStatus, emptyRequestSchema, async () => microsoft.snapshot());
      handle(channels.cancelMicrosoftLogin, instanceIdSchema, async (id) => microsoft.cancel(id));
      handle(channels.openMicrosoftLogin, instanceIdSchema, async (id) => {
        await shell.openExternal(microsoft.authorization(id).uri);
      });
      handle(channels.copyMicrosoftCode, instanceIdSchema, async (id) =>
        clipboard.writeText(microsoft.authorization(id).code),
      );
      handle(channels.openMicrosoftHelp, z.enum(['registration', 'api-access']), async (kind) => {
        await shell.openExternal(
          kind === 'registration'
            ? 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
            : 'https://aka.ms/mce-reviewappid',
        );
      });
      handle(channels.componentCatalog, createInstanceSchema.shape.versionId, (id) =>
        service.componentCatalog(id),
      );
      handle(channels.configureComponents, configureComponentsSchema, (request) =>
        service.configureComponents(request),
      );
      handle(channels.openGameDirectory, instanceIdSchema, async (id) => {
        const instance = (await repository.list()).find((instance) => instance.id === id);
        if (!instance) throw new LauncherError('INSTANCE_NOT_FOUND', '实例已不存在');
        const directory = await gameDirectory(root, instance, await runtime.installedComponents(instance));
        const error = await shell.openPath(directory);
        if (error) throw new LauncherError('OPEN_DIRECTORY_FAILED', '无法打开游戏目录');
      });
      handle(channels.accounts, emptyRequestSchema, () => service.accounts());
      handle(channels.createAccount, accountInputSchema, (request) => service.createAccount(request));
      handle(channels.updateAccount, updateAccountSchema, (request) => service.updateAccount(request));
      handle(channels.selectAccount, instanceIdSchema, (id) => service.selectAccount(id));
      handle(channels.deleteAccount, instanceIdSchema, (id) => service.deleteAccount(id));
      handle(channels.updateInstance, updateInstanceSchema, (request) => service.updateInstance(request));
      handle(channels.launchAccount, launchAccountSchema, (request) => service.launchAccount(request));
      handle(channels.createInstance, createInstanceSchema, (request) => service.createInstance(request));
      handle(channels.catalog, emptyRequestSchema, () => service.catalog());
      handle(channels.environment, emptyRequestSchema, () => service.environment());
      handle(channels.checkLaunch, instanceIdSchema, (id) => service.checkLaunch(id));
      handle(channels.install, instanceIdSchema, (id) => service.install(id));
      handle(channels.launchOffline, launchOfflineSchema, (request) => service.launchOffline(request));
      handle(channels.activity, emptyRequestSchema, () => service.activity());
      handle(channels.cancelTask, instanceIdSchema, (id) => service.cancelTask(id));
      handle(channels.stopSession, instanceIdSchema, (id) => service.stopSession(id));
      handle(channels.windowState, emptyRequestSchema, async () => ({
        maximized: window?.isMaximized() ?? false,
      }));
      handle(channels.windowMinimize, emptyRequestSchema, async () => {
        window?.minimize();
      });
      handle(channels.windowToggleMaximize, emptyRequestSchema, async () => {
        const maximized = window?.isMaximized() ?? false;
        if (maximized) window?.unmaximize();
        else window?.maximize();
        return { maximized: !maximized };
      });
      handle(channels.windowClose, emptyRequestSchema, async () => {
        window?.close();
      });
      let closing = false;
      app.on('before-quit', (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        void Promise.allSettled([activity.shutdown(), microsoft.shutdown()]).finally(() => app.quit());
      });

      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const createWindow = () => {
        window = new BrowserWindow({
          width: 1200,
          height: 820,
          minWidth: 900,
          minHeight: 680,
          show: false,
          title: 'HUNAUMCL',
          frame: false,
          backgroundColor: '#f3f6fa',
          autoHideMenuBar: true,
          webPreferences: {
            preload: join(__dirname, '../preload/index.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => {
          if (url !== expectedURL) event.preventDefault();
        });
        window.webContents.on('will-attach-webview', (event) => event.preventDefault());
        const publishWindowState = () => {
          if (!window || window.isDestroyed()) return;
          window.webContents.send(channels.windowStateChanged, { maximized: window.isMaximized() });
        };
        window.on('maximize', publishWindowState);
        window.on('unmaximize', publishWindowState);
        window.once('ready-to-show', () => window?.show());
        window.on('closed', () => {
          window = undefined;
        });
        if (devURL) void window.loadURL(devURL);
        else void window.loadFile(join(__dirname, '../renderer/index.html'));
      };
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      console.error('HUNAUMCL startup failed', error instanceof Error ? error.name : 'UnknownError');
      app.exit(1);
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
