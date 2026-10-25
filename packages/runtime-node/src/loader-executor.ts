import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createNodeInstallRuntime, executeInstallManifest, runInstallWorkflow } from '@xmcl/installer';
import type { InstallManifest, InstallRuntime, InstallWorkflow, JavaCommand } from '@xmcl/installer';
import { LauncherError } from '@hunaumcl/application';
import type { RuntimeProgress } from '@hunaumcl/application';
import { LoaderNetwork, within } from './loader-network';

export class LoaderPlanExecutor {
  readonly network: LoaderNetwork;
  private readonly runtime: InstallRuntime;
  constructor(
    private readonly workspace: string,
    shared: string,
    private readonly java: string,
    private readonly report: (progress: RuntimeProgress) => void,
    private readonly signal: AbortSignal,
  ) {
    this.network = new LoaderNetwork(signal, shared);
    this.runtime = createNodeInstallRuntime({
      signal,
      download: (files) => this.network.download(files, workspace, shared, report),
      runJava: (command) => this.runJava(command),
    });
  }
  async execute(plan: InstallManifest): Promise<void> {
    for (const task of plan.tasks) {
      if (task.type === 'files')
        for (const file of task.files) {
          within(this.workspace, file.path);
          if (file.size !== undefined && file.size < 0) delete file.size;
        }
      if (task.type === 'materialize')
        for (const operation of task.operations) {
          within(this.workspace, operation.path);
          if ('source' in operation) within(this.workspace, operation.source);
          if ('archive' in operation) within(this.workspace, operation.archive);
          if ('archives' in operation) operation.archives.forEach((path) => within(this.workspace, path));
        }
      if (task.type === 'java')
        for (const output of task.outputs) {
          within(this.workspace, output.path);
          await mkdir(dirname(output.path), { recursive: true });
        }
    }
    await executeInstallManifest(plan, this.runtime, {
      signal: this.signal,
      attempts: 2,
      onEvent: (event) => {
        if (event.type === 'task-start')
          this.report({
            stage:
              event.task.type === 'java'
                ? '正在安装加载器'
                : event.task.type === 'materialize'
                  ? '正在生成启动配置'
                  : '正在准备组件文件',
            completed: 0,
            total: 0,
          });
      },
    });
  }
  workflow<T>(workflow: InstallWorkflow<T>): Promise<T> {
    return runInstallWorkflow(workflow, (plan) => this.execute(plan));
  }
  private async runJava(command: JavaCommand): Promise<void> {
    this.signal.throwIfAborted();
    if (resolve(command.executable) !== resolve(this.java))
      throw new LauncherError('INSTALL_JAVA_INVALID', '安装计划试图调用未选择的 Java');
    const cwd = command.cwd ?? this.workspace;
    within(this.workspace, cwd);
    const environment = { ...process.env };
    delete environment.JAVA_TOOL_OPTIONS;
    delete environment.JDK_JAVA_OPTIONS;
    delete environment._JAVA_OPTIONS;
    await new Promise<void>((resolve_, reject) => {
      const child = spawn(this.java, command.args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let tail = '';
      let aborted = false;
      const collect = (chunk: Buffer) => {
        tail = (tail + chunk.toString('utf8')).slice(-16000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const kill = () => {
        aborted = true;
        child.kill('SIGTERM');
        force = setTimeout(() => child.kill('SIGKILL'), 2500);
      };
      let force: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(kill, 5 * 60_000);
      this.signal.addEventListener('abort', kill, { once: true });
      child.once('error', () => {
        clearTimeout(timeout);
        clearTimeout(force);
        this.signal.removeEventListener('abort', kill);
        reject(new LauncherError('INSTALL_PROCESSOR_START', '安装步骤无法启动，请检查 Java'));
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        clearTimeout(force);
        this.signal.removeEventListener('abort', kill);
        void appendFile(join(this.workspace, 'processors.log'), `${tail}\n[exit=${code}]\n`)
          .catch(() => {})
          .finally(() => {
            if (this.signal.aborted) reject(this.signal.reason);
            else if (aborted || code !== 0)
              reject(
                new LauncherError(
                  'INSTALL_PROCESSOR_FAILED',
                  `安装未完成${aborted ? '（等待超时）' : ''}，原有配置仍然可用；诊断记录已保留`,
                ),
              );
            else resolve_();
          });
      });
      if (this.signal.aborted) kill();
    });
  }
}
