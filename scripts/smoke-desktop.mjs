import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), 'hunaumcl-smoke-'));
const artifacts = resolve('test-results');
await mkdir(artifacts, { recursive: true });
const jar = Buffer.concat([
  Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
  Buffer.alloc(512 * 1024),
]);
const asset = Buffer.from('smoke-test-asset');
const hash = (bytes) => createHash('sha1').update(bytes).digest('hex');
const assetIndex = Buffer.from(
  JSON.stringify({ objects: { 'test.txt': { hash: hash(asset), size: asset.length } } }),
);
const download = (url, bytes) => ({ url, sha1: hash(bytes), size: bytes.length });
const files = {
  'https://piston-data.mojang.com/smoke-client.jar': [...jar],
  'https://libraries.minecraft.net/test/library/1/library-1.jar': [...jar],
  'https://piston-meta.mojang.com/smoke-assets.json': [...assetIndex],
  [`https://resources.download.minecraft.net/${hash(asset).slice(0, 2)}/${hash(asset)}`]: [...asset],
};
const metadata = JSON.stringify({
  id: '1.21.1',
  mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { majorVersion: 21 },
  type: 'release',
  assets: 'smoke-assets',
  arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] },
  downloads: { client: download('https://piston-data.mojang.com/smoke-client.jar', jar) },
  assetIndex: {
    ...download('https://piston-meta.mojang.com/smoke-assets.json', assetIndex),
    id: 'smoke-assets',
  },
  libraries: [
    {
      name: 'test:library:1',
      downloads: {
        artifact: {
          ...download('https://libraries.minecraft.net/test/library/1/library-1.jar', jar),
          path: 'test/library/1/library-1.jar',
        },
      },
    },
  ],
});
const manifest = JSON.stringify({
  latest: { release: '1.21.1' },
  versions: [
    {
      id: '1.21.1',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/test/1.21.1.json',
      sha1: createHash('sha1').update(metadata).digest('hex'),
      releaseTime: '2024-08-08T00:00:00Z',
    },
  ],
});
let desktop;
try {
  desktop = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--user-data-dir=${join(data, 'electron-profile')}`],
    env: { ...process.env, HUNAUMCL_DATA_DIR: data, HUNAUMCL_MICROSOFT_CLIENT_ID: '' },
    timeout: 40_000,
  });
  // Inject a deterministic transport only into this launched test process.
  await desktop.evaluate(
    (_electron, fixtures) => {
      globalThis.__hunaumclDelay = true;
      globalThis.__hunaumclMsAuthorized = false;
      globalThis.__hunaumclMsDeviceError = false;
      globalThis.__hunaumclMinecraftDenied = false;
      globalThis.__hunaumclOpenedURLs = [];
      _electron.shell.openExternal = async (url) => {
        globalThis.__hunaumclOpenedURLs.push(url);
      };
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
        if (url === 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode') {
          if (globalThis.__hunaumclMsDeviceError)
            return json(
              {
                error: 'unauthorized_client',
                error_codes: [700016],
                error_description:
                  "AADSTS700016: Application with identifier 'test' was not found in the directory 'consumers'. Trace ID: private-test-trace",
              },
              400,
            );
          return json({
            device_code: 'private-test-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://www.microsoft.com/link',
            expires_in: 900,
            interval: 1,
          });
        }
        if (url === 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token')
          return globalThis.__hunaumclMsAuthorized
            ? json({ access_token: 'private-test-oauth-token', refresh_token: 'private-test-refresh-token' })
            : json({ error: 'authorization_pending' }, 400);
        if (url === 'https://user.auth.xboxlive.com/user/authenticate')
          return json({ Token: 'private-test-xbox-token', DisplayClaims: { xui: [{ uhs: 'test-uhs' }] } });
        if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize')
          return json({
            Token: 'private-test-xsts-token',
            DisplayClaims: { xui: [{ uhs: 'test-uhs', xid: '12345' }] },
          });
        if (url === 'https://api.minecraftservices.com/authentication/login_with_xbox') {
          if (globalThis.__hunaumclMinecraftDenied)
            return json(
              {
                path: '/authentication/login_with_xbox',
                errorType: 'FORBIDDEN',
                errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information',
              },
              403,
            );
          return json({ access_token: 'private-test-minecraft-token', expires_in: 3600 });
        }
        if (url === 'https://api.minecraftservices.com/entitlements/mcstore')
          return json({ items: [{ name: 'game_minecraft' }] });
        if (url === 'https://api.minecraftservices.com/minecraft/profile')
          return json({ id: '0123456789abcdef0123456789abcdef', name: 'Online_Player' });
        if (url.startsWith('https://meta.fabricmc.net/v2/versions/loader/'))
          return new Response(JSON.stringify([{ loader: { version: '0.16.0', stable: true } }]));
        if (url.includes('files.minecraftforge.net/net/minecraftforge/forge/index_'))
          return new Response('<html>test parser fallback</html>');
        if (url.includes('bmclapi2.bangbang93.com/forge/minecraft/'))
          return new Response(
            JSON.stringify([
              {
                version: '52.0.1',
                mcversion: '1.21.1',
                files: [{ category: 'installer', format: 'jar', hash: 'a'.repeat(40) }],
              },
            ]),
          );
        if (url.includes('maven.neoforged.net/api/maven/versions/'))
          return new Response(JSON.stringify({ versions: ['21.1.42'] }));
        if (url.includes('bmclapi2.bangbang93.com/optifine/'))
          return new Response(
            JSON.stringify([
              {
                mcversion: '1.21.1',
                type: 'HD_U',
                patch: 'J1',
                filename: 'OptiFine_1.21.1_HD_U_J1.jar',
                forge: 'Forge 52.0.1',
              },
            ]),
          );
        if (url.includes('api.cfwidget.com/322385')) return new Response(JSON.stringify({ files: [] }));
        if (url.includes('api.modrinth.com/v2/project/')) return new Response('[]');
        if (globalThis.__hunaumclDelay && url.endsWith('smoke-client.jar'))
          return new Promise((_, reject) => {
            if (init.signal.aborted) reject(init.signal.reason);
            else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        if (url.endsWith('version_manifest_v2.json')) return new Response(fixtures.manifest);
        if (url.endsWith('/1.21.1.json')) return new Response(fixtures.metadata);
        if (fixtures.files[url]) {
          const bytes = new Uint8Array(fixtures.files[url]);
          if (url.endsWith('smoke-client.jar')) {
            let position = 0;
            return new Response(
              new ReadableStream({
                async pull(controller) {
                  await new Promise((done) => setTimeout(done, 200));
                  if (position >= bytes.length) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(bytes.slice(position, position + 32768));
                  position += 32768;
                },
              }),
            );
          }
          return new Response(bytes);
        }
        throw Error('Unexpected smoke request');
      };
      _electron.net.fetch = globalThis.fetch;
    },
    { manifest, metadata, files },
  );
  const page = await desktop.firstWindow();
  const capture = async (options) => {
    await page.evaluate(async () => {
      document.querySelector('.workspace')?.scrollTo(0, 0);
      for (let pass = 0; pass < 3; pass++) {
        await new Promise(requestAnimationFrame);
        await Promise.allSettled(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished),
        );
      }
    });
    await page.screenshot(options);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '下一段冒险，从这里开始。' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '启动', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '最小化', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '最大化', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '最大化', exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => (await window.launcher.windowState()).value.maximized))
    .toBe(true);
  await expect(page.getByRole('button', { name: '还原', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '还原', exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => (await window.launcher.windowState()).value.maximized))
    .toBe(false);
  await expect(page.getByRole('button', { name: '最大化', exact: true })).toBeVisible();
  await capture({ path: join(artifacts, 'home-empty.png') });
  await page.getByRole('button', { name: '版本选择', exact: true }).click();
  await expect(page.getByRole('heading', { name: '版本选择', exact: true })).toBeVisible();
  await expect(page.getByText('这里还没有游戏实例')).toBeVisible();
  const isolation = await page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
    methods: Object.keys(window.launcher),
  }));
  expect(isolation.node).toBe('undefined');
  expect(isolation.process).toBe('undefined');
  expect(isolation.methods.sort()).toEqual(
    [
      'accounts',
      'microsoftConfiguration',
      'configureMicrosoft',
      'startMicrosoftLogin',
      'microsoftLoginStatus',
      'cancelMicrosoftLogin',
      'openMicrosoftLogin',
      'copyMicrosoftCode',
      'openMicrosoftHelp',
      'activity',
      'cancelTask',
      'catalog',
      'checkLaunch',
      'componentCatalog',
      'configureComponents',
      'createInstance',
      'createAccount',
      'deleteAccount',
      'environment',
      'install',
      'launchOffline',
      'launchAccount',
      'listInstances',
      'openGameDirectory',
      'stopSession',
      'selectAccount',
      'updateAccount',
      'updateInstance',
      'onWindowStateChange',
      'windowClose',
      'windowMinimize',
      'windowState',
      'windowToggleMaximize',
    ].sort(),
  );
  const invalid = await page.evaluate(() =>
    window.launcher.createInstance({ name: 'invalid', versionId: '../file' }),
  );
  expect(invalid.ok).toBe(false);
  expect(invalid.error.code).toBe('INVALID_INPUT');
  const invalidMicrosoft = await page.evaluate(() =>
    window.launcher.configureMicrosoft({
      clientId: 'a175e2a4-8808-4444-aaaa-0123456789ab',
      clientSecret: 'not-accepted',
    }),
  );
  expect(invalidMicrosoft.ok).toBe(false);
  expect(invalidMicrosoft.error.code).toBe('INVALID_INPUT');
  const windows = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.getLastWebPreferences()),
  );
  expect(windows[0].sandbox).toBe(true);
  expect(windows[0].contextIsolation).toBe(true);
  expect(windows[0].nodeIntegration).toBe(false);
  await capture({ path: join(artifacts, 'library-empty.png') });
  await page.getByRole('button', { name: '创建第一个实例' }).click();
  expect(await page.getByRole('dialog').evaluate((dialog) => getComputedStyle(dialog).animationName)).toBe(
    'dialog-in',
  );
  await expect(page.getByRole('combobox', { name: 'Minecraft 版本' })).toBeEnabled();
  await page.getByLabel('实例名称').fill('我的生存世界');
  await page.getByRole('combobox', { name: 'Minecraft 版本' }).selectOption('1.21.1');
  await page.getByRole('dialog').getByRole('button', { name: '创建实例', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的生存世界' })).toBeVisible();
  await page.getByRole('button', { name: '组件安装', exact: true }).click();
  await expect(page.getByRole('heading', { name: '组件安装' })).toBeVisible();
  await page.getByRole('button', { name: 'Fabric', exact: true }).click();
  await page.getByRole('combobox', { name: '加载器版本', exact: true }).selectOption('0.16.0');
  await page.getByRole('combobox', { name: 'OptiFine 高清修复', exact: true }).selectOption('HD_U_J1');
  await expect(page.getByRole('button', { name: '保存并安装组件', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'OptiFabric 兼容组件', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'NeoForge', exact: true }).click();
  await page.getByRole('combobox', { name: '加载器版本', exact: true }).selectOption('21.1.42');
  await expect(page.getByRole('combobox', { name: 'OptiFine 高清修复', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Forge', exact: true }).click();
  await page.getByRole('combobox', { name: '加载器版本', exact: true }).selectOption('52.0.1');
  await page.getByRole('combobox', { name: 'OptiFine 高清修复', exact: true }).selectOption('HD_U_J1');
  await page.getByRole('button', { name: '保存选择', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存选择', exact: true })).toBeVisible();
  await capture({ path: join(artifacts, 'components.png'), fullPage: true });
  await page.getByRole('button', { name: '原版', exact: true }).click();
  await page.getByRole('button', { name: '保存选择', exact: true }).click();
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '账号管理' })).toBeVisible();
  await page.getByRole('button', { name: '添加第一个账号' }).click();
  await page.getByLabel('玩家名称').fill('bad name');
  await page.getByRole('button', { name: '保存账号', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('玩家名称').fill('Smoke_Player');
  await page.getByRole('button', { name: '保存账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Smoke_Player/ })).toBeVisible();
  await page.getByRole('button', { name: '添加离线账号', exact: true }).click();
  await page.getByLabel('玩家名称').fill('Second_Player');
  await page.getByRole('button', { name: '保存账号', exact: true }).click();
  await page.getByRole('button', { name: '使用此账号' }).click();
  await expect(page.getByRole('heading', { name: /Second_Player.*当前账号/ })).toBeVisible();
  await page.getByRole('button', { name: '编辑账号 Second_Player', exact: true }).click();
  await page.getByLabel('玩家名称').fill('Renamed_Player');
  await page.getByRole('button', { name: '保存账号', exact: true }).click();
  await capture({ path: join(artifacts, 'accounts.png') });
  await page.getByRole('button', { name: '删除账号 Renamed_Player', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Renamed_Player/ })).not.toBeVisible();
  await page.getByRole('button', { name: /^游戏库/ }).click();
  await page.getByRole('button', { name: '设置 我的生存世界', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实例设置' })).toBeVisible();
  await page.getByRole('button', { name: '手动分配', exact: true }).click();
  await page.getByRole('spinbutton', { name: '最大内存（MiB）', exact: true }).fill('3072');
  await page.getByRole('spinbutton', { name: '窗口宽度', exact: true }).fill('1280');
  await page.getByRole('spinbutton', { name: '窗口高度', exact: true }).fill('720');
  await page.getByRole('combobox', { name: '版本隔离', exact: true }).selectOption('auto');
  const selectedAccount = await page.evaluate(
    async () => (await window.launcher.accounts()).value.accounts[0].id,
  );
  await page.getByLabel('此实例使用的账号').selectOption(selectedAccount);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '版本隔离', exact: true })).toHaveValue('auto');
  await capture({ path: join(artifacts, 'instance-settings.png'), fullPage: true });
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click();
  await page.getByRole('button', { name: '检查 我的生存世界 的启动条件' }).click();
  await expect(page.getByRole('dialog', { name: '启动条件检查' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('推荐 Java', { exact: true })).toBeVisible();
  await capture({ path: join(artifacts, 'launch-check.png') });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '安装 我的生存世界', exact: true }).click();
  await expect(page.getByRole('region', { name: '下载进度', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText(/^已取消/)).toBeVisible();
  await desktop.evaluate(() => {
    globalThis.__hunaumclDelay = false;
  });
  await page.getByRole('button', { name: '版本选择', exact: true }).click();
  await page.getByRole('button', { name: '安装 我的生存世界', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.launcher.activity();
        return (
          result.ok &&
          result.value.tasks.some(
            (task) =>
              task.state === 'running' &&
              task.download?.transferredBytes > 0 &&
              task.download?.bytesPerSecond > 0 &&
              task.completed < task.total,
          )
        );
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole('region', { name: '下载进度', exact: true }).locator('.download-speed'),
  ).toHaveText(/(?:KiB|MiB)\/s/);
  await capture({ path: join(artifacts, 'download-progress.png') });
  await expect(page.getByRole('button', { name: '启动游戏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '启动游戏', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '离线启动' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '启动账号', exact: true })).toHaveValue(selectedAccount);
  await expect(page.getByRole('dialog', { name: '离线启动' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  const validation = await page.evaluate(() =>
    window.launcher.launchOffline({ instanceId: 'bad', playerName: 'bad' }),
  );
  expect(validation.ok).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的生存世界' })).toBeVisible();
  await expect(page.getByLabel('当前启动账号')).toHaveValue(selectedAccount);
  await capture({ path: join(artifacts, 'home.png') });
  // Device-code login through the real IPC and OS credential encryption, with isolated test services.
  const openAccounts = async () => {
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible();
  };
  await openAccounts();
  await page.getByRole('button', { name: 'Microsoft 登录设置', exact: true }).click();
  await page.getByLabel('应用程序（客户端）ID').fill('a175e2a4-8808-4444-aaaa-0123456789ab');
  await capture({ path: join(artifacts, 'microsoft-settings.png') });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '登录 Microsoft', exact: true }).click();
  await expect(page.locator('.device-code')).toHaveText('ABCD-EFGH');
  await capture({ path: join(artifacts, 'microsoft-device-code.png') });
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe('ABCD-EFGH');
  await page.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await desktop.evaluate(() => globalThis.__hunaumclOpenedURLs)).toContain(
    'https://www.microsoft.com/link',
  );
  await page.reload();
  await openAccounts();
  await expect(page.locator('.device-code')).toHaveText('ABCD-EFGH');
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Microsoft 登录', exact: true })).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(async () => (await window.launcher.microsoftLoginStatus()).value?.state))
    .toBe('cancelled');
  await desktop.evaluate(() => {
    globalThis.__hunaumclMsAuthorized = true;
  });
  await page.getByRole('button', { name: '登录 Microsoft', exact: true }).click();
  await expect(page.getByText('已登录 Online_Player', { exact: true })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Microsoft 登录', exact: true })
    .getByRole('button', { name: '完成', exact: true })
    .click();
  const online = await page.evaluate(async () => (await window.launcher.accounts()).value);
  expect(
    online.accounts.some((account) => account.kind === 'microsoft' && account.playerName === 'Online_Player'),
  ).toBe(true);
  expect(JSON.stringify(online)).not.toMatch(/private-test-|encryptedCredentials|refreshToken|accessToken/);
  const secureDisk = await readFile(join(data, 'accounts.json'), 'utf8');
  expect(secureDisk).toContain('encryptedCredentials');
  expect(secureDisk).not.toMatch(/private-test-/);
  await capture({ path: join(artifacts, 'accounts-microsoft.png') });
  // A rejected device-code request must reopen Microsoft settings with the AADSTS guidance only.
  await desktop.evaluate(() => {
    globalThis.__hunaumclMsDeviceError = true;
  });
  await page.getByRole('button', { name: '登录 Microsoft', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Microsoft 登录设置', exact: true })).toBeVisible();
  await expect(page.getByText(/AADSTS700016/)).toBeVisible();
  expect(await page.getByText(/private-test-trace/).count()).toBe(0);
  await capture({ path: join(artifacts, 'microsoft-config-error.png') });
  await page
    .getByRole('dialog', { name: 'Microsoft 登录设置', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .first()
    .click();
  await desktop.evaluate(() => {
    globalThis.__hunaumclMsDeviceError = false;
  });
  // A 403 with "Invalid app registration" must explain the API review requirement and offer its entry.
  await desktop.evaluate(() => {
    globalThis.__hunaumclMinecraftDenied = true;
  });
  await page.getByRole('button', { name: '登录 Microsoft', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Microsoft 登录', exact: true })).toBeVisible();
  await expect(page.getByText(/mce-reviewappid/)).toBeVisible();
  await capture({ path: join(artifacts, 'microsoft-api-denied.png') });
  await page.getByRole('dialog').getByRole('button', { name: '申请 API 准入', exact: true }).click();
  expect(await desktop.evaluate(() => globalThis.__hunaumclOpenedURLs)).toContain(
    'https://aka.ms/mce-reviewappid',
  );
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  await desktop.evaluate(() => {
    globalThis.__hunaumclMinecraftDenied = false;
  });
  await page.getByRole('button', { name: '返回启动', exact: true }).click();
  await expect(page.locator('.launch-identity > strong')).toHaveText('Online_Player');
  await expect(page.getByText('Microsoft 正版账号', { exact: true })).toBeVisible();
  await openAccounts();
  await page.getByRole('button', { name: '删除账号 Online_Player', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除账号 Online_Player', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '返回启动', exact: true }).click();
  await page.getByRole('button', { name: '版本选择', exact: true }).click();
  await page.getByRole('button', { name: '设置 我的生存世界', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '最大内存（MiB）', exact: true })).toHaveValue('3072');
  await expect(page.getByRole('spinbutton', { name: '窗口宽度', exact: true })).toHaveValue('1280');
  await expect(page.getByLabel('此实例使用的账号')).toHaveValue(selectedAccount);
  await expect(page.getByRole('combobox', { name: '版本隔离', exact: true })).toHaveValue('auto');
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索实例' }).fill('不存在');
  await expect(page.getByText('没有找到匹配的实例')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索实例' }).fill('');
  await capture({ path: join(artifacts, 'library.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await expect(page.getByRole('button', { name: '创建实例', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture({ path: join(artifacts, 'library-minimum.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820));
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '运行环境', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本机 Java' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新检测', exact: true })).toBeEnabled({ timeout: 20_000 });
  await capture({ path: join(artifacts, 'environment.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: /^游戏库/ }).click();
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  expect(await page.getByRole('dialog').evaluate((dialog) => getComputedStyle(dialog).animationName)).toBe(
    'none',
  );
  expect(
    await page.getByRole('dialog').evaluate((dialog) => getComputedStyle(dialog, '::backdrop').animationName),
  ).toBe('none');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  // Exercise the new full download page and a second selected instance, not just a changed label.
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '下载游戏', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Minecraft 版本' })).toBeEnabled();
  await page.getByLabel('实例名称', { exact: true }).fill('另一个方块世界');
  await expect(page.getByRole('button', { name: 'Fabric', exact: true })).toBeVisible();
  await capture({ path: join(artifacts, 'downloads.png') });
  await page.getByRole('button', { name: '创建并安装', exact: true }).click();
  await expect(page.getByRole('heading', { name: '另一个方块世界', exact: true })).toBeVisible();
  await expect(page.locator('.selected-version strong')).toHaveText('另一个方块世界');
  await page.reload();
  await expect(page.locator('.selected-version strong')).toHaveText('另一个方块世界');
  await page.getByRole('button', { name: '版本选择', exact: true }).click();
  await page.getByRole('button', { name: '选择实例 我的生存世界', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的生存世界', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.selected-version strong')).toHaveText('我的生存世界');
  await expect(page.getByRole('button', { name: /^启动游戏/ })).toBeEnabled();
  await page.getByRole('button', { name: /^启动游戏/ }).click();
  await expect(page.getByRole('dialog', { name: '离线启动' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '启动账号', exact: true })).toHaveValue(selectedAccount);
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '查看任务与日志', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务与日志', exact: true, level: 1 })).toBeVisible();
  await capture({ path: join(artifacts, 'tasks.png') });
  await page.getByRole('button', { name: '返回启动', exact: true }).click();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const launchButton = await page.locator('.launch-primary').boundingBox();
  expect(launchButton.y + launchButton.height).toBeLessThan(await page.evaluate(() => window.innerHeight));
  await capture({ path: join(artifacts, 'home-minimum.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820));
  await capture({ path: join(artifacts, 'home.png') });
  expect(errors).toEqual([]);
  const persisted = JSON.parse(await readFile(join(data, 'instances.json'), 'utf8'));
  expect(persisted.instances).toHaveLength(2);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        checks: [
          'renderer isolation',
          'IPC validation',
          'custom window controls and maximize state',
          'instance creation',
          'metadata preflight',
          'reload persistence',
          'install cancellation after reload',
          'verified installation and retry',
          'offline identity form validation',
          'account add/select/rename/delete',
          'instance settings persistence and account binding',
          'streaming bytes and speed before file completion',
          'dialog transitions and reduced motion',
          'loader and OptiFine compatibility selection',
          'isolation selection persistence',
          'search',
          'minimum window width',
          'Java page',
          'top tabs and contextual navigation',
          'full download page creates and installs',
          'selected instance persists and controls home launch',
          'home launch controls fit minimum height',
          'Microsoft client configuration and reload persistence',
          'AADSTS registration guidance opens settings without leaking the raw response',
          'Minecraft API denial explains the review requirement and opens its entry',
          'device code, clipboard, browser link and cancellation',
          'Xbox / Minecraft authorization and account selection',
          'OS-encrypted credentials and token-free IPC',
        ],
        screenshots: artifacts,
      },
      null,
      2,
    ),
  );
} finally {
  await desktop?.close();
  const child = relative(tmpdir(), data);
  if (!child.startsWith('hunaumcl-smoke-') || isAbsolute(child) || child.includes('..'))
    throw new Error('Unsafe smoke cleanup path');
  await rm(data, { recursive: true, force: true });
}
