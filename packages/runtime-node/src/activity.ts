import { randomUUID } from 'node:crypto';
import { LauncherError } from '@hunaumcl/application';
import type {
  ActivityService,
  GameRuntime,
  GameSession,
  RuntimeProgress,
  IdentityProvider,
} from '@hunaumcl/application';
import type { ActivitySnapshot, InstanceSummary, SessionSnapshot, TaskSnapshot } from '@hunaumcl/contracts';

export function redactLog(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]')
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|authorization|password)\b[\s"':=]+)([^\s,}"]+)/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:token|access_token|refresh_token|password)=)[^&\s]+/gi, '$1[redacted]');
}

export class ActivityManager implements ActivityService {
  private readonly tasks = new Map<
    string,
    { snapshot: TaskSnapshot; controller: AbortController; done: Promise<void> }
  >();
  private readonly sessions = new Map<string, { snapshot: SessionSnapshot; handle: GameSession }>();
  private closed = false;
  constructor(
    private readonly runtime: GameRuntime,
    private readonly identities?: IdentityProvider,
  ) {}
  snapshot(): ActivitySnapshot {
    return structuredClone({
      tasks: [...this.tasks.values()].map((task) => task.snapshot),
      sessions: [...this.sessions.values()].map((session) => session.snapshot),
    });
  }
  start(
    kind: 'install' | 'launch',
    instance: InstanceSummary,
    playerName?: string,
    microsoftAccountId?: string,
  ): { taskId: string } {
    if (this.closed) throw new LauncherError('SHUTTING_DOWN', '启动器正在退出');
    if (kind === 'launch' && (!playerName || !/^[A-Za-z0-9_]{3,16}$/.test(playerName)))
      throw new LauncherError('INVALID_OFFLINE_NAME', '离线名称需为 3–16 位字母、数字或下划线');
    if (
      [...this.tasks.values()].some(
        (task) => task.snapshot.state === 'running' || task.snapshot.state === 'cancelling',
      )
    )
      throw new LauncherError('TASK_BUSY', '请先等待或取消当前安装/启动任务');
    if (
      [...this.sessions.values()].some(
        (session) =>
          session.snapshot.instanceId === instance.id &&
          ['running', 'stopping'].includes(session.snapshot.state),
      )
    )
      throw new LauncherError('INSTANCE_RUNNING', '这个实例已在运行，请先结束游戏');
    for (const [id, task] of this.tasks)
      if (this.tasks.size >= 30 && !['running', 'cancelling'].includes(task.snapshot.state))
        this.tasks.delete(id);
    const controller = new AbortController();
    const taskId = randomUUID();
    const snapshot: TaskSnapshot = {
      id: taskId,
      instanceId: instance.id,
      kind,
      state: 'running',
      stage: '准备任务',
      completed: 0,
      total: 0,
      startedAt: new Date().toISOString(),
    };
    const report = (progress: RuntimeProgress) =>
      Object.assign(snapshot, { download: undefined, ...progress });
    const entry = { snapshot, controller, done: Promise.resolve() };
    this.tasks.set(taskId, entry);
    entry.done = (async () => {
      try {
        if (kind === 'install') await this.runtime.install(instance, report, controller.signal);
        else {
          if (microsoftAccountId && !this.identities)
            throw new LauncherError('MICROSOFT_UNAVAILABLE', '微软登录服务尚未初始化');
          const identity = microsoftAccountId
            ? await this.identities!.resolve(microsoftAccountId, controller.signal, report)
            : undefined;
          controller.signal.throwIfAborted();
          const handle = await this.runtime.launch(
            instance,
            identity?.playerName ?? playerName!,
            report,
            controller.signal,
            identity,
          );
          // Always register the spawned process, even if cancellation won the last await race.
          const id = randomUUID();
          const session: SessionSnapshot = {
            id,
            instanceId: instance.id,
            playerName: identity?.playerName ?? playerName!,
            identity: identity?.kind ?? 'offline',
            state: 'running',
            exitCode: null,
            startedAt: new Date().toISOString(),
            logs: [],
          };
          const record = { snapshot: session, handle };
          this.sessions.set(id, record);
          let sequence = 0;
          let logBytes = 0;
          handle.onLog((text, stream) => {
            const safe = redactLog(text).slice(0, 2000);
            session.logs.push({ sequence: ++sequence, text: safe, stream });
            logBytes += safe.length;
            while (session.logs.length > 400 || logBytes > 64_000)
              logBytes -= session.logs.shift()!.text.length;
          });
          handle.onExit((code) => {
            session.exitCode = code;
            session.state = session.state === 'stopping' || code === 0 ? 'exited' : 'failed';
          });
          for (const [key, previous] of this.sessions)
            if (this.sessions.size > 8 && ['exited', 'failed'].includes(previous.snapshot.state))
              this.sessions.delete(key);
          if (controller.signal.aborted) {
            session.state = 'stopping';
            await handle.stop();
          }
        }
        snapshot.state = controller.signal.aborted ? 'cancelled' : 'succeeded';
        if (snapshot.state === 'succeeded') snapshot.progress = 1;
        if (snapshot.download) {
          snapshot.download.bytesPerSecond = 0;
          snapshot.download.activeConnections = 0;
          snapshot.download.etaSeconds = null;
        }
        snapshot.stage =
          snapshot.state === 'cancelled' ? '已取消' : kind === 'install' ? '安装完成' : '游戏进程已启动';
      } catch (error) {
        if (snapshot.download) {
          snapshot.download.bytesPerSecond = 0;
          snapshot.download.activeConnections = 0;
          snapshot.download.etaSeconds = null;
        }
        snapshot.state = controller.signal.aborted ? 'cancelled' : 'failed';
        snapshot.stage = snapshot.state === 'cancelled' ? '已取消' : '任务失败';
        if (!controller.signal.aborted)
          snapshot.error =
            error instanceof LauncherError
              ? { code: error.code, message: error.message }
              : { code: 'TASK_FAILED', message: '任务未完成，请检查网络、Java 与磁盘空间后重试' };
      }
    })();
    return { taskId };
  }
  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (task?.snapshot.state === 'running') {
      task.snapshot.state = 'cancelling';
      task.controller.abort();
    }
  }
  async stop(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session && session.snapshot.state === 'running') {
      session.snapshot.state = 'stopping';
      await session.handle.stop();
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map((task) => task.done));
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
