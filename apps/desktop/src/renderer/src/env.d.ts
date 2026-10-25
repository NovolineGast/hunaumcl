import type { LauncherAPI } from '@hunaumcl/contracts';
declare global {
  interface Window {
    readonly launcher: LauncherAPI;
  }
}
