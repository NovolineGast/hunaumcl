import type {
  CreateInstanceRequest,
  EnvironmentSummary,
  InstanceSummary,
  JavaSummary,
  LaunchCheck,
  VersionCatalog,
} from '@hunaumcl/contracts';
import type { ComponentCatalog, InstanceComponents } from '@hunaumcl/contracts';
import type { LaunchOfflineRequest, ActivitySnapshot } from '@hunaumcl/contracts';
import { defaultLaunchSettings } from '@hunaumcl/contracts';
import type {
  AccountCollection,
  DownloadProgress,
  LaunchAccountRequest,
  UpdateInstanceRequest,
} from '@hunaumcl/contracts';
import { evaluateRules, nativeLibraryArchitecture, selectJava, toJavaArchitecture } from '@hunaumcl/domain';
import type { RuleEnvironment, VersionMetadata } from '@hunaumcl/domain';

export class LauncherError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LauncherError';
  }
}
export interface InstanceRepository {
  list(): Promise<InstanceSummary[]>;
  create(request: CreateInstanceRequest): Promise<InstanceSummary>;
  update?(request: UpdateInstanceRequest): Promise<InstanceSummary>;
  configure?(id: string, components: InstanceComponents): Promise<InstanceSummary>;
}
export interface ComponentProvider {
  catalog(version: string): Promise<ComponentCatalog>;
  validate(version: string, components: InstanceComponents): Promise<void>;
}
export interface AccountRepository {
  list(): Promise<AccountCollection>;
  create(playerName: string): Promise<AccountCollection>;
  update(id: string, playerName: string): Promise<AccountCollection>;
  select(id: string): Promise<AccountCollection>;
  delete(id: string): Promise<AccountCollection>;
}
export interface VersionProvider {
  catalog(): Promise<VersionCatalog>;
  metadata(id: string): Promise<VersionMetadata>;
}
export interface JavaProvider {
  scan(): Promise<JavaSummary[]>;
}
export interface RuntimeProgress {
  stage: string;
  completed: number;
  total: number;
  progress?: number;
  download?: DownloadProgress;
}
export interface GameSession {
  stop(): Promise<void>;
  onLog(listener: (text: string, stream: 'stdout' | 'stderr' | 'launcher') => void): void;
  onExit(listener: (code: number | null) => void): void;
}
/** Main-process-only launch identity. This type never crosses the renderer IPC boundary. */
export interface GameIdentity {
  kind: 'microsoft';
  playerName: string;
  uuid: string;
  accessToken: string;
  xuid: string;
  clientId: string;
}
export interface IdentityProvider {
  resolve(
    accountId: string,
    signal: AbortSignal,
    report: (progress: RuntimeProgress) => void,
  ): Promise<GameIdentity>;
}
export interface GameRuntime {
  installedComponents?(instance: InstanceSummary): Promise<InstanceComponents | undefined>;
  isInstalled(instance: InstanceSummary): Promise<boolean>;
  install(
    instance: InstanceSummary,
    report: (progress: RuntimeProgress) => void,
    signal: AbortSignal,
  ): Promise<void>;
  launch(
    instance: InstanceSummary,
    playerName: string,
    report: (progress: RuntimeProgress) => void,
    signal: AbortSignal,
    identity?: GameIdentity,
  ): Promise<GameSession>;
}
export interface ActivityService {
  snapshot(): ActivitySnapshot;
  start(
    kind: 'install' | 'launch',
    instance: InstanceSummary,
    playerName?: string,
    microsoftAccountId?: string,
  ): { taskId: string };
  cancel(id: string): void;
  stop(id: string): Promise<void>;
  shutdown(): Promise<void>;
}
export interface ApplicationEnvironment {
  os: EnvironmentSummary['os'];
  osVersion: string;
  architecture: string;
  appVersion: string;
}

export class LauncherService {
  constructor(
    private readonly instances: InstanceRepository,
    private readonly versions: VersionProvider,
    private readonly java: JavaProvider,
    private readonly host: ApplicationEnvironment,
    private readonly runtime?: GameRuntime,
    private readonly activityService?: ActivityService,
    private readonly accountRepository?: AccountRepository,
    private readonly components?: ComponentProvider,
  ) {}
  async componentCatalog(id: string): Promise<ComponentCatalog> {
    if (!this.components) throw new LauncherError('UNAVAILABLE', '组件目录尚未初始化');
    return this.components.catalog(id);
  }
  private assertIdle(id: string): void {
    const activity = this.activityService?.snapshot();
    if (
      activity?.tasks.some(
        (task) => task.instanceId === id && ['running', 'cancelling'].includes(task.state),
      ) ||
      activity?.sessions.some(
        (session) => session.instanceId === id && ['running', 'stopping'].includes(session.state),
      )
    )
      throw new LauncherError('INSTANCE_BUSY', '请先结束这个实例的任务和游戏，再修改组件或隔离方式');
  }
  async configureComponents(request: {
    instanceId: string;
    components: InstanceComponents;
  }): Promise<InstanceSummary> {
    this.assertIdle(request.instanceId);
    const instance = await this.instance(request.instanceId);
    if (!this.components || !this.instances.configure)
      throw new LauncherError('UNAVAILABLE', '组件服务尚未初始化');
    await this.components.validate(instance.versionId, request.components);
    this.assertIdle(request.instanceId);
    return this.instances.configure(request.instanceId, request.components);
  }
  private accountStore(): AccountRepository {
    if (!this.accountRepository) throw new LauncherError('ACCOUNTS_UNAVAILABLE', '账号服务尚未初始化');
    return this.accountRepository;
  }
  accounts(): Promise<AccountCollection> {
    return this.accountStore().list();
  }
  createAccount(request: { playerName: string }): Promise<AccountCollection> {
    return this.accountStore().create(request.playerName);
  }
  updateAccount(request: { id: string; playerName: string }): Promise<AccountCollection> {
    return this.accountStore().update(request.id, request.playerName);
  }
  selectAccount(id: string): Promise<AccountCollection> {
    return this.accountStore().select(id);
  }
  deleteAccount(id: string): Promise<AccountCollection> {
    return this.accountStore().delete(id);
  }
  async updateInstance(request: UpdateInstanceRequest): Promise<InstanceSummary> {
    const previous = await this.instance(request.instanceId);
    if (previous.settings?.isolation !== request.settings.isolation) this.assertIdle(request.instanceId);
    if (!this.instances.update) throw new LauncherError('SETTINGS_UNAVAILABLE', '实例设置暂不可用');
    if (
      request.settings.accountId &&
      !(await this.accounts()).accounts.some((account) => account.id === request.settings.accountId)
    )
      throw new LauncherError('ACCOUNT_NOT_FOUND', '选择的账号已不存在，请重新选择');
    if (
      request.settings.javaId &&
      !(await this.java.scan()).some((java) => java.id === request.settings.javaId)
    )
      throw new LauncherError('JAVA_NOT_FOUND', '选择的 Java 已不存在，请重新检测');
    return this.instances.update(request);
  }
  async launchAccount(request: LaunchAccountRequest): Promise<{ taskId: string }> {
    if (!this.activityService) throw new LauncherError('UNAVAILABLE', '启动服务尚未初始化');
    const instance = await this.instance(request.instanceId);
    const collection = await this.accounts();
    const id = request.accountId ?? instance.settings?.accountId ?? collection.selectedId;
    const account = collection.accounts.find((candidate) => candidate.id === id);
    if (!account)
      throw new LauncherError(
        'ACCOUNT_REQUIRED',
        '请先添加账号；实例绑定的账号若已删除，请在实例设置中重新选择',
      );
    return this.activityService.start(
      'launch',
      instance,
      account.playerName,
      account.kind === 'microsoft' ? account.id : undefined,
    );
  }
  async listInstances(): Promise<InstanceSummary[]> {
    const instances = await this.instances.list();
    if (!this.runtime) return instances;
    return Promise.all(
      instances.map(async (instance) => ({
        ...instance,
        installed: await this.runtime!.isInstalled(instance),
        installedComponents: await this.runtime!.installedComponents?.(instance),
      })),
    );
  }
  private async instance(id: string): Promise<InstanceSummary> {
    const instance = (await this.instances.list()).find((candidate) => candidate.id === id);
    if (!instance) throw new LauncherError('INSTANCE_NOT_FOUND', '未找到这个实例，请刷新游戏库');
    return instance;
  }
  async install(id: string): Promise<{ taskId: string }> {
    if (!this.activityService) throw new LauncherError('UNAVAILABLE', '安装服务尚未初始化');
    return this.activityService.start('install', await this.instance(id));
  }
  async launchOffline(request: LaunchOfflineRequest): Promise<{ taskId: string }> {
    if (!this.activityService) throw new LauncherError('UNAVAILABLE', '启动服务尚未初始化');
    return this.activityService.start('launch', await this.instance(request.instanceId), request.playerName);
  }
  async activity(): Promise<ActivitySnapshot> {
    return this.activityService?.snapshot() ?? { tasks: [], sessions: [] };
  }
  async cancelTask(id: string): Promise<void> {
    this.activityService?.cancel(id);
  }
  async stopSession(id: string): Promise<void> {
    await this.activityService?.stop(id);
  }
  catalog(): Promise<VersionCatalog> {
    return this.versions.catalog();
  }
  async createInstance(request: CreateInstanceRequest): Promise<InstanceSummary> {
    const catalog = await this.versions.catalog();
    if (!catalog.releases.some((version) => version.id === request.versionId))
      throw new LauncherError('VERSION_UNAVAILABLE', '请选择版本列表中的正式版本');
    if (request.components) {
      if (!this.components && request.components.loader !== 'vanilla')
        throw new LauncherError('UNAVAILABLE', '组件目录尚未初始化');
      await this.components?.validate(request.versionId, request.components);
    }
    return this.instances.create(request);
  }
  async environment(): Promise<EnvironmentSummary> {
    return {
      os: this.host.os,
      architecture: this.host.architecture,
      appVersion: this.host.appVersion,
      java: await this.java.scan(),
    };
  }
  async checkLaunch(id: string): Promise<LaunchCheck> {
    const instance = (await this.instances.list()).find((candidate) => candidate.id === id);
    if (!instance) throw new LauncherError('INSTANCE_NOT_FOUND', '未找到这个实例，请刷新游戏库');
    const [version, candidates] = await Promise.all([
      this.versions.metadata(instance.versionId),
      this.java.scan(),
    ]);
    const major = version.javaVersion?.majorVersion ?? null;
    if (version.inheritsFrom || major === null) {
      return {
        instanceId: id,
        versionId: version.id,
        recommendedJavaMajor: major,
        selectedJava: null,
        libraryCount: 0,
        status: 'unsupported-metadata',
        notices: ['这个版本暂时无法自动检查，可以直接尝试启动。'],
      };
    }
    const settings = instance.settings ?? defaultLaunchSettings;
    const selected =
      (settings.javaId
        ? candidates.find(
            (java) =>
              java.id === settings.javaId &&
              java.major === major &&
              java.architecture === this.host.architecture,
          )
        : selectJava(candidates, major, this.host.architecture)) ?? null;
    const env: RuleEnvironment = {
      os: this.host.os,
      osVersion: this.host.osVersion,
      architecture: toJavaArchitecture(selected?.architecture ?? this.host.architecture),
      features: {},
    };
    return {
      instanceId: id,
      versionId: version.id,
      recommendedJavaMajor: major,
      selectedJava: selected,
      libraryCount: version.libraries.filter(
        (library) =>
          evaluateRules(library.rules, env) &&
          (!nativeLibraryArchitecture(library.name) ||
            nativeLibraryArchitecture(library.name) === this.host.architecture),
      ).length,
      status: selected ? 'compatible-java-found' : 'java-required',
      notices: [
        selected
          ? `已找到与此版本匹配的 Java ${major}。`
          : `请安装适用于本机的 Java ${major}，然后重新检测。`,
        '离线身份仅用于本地游戏；Microsoft 账号启动前会验证游戏许可。',
      ],
    };
  }
}
