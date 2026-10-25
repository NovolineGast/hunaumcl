import { z } from 'zod';

export const componentsSchema = z
  .object({
    loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']),
    loaderVersion: z
      .string()
      .regex(/^[A-Za-z0-9._+\-]{1,100}$/)
      .nullable(),
    optifine: z
      .string()
      .regex(/^[A-Za-z0-9._+\-]{1,100}$/)
      .nullable(),
    fabricApi: z
      .string()
      .regex(/^[A-Za-z0-9]{1,80}$/)
      .nullable(),
    optifabric: z
      .string()
      .regex(/^[A-Za-z0-9]{1,80}$/)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.loader === 'vanilla') !== (value.loaderVersion === null))
      context.addIssue({ code: 'custom', message: '请选择加载器的具体版本' });
    if (value.loader === 'neoforge' && value.optifine)
      context.addIssue({ code: 'custom', message: 'NeoForge 不能与 OptiFine 组合安装' });
    if (value.loader !== 'fabric' && (value.fabricApi || value.optifabric))
      context.addIssue({ code: 'custom', message: 'Fabric API / OptiFabric 需要 Fabric Loader' });
    if (value.loader === 'fabric' && value.optifine && !value.optifabric)
      context.addIssue({ code: 'custom', message: 'Fabric 与 OptiFine 组合需要匹配的 OptiFabric' });
    if (value.optifabric && !value.optifine)
      context.addIssue({ code: 'custom', message: 'OptiFabric 需要同时选择 OptiFine' });
  });
export type InstanceComponents = z.infer<typeof componentsSchema>;
/** Compatibility policy is separate from persistence validation so old records remain readable. */
export function componentCompatibilityError(
  minecraft: string,
  components: InstanceComponents,
): string | undefined {
  if (
    minecraft === '1.20.1' &&
    components.loader === 'fabric' &&
    components.loaderVersion === '0.19.5' &&
    components.optifine === 'HD_U_I6' &&
    components.optifabric === 'cf5025647'
  )
    return 'OptiFabric 1.14.3 + OptiFine I6 与 Fabric 0.19.5 存在重映射兼容问题，请选择已验证的 Fabric 0.15.11。';
  return undefined;
}
export const vanillaComponents: InstanceComponents = {
  loader: 'vanilla',
  loaderVersion: null,
  optifine: null,
  fabricApi: null,
  optifabric: null,
};

export const createInstanceSchema = z
  .object({
    name: z.string().trim().min(1, '请输入实例名称').max(60, '实例名称最多 60 个字符'),
    versionId: z.string().regex(/^[a-zA-Z0-9._+\-]{1,80}$/, '无效的游戏版本'),
    components: componentsSchema.optional(),
  })
  .strict();
export const instanceIdSchema = z.string().uuid();
export const playerNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,16}$/, '离线名称需为 3–16 位字母、数字或下划线');
export const accountInputSchema = z.object({ playerName: playerNameSchema }).strict();
export const updateAccountSchema = accountInputSchema.extend({ id: instanceIdSchema }).strict();
export const launchSettingsSchema = z
  .object({
    memoryMode: z.enum(['auto', 'custom']),
    memoryMiB: z.number().int().min(512, '内存至少为 512 MiB').max(65536, '内存最多为 65536 MiB'),
    javaId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    accountId: instanceIdSchema.nullable(),
    width: z.number().int().min(320).max(7680),
    height: z.number().int().min(240).max(4320),
    fullscreen: z.boolean(),
    isolation: z.enum(['isolated', 'shared', 'auto']).default('isolated'),
  })
  .strict();
export const updateInstanceSchema = z
  .object({
    instanceId: instanceIdSchema,
    name: createInstanceSchema.shape.name,
    settings: launchSettingsSchema,
  })
  .strict();
export const launchAccountSchema = z
  .object({ instanceId: instanceIdSchema, accountId: instanceIdSchema.optional() })
  .strict();
export const configureComponentsSchema = z
  .object({ instanceId: instanceIdSchema, components: componentsSchema })
  .strict();
export type InstanceLaunchSettings = z.infer<typeof launchSettingsSchema>;
export type UpdateInstanceRequest = z.infer<typeof updateInstanceSchema>;
export type LaunchAccountRequest = z.infer<typeof launchAccountSchema>;
export const defaultLaunchSettings: InstanceLaunchSettings = {
  memoryMode: 'auto',
  memoryMiB: 2048,
  javaId: null,
  accountId: null,
  width: 960,
  height: 540,
  fullscreen: false,
  isolation: 'isolated',
};
export interface OfflineAccount {
  id: string;
  playerName: string;
  uuid: string;
  kind: 'offline';
  createdAt: string;
}
export interface MicrosoftAccount {
  id: string;
  playerName: string;
  uuid: string;
  kind: 'microsoft';
  createdAt: string;
  expiresAt: string;
  lastValidatedAt: string;
  needsReauthentication: boolean;
}
export type SavedAccount = OfflineAccount | MicrosoftAccount;
export interface AccountCollection {
  accounts: SavedAccount[];
  selectedId: string | null;
}
export const microsoftConfigSchema = z
  .object({ clientId: z.string().uuid('请输入有效的应用程序（客户端）ID') })
  .strict();
export const microsoftLoginSchema = z.object({ accountId: instanceIdSchema.optional() }).strict();
export interface MicrosoftConfiguration {
  clientId: string;
  source: 'environment' | 'local' | 'unconfigured';
  secureStorageAvailable: boolean;
}
export interface MicrosoftLoginSnapshot {
  id: string;
  state:
    | 'requesting'
    | 'awaiting-authorization'
    | 'authenticating'
    | 'saving'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired';
  stage: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
  accountId?: string;
  error?: { code: string; message: string };
}
export const emptyRequestSchema = z.undefined();
export const launchOfflineSchema = z
  .object({
    instanceId: instanceIdSchema,
    playerName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{3,16}$/, '离线名称需为 3–16 位字母、数字或下划线'),
  })
  .strict();
export type LaunchOfflineRequest = z.infer<typeof launchOfflineSchema>;
export type CreateInstanceRequest = z.infer<typeof createInstanceSchema>;

export interface InstanceSummary {
  id: string;
  name: string;
  versionId: string;
  loader: InstanceComponents['loader'];
  components?: InstanceComponents;
  installedComponents?: InstanceComponents;
  createdAt: string;
  installed?: boolean;
  settings?: InstanceLaunchSettings;
}

export interface VersionCatalog {
  latestRelease: string;
  releases: { id: string; releaseTime: string }[];
  cached: boolean;
}

export interface JavaSummary {
  id: string;
  version: string;
  major: number;
  architecture: string;
  vendor: string;
}

export interface EnvironmentSummary {
  os: 'windows' | 'linux' | 'osx';
  architecture: string;
  appVersion: string;
  java: JavaSummary[];
}

/** Safe preflight summary; no executable paths, arguments or credentials cross IPC. */
export interface LaunchCheck {
  instanceId: string;
  versionId: string;
  recommendedJavaMajor: number | null;
  selectedJava: JavaSummary | null;
  libraryCount: number;
  status: 'compatible-java-found' | 'java-required' | 'unsupported-metadata';
  notices: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface WindowState {
  maximized: boolean;
}

export { channels } from './channels';

export interface LauncherAPI {
  microsoftConfiguration(): Promise<Result<MicrosoftConfiguration>>;
  configureMicrosoft(request: { clientId: string }): Promise<Result<MicrosoftConfiguration>>;
  startMicrosoftLogin(request: { accountId?: string }): Promise<Result<MicrosoftLoginSnapshot>>;
  microsoftLoginStatus(): Promise<Result<MicrosoftLoginSnapshot | null>>;
  cancelMicrosoftLogin(id: string): Promise<Result<void>>;
  openMicrosoftLogin(id: string): Promise<Result<void>>;
  copyMicrosoftCode(id: string): Promise<Result<void>>;
  openMicrosoftHelp(kind: 'registration' | 'api-access'): Promise<Result<void>>;
  componentCatalog(versionId: string): Promise<Result<ComponentCatalog>>;
  configureComponents(request: {
    instanceId: string;
    components: InstanceComponents;
  }): Promise<Result<InstanceSummary>>;
  openGameDirectory(instanceId: string): Promise<Result<void>>;
  accounts(): Promise<Result<AccountCollection>>;
  createAccount(request: { playerName: string }): Promise<Result<AccountCollection>>;
  updateAccount(request: { id: string; playerName: string }): Promise<Result<AccountCollection>>;
  selectAccount(id: string): Promise<Result<AccountCollection>>;
  deleteAccount(id: string): Promise<Result<AccountCollection>>;
  updateInstance(request: UpdateInstanceRequest): Promise<Result<InstanceSummary>>;
  launchAccount(request: LaunchAccountRequest): Promise<Result<{ taskId: string }>>;
  listInstances(): Promise<Result<InstanceSummary[]>>;
  createInstance(request: CreateInstanceRequest): Promise<Result<InstanceSummary>>;
  catalog(): Promise<Result<VersionCatalog>>;
  environment(): Promise<Result<EnvironmentSummary>>;
  checkLaunch(instanceId: string): Promise<Result<LaunchCheck>>;
  install(instanceId: string): Promise<Result<{ taskId: string }>>;
  launchOffline(request: LaunchOfflineRequest): Promise<Result<{ taskId: string }>>;
  activity(): Promise<Result<ActivitySnapshot>>;
  cancelTask(taskId: string): Promise<Result<void>>;
  stopSession(sessionId: string): Promise<Result<void>>;
  windowMinimize(): Promise<Result<void>>;
  windowToggleMaximize(): Promise<Result<WindowState>>;
  windowClose(): Promise<Result<void>>;
  windowState(): Promise<Result<WindowState>>;
  onWindowStateChange(listener: (state: WindowState) => void): () => void;
}
export interface ComponentVersion {
  id: string;
  label: string;
  recommended?: boolean;
  preview?: boolean;
  requiredForge?: string | null;
}
export interface ComponentCatalog {
  minecraft: string;
  fabric: ComponentVersion[];
  forge: ComponentVersion[];
  neoforge: ComponentVersion[];
  optifine: ComponentVersion[];
  fabricApi: ComponentVersion[];
  optifabric: ComponentVersion[];
  errors: string[];
}

export interface TaskSnapshot {
  id: string;
  instanceId: string;
  kind: 'install' | 'launch';
  state: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  stage: string;
  completed: number;
  total: number;
  error?: { code: string; message: string };
  startedAt: string;
  progress?: number;
  download?: DownloadProgress;
}
export interface DownloadProgress {
  totalBytes: number;
  completedBytes: number;
  transferredBytes: number;
  cachedBytes: number;
  bytesPerSecond: number;
  activeConnections: number;
  etaSeconds: number | null;
  currentFile: string | null;
}
export interface SessionSnapshot {
  id: string;
  instanceId: string;
  playerName: string;
  identity: 'offline' | 'microsoft';
  state: 'running' | 'stopping' | 'exited' | 'failed';
  exitCode: number | null;
  startedAt: string;
  logs: { sequence: number; text: string; stream: 'stdout' | 'stderr' | 'launcher' }[];
}
export interface ActivitySnapshot {
  tasks: TaskSnapshot[];
  sessions: SessionSnapshot[];
}
