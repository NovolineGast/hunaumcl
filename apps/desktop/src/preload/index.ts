import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { channels } from '@hunaumcl/contracts/channels';
import type { LauncherAPI, WindowState } from '@hunaumcl/contracts';

const api: LauncherAPI = Object.freeze<LauncherAPI>({
  microsoftConfiguration: () => ipcRenderer.invoke(channels.microsoftConfiguration),
  configureMicrosoft: (request) => ipcRenderer.invoke(channels.configureMicrosoft, request),
  startMicrosoftLogin: (request) => ipcRenderer.invoke(channels.startMicrosoftLogin, request),
  microsoftLoginStatus: () => ipcRenderer.invoke(channels.microsoftLoginStatus),
  cancelMicrosoftLogin: (id) => ipcRenderer.invoke(channels.cancelMicrosoftLogin, id),
  openMicrosoftLogin: (id) => ipcRenderer.invoke(channels.openMicrosoftLogin, id),
  copyMicrosoftCode: (id) => ipcRenderer.invoke(channels.copyMicrosoftCode, id),
  openMicrosoftHelp: (kind) => ipcRenderer.invoke(channels.openMicrosoftHelp, kind),
  componentCatalog: (id) => ipcRenderer.invoke(channels.componentCatalog, id),
  configureComponents: (request) => ipcRenderer.invoke(channels.configureComponents, request),
  openGameDirectory: (id) => ipcRenderer.invoke(channels.openGameDirectory, id),
  accounts: () => ipcRenderer.invoke(channels.accounts),
  createAccount: (request) => ipcRenderer.invoke(channels.createAccount, request),
  updateAccount: (request) => ipcRenderer.invoke(channels.updateAccount, request),
  selectAccount: (id) => ipcRenderer.invoke(channels.selectAccount, id),
  deleteAccount: (id) => ipcRenderer.invoke(channels.deleteAccount, id),
  updateInstance: (request) => ipcRenderer.invoke(channels.updateInstance, request),
  launchAccount: (request) => ipcRenderer.invoke(channels.launchAccount, request),
  listInstances: () => ipcRenderer.invoke(channels.listInstances),
  createInstance: (request) => ipcRenderer.invoke(channels.createInstance, request),
  catalog: () => ipcRenderer.invoke(channels.catalog),
  environment: () => ipcRenderer.invoke(channels.environment),
  checkLaunch: (instanceId) => ipcRenderer.invoke(channels.checkLaunch, instanceId),
  install: (instanceId) => ipcRenderer.invoke(channels.install, instanceId),
  launchOffline: (request) => ipcRenderer.invoke(channels.launchOffline, request),
  activity: () => ipcRenderer.invoke(channels.activity),
  cancelTask: (taskId) => ipcRenderer.invoke(channels.cancelTask, taskId),
  stopSession: (sessionId) => ipcRenderer.invoke(channels.stopSession, sessionId),
  windowMinimize: () => ipcRenderer.invoke(channels.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.invoke(channels.windowToggleMaximize),
  windowClose: () => ipcRenderer.invoke(channels.windowClose),
  windowState: () => ipcRenderer.invoke(channels.windowState),
  onWindowStateChange: (listener) => {
    const handler = (_event: IpcRendererEvent, state: WindowState) => listener(state);
    ipcRenderer.on(channels.windowStateChanged, handler);
    return () => ipcRenderer.removeListener(channels.windowStateChanged, handler);
  },
});
contextBridge.exposeInMainWorld('launcher', api);
