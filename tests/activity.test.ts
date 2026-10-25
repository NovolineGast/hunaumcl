import { describe, expect, it, vi } from 'vitest';
import { ActivityManager, redactLog } from '../packages/runtime-node/src/activity';
import type { GameRuntime, GameSession } from '@hunaumcl/application';
import type { InstanceSummary } from '@hunaumcl/contracts';
const instance: InstanceSummary = {
  id: '8d6e2a48-8888-4444-aaaa-0123456789ab',
  name: 'test',
  versionId: '1.21.1',
  loader: 'vanilla',
  createdAt: new Date().toISOString(),
};
async function settled(manager: ActivityManager) {
  await expect
    .poll(() => manager.snapshot().tasks.every((task) => !['running', 'cancelling'].includes(task.state)))
    .toBe(true);
}
function runtime(overrides: Partial<GameRuntime> = {}): GameRuntime {
  return {
    isInstalled: async () => false,
    install: async () => {},
    launch: async () => {
      throw Error('not implemented');
    },
    ...overrides,
  };
}
describe('background task ownership', () => {
  it('resolves Microsoft identities before spawning, exposes only public session metadata and never falls back to offline after a login failure', async () => {
    const launch = vi.fn<GameRuntime['launch']>(async () => ({ onLog() {}, onExit() {}, async stop() {} }));
    const identity = {
      kind: 'microsoft' as const,
      playerName: 'Server_Player',
      uuid: '1'.repeat(32),
      accessToken: 'private-access-token',
      xuid: '12345',
      clientId: 'client-id',
    };
    const manager = new ActivityManager(runtime({ launch }), { resolve: async () => identity });
    manager.start('launch', instance, 'Old_Player', 'account-id');
    await settled(manager);
    expect(launch.mock.calls[0]?.[1]).toBe('Server_Player');
    expect(launch.mock.calls[0]?.[4]).toEqual(identity);
    expect(manager.snapshot().sessions[0]).toMatchObject({
      identity: 'microsoft',
      playerName: 'Server_Player',
    });
    expect(JSON.stringify(manager.snapshot())).not.toContain(identity.accessToken);
    launch.mockClear();
    const failed = new ActivityManager(runtime({ launch }), {
      resolve: async () => {
        throw Error('Authorization failed');
      },
    });
    failed.start('launch', instance, 'Old_Player', 'account-id');
    await settled(failed);
    expect(failed.snapshot().tasks[0]?.state).toBe('failed');
    expect(launch).not.toHaveBeenCalled();
  });
  it('serializes writes and reports cancellation without a false success', async () => {
    const manager = new ActivityManager(
      runtime({
        install: async (_instance, report, signal) => {
          report({ stage: 'downloading', completed: 1, total: 10 });
          await new Promise<void>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          );
        },
      }),
    );
    const first = manager.start('install', instance);
    expect(() => manager.start('install', instance)).toThrow('当前安装');
    manager.cancel(first.taskId);
    await settled(manager);
    expect(manager.snapshot().tasks[0]?.state).toBe('cancelled');
  });
  it('tracks a running session and exposes bounded, redacted snapshots', async () => {
    let logger: Parameters<GameSession['onLog']>[0] | undefined;
    let exit: Parameters<GameSession['onExit']>[0] | undefined;
    const manager = new ActivityManager(
      runtime({
        launch: async () => ({
          onLog(listener) {
            logger = listener;
          },
          onExit(listener) {
            exit = listener;
          },
          async stop() {
            exit?.(0);
          },
        }),
      }),
    );
    manager.start('launch', instance, 'Player');
    await settled(manager);
    for (let i = 0; i < 1000; i++) logger?.(`accessToken=secret-${i}`, 'stdout');
    const snapshot = manager.snapshot();
    expect(snapshot.sessions[0]?.logs.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(snapshot)).not.toContain('secret-');
    expect(() => manager.start('install', instance)).toThrow('已在运行');
    await manager.stop(snapshot.sessions[0]!.id);
    expect(manager.snapshot().sessions[0]?.state).toBe('exited');
  });
  it('stops a process created at the same time as a cancellation', async () => {
    let resolve: (session: GameSession) => void = () => {};
    let stopped = false;
    const manager = new ActivityManager(
      runtime({
        launch: () =>
          new Promise((done) => {
            resolve = done;
          }),
      }),
    );
    const { taskId } = manager.start('launch', instance, 'Player');
    manager.cancel(taskId);
    resolve({
      onLog() {},
      onExit() {},
      async stop() {
        stopped = true;
      },
    });
    await settled(manager);
    expect(stopped).toBe(true);
    expect(manager.snapshot().tasks[0]?.state).toBe('cancelled');
  });
  it('redacts tokens in query strings and bearer headers', () => {
    expect(redactLog('https://service/?token=private&ok=1 Authorization: Bearer abc')).not.toMatch(
      /private|abc/,
    );
  });
});
