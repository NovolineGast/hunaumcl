import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { LauncherError } from '@hunaumcl/application';
import type { GameSession } from '@hunaumcl/application';
import { GameLogFormatter } from './game-log';

/** The adapter takes an argv array; the renderer never supplies this specification. */
export async function startGameProcess(
  executable: string,
  argv: string[],
  cwd: string,
  clean: (text: string) => string,
  identity: 'offline' | 'microsoft' = 'offline',
): Promise<GameSession> {
  const environment = { ...process.env };
  delete environment.JAVA_TOOL_OPTIONS;
  delete environment.JDK_JAVA_OPTIONS;
  delete environment._JAVA_OPTIONS;
  const child: ChildProcess = spawn(executable, argv, {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logListener: ((text: string, stream: 'stdout' | 'stderr' | 'launcher') => void) | undefined;
  let exitListener: ((code: number | null) => void) | undefined;
  const pending: { text: string; stream: 'stdout' | 'stderr' | 'launcher' }[] = [];
  let exited = false;
  let exitCode: number | null = null;
  let closedResolve: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const log = (text: string, stream: 'stdout' | 'stderr' | 'launcher') => {
    const safe = clean(text).slice(0, 2000);
    if (logListener) logListener(safe, stream);
    else {
      pending.push({ text: safe, stream });
      if (pending.length > 100) pending.shift();
    }
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    const formatter = new GameLogFormatter();
    const decoder = new StringDecoder('utf8');
    let partial = '';
    const consume = (text: string) => {
      partial += text;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const formatted = formatter.format(line);
        if (formatted !== undefined) log(formatted, stream);
      }
      if (partial.length > 4000) {
        log(partial, stream);
        partial = '';
      }
    };
    child[stream]?.on('data', (chunk: Buffer) => consume(decoder.write(chunk)));
    child[stream]?.on('end', () => {
      consume(decoder.end());
      if (partial) log(partial, stream);
    });
  }
  child.on('close', (code) => {
    exited = true;
    exitCode = code;
    exitListener?.(code);
    closedResolve();
  });
  child.on('error', () => log('Java 进程无法启动，请重新检测运行环境。', 'launcher'));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () =>
      reject(new LauncherError('JAVA_SPAWN_FAILED', '无法创建 Java 进程，请重新检测运行环境')),
    );
  });
  log(
    identity === 'microsoft'
      ? '已使用 Microsoft 游戏账号启动。'
      : '已启动离线游戏进程；不具备正版服务器认证能力。',
    'launcher',
  );
  return {
    onLog(listener) {
      logListener = listener;
      for (const line of pending.splice(0)) listener(line.text, line.stream);
    },
    onExit(listener) {
      exitListener = listener;
      if (exited) listener(exitCode);
    },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      const timeout = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 3000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function javaArgumentFile(argv: readonly string[]): string {
  return argv
    .map(
      (argument) =>
        `"${argument.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`,
    )
    .join('\n');
}
