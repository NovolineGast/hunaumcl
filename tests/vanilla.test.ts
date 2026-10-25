import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { VanillaGameRuntime } from '../packages/runtime-node/src/vanilla';
import { VerifiedDownloader } from '../packages/runtime-node/src/downloads';
import { FileInstanceRepository } from '../packages/runtime-node/src/instances';
import { LocalJavaProvider } from '../packages/runtime-node/src/java';
import type { VersionMetadata } from '@hunaumcl/domain';
import * as processAdapter from '../packages/runtime-node/src/process';
import { defaultLaunchSettings } from '@hunaumcl/contracts';

const folders: string[] = [];
const digest = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) {
    const child = relative(tmpdir(), folder);
    if (!child.startsWith('hunaumcl-vanilla-') || isAbsolute(child) || child.includes('..'))
      throw Error('Unsafe cleanup');
    await rm(folder, { recursive: true, force: true });
  }
});
async function fixture(legacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'hunaumcl-vanilla-'));
  folders.push(root);
  const versionId = legacy ? '1.12.2' : '1.21.1';
  const instance = await new FileInstanceRepository(root).create({ name: 'test', versionId });
  const jar = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  const object = Buffer.from('game asset');
  const hash = digest(object);
  const index = Buffer.from(JSON.stringify({ objects: { 'test/file': { hash, size: object.length } } }));
  const download = (url: string, bytes: Buffer) => ({ url, sha1: digest(bytes), size: bytes.length });
  const library = (name: string, path: string) => ({
    name,
    downloads: { artifact: { ...download(`https://libraries.minecraft.net/${path}`, jar), path } },
  });
  const metadata: VersionMetadata = {
    id: versionId,
    mainClass: 'Main',
    type: 'release',
    assets: 'test-index',
    javaVersion: { majorVersion: 21 },
    arguments: {
      jvm: ['-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--gameDir', '${game_directory}'],
    },
    assetIndex: { ...download('https://piston-meta.mojang.com/test-index.json', index), id: 'test-index' },
    downloads: { client: download('https://piston-data.mojang.com/client.jar', jar) },
    libraries: [
      library('com.example:library:1', 'com/example/library/1/library-1.jar'),
      library(
        'org.lwjgl:lwjgl:3.3.3:natives-windows',
        'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
      ),
      library(
        'org.lwjgl:lwjgl:3.3.3:natives-windows-arm64',
        'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows-arm64.jar',
      ),
    ],
  };
  if (legacy) {
    metadata.javaVersion = { majorVersion: 8, component: 'jre-legacy' };
    delete metadata.arguments;
    metadata.minecraftArguments =
      '--username ${auth_player_name} --gameDir ${game_directory} --uuid ${auth_uuid}';
    const nativePath = 'org/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-windows.jar';
    metadata.libraries = [
      metadata.libraries[0]!,
      {
        name: 'org.lwjgl:lwjgl-platform:2.9.4',
        natives: { windows: 'natives-windows' },
        downloads: {
          classifiers: {
            'natives-windows': {
              ...download(`https://libraries.minecraft.net/${nativePath}`, jar),
              path: nativePath,
            },
          },
        },
      },
    ];
  }
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return new Response(
      url.includes('test-index') ? index : url.includes('resources.download') ? object : jar,
    );
  };
  const java = new LocalJavaProvider();
  const runtime = new VanillaGameRuntime(
    root,
    {
      catalog: async () => ({ cached: true, latestRelease: '1.21.1', releases: [] }),
      metadata: async () => metadata,
    },
    java,
    { os: 'windows', architecture: 'x64', osVersion: '10.0', appVersion: '0.1.0' },
    new VerifiedDownloader(fetcher),
  );
  return { root, instance, runtime, calls, hash, object, metadata, java };
}
describe('vanilla install transaction', () => {
  it('launches Microsoft identities with the server UUID, access token, msa type and Xbox parameters while keeping tokens out of the JVM argfile and logs', async () => {
    const { instance, runtime, java, metadata } = await fixture();
    metadata.arguments = {
      jvm: ['-cp', '${classpath}'],
      game: [
        '--username',
        '${auth_player_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--userType',
        '${user_type}',
        '--xuid',
        '${auth_xuid}',
        '--clientId',
        '${clientid}',
      ],
    };
    vi.spyOn(java, 'scan').mockResolvedValue([
      { id: 'java21', major: 21, version: '21', architecture: 'x64', vendor: 'test' },
    ]);
    vi.spyOn(java, 'executable').mockReturnValue('C:/managed/java.exe');
    const spawn = vi
      .spyOn(processAdapter, 'startGameProcess')
      .mockResolvedValue({ onLog() {}, onExit() {}, async stop() {} });
    await runtime.install(instance, () => {}, new AbortController().signal);
    const identity = {
      kind: 'microsoft' as const,
      playerName: 'Server_Player',
      uuid: '1'.repeat(32),
      accessToken: 'sensitive-minecraft-token',
      xuid: '12345',
      clientId: 'client-id',
    };
    await runtime.launch(instance, identity.playerName, () => {}, new AbortController().signal, identity);
    const [, args, , clean, kind] = spawn.mock.calls[0]!;
    const jvmFile = await readFile(args[0]!.slice(1), 'utf8');
    expect(jvmFile).toContain('Main');
    expect(jvmFile).not.toContain(identity.accessToken);
    expect(args[args.indexOf('--uuid') + 1]).toBe(identity.uuid);
    expect(args[args.indexOf('--accessToken') + 1]).toBe(identity.accessToken);
    expect(args[args.indexOf('--userType') + 1]).toBe('msa');
    expect(args[args.indexOf('--xuid') + 1]).toBe('12345');
    expect(args[args.indexOf('--clientId') + 1]).toBe('client-id');
    expect(clean(`Authorization ${identity.accessToken}`)).not.toContain(identity.accessToken);
    expect(kind).toBe('microsoft');
  });
  it('installs legacy natives and launches 1.12.2 with Java 8, classpath, native directory and offline arguments', async () => {
    const { root, instance, runtime, java, calls } = await fixture(true);
    vi.spyOn(java, 'scan').mockResolvedValue([
      { id: 'java8', major: 8, version: '1.8.0_504', architecture: 'x64', vendor: 'test' },
      { id: 'java21', major: 21, version: '21', architecture: 'x64', vendor: 'test' },
    ]);
    vi.spyOn(java, 'executable').mockReturnValue('C:/managed/java8.exe');
    const spawn = vi.spyOn(processAdapter, 'startGameProcess').mockResolvedValue({
      onLog() {},
      onExit() {},
      async stop() {},
    });
    await runtime.install(instance, () => {}, new AbortController().signal);
    expect(await runtime.isInstalled(instance)).toBe(true);
    expect(calls.some((url) => url.includes('lwjgl-platform-2.9.4-natives-windows.jar'))).toBe(true);
    await runtime.launch(instance, 'Legacy_Player', () => {}, new AbortController().signal);
    const [executable, args, cwd] = spawn.mock.calls[0]!;
    expect(executable).toBe('C:/managed/java8.exe');
    expect(args[0]).not.toMatch(/^@/);
    expect(args).toContain('-cp');
    expect(args[args.indexOf('-cp') + 1]).toContain('1.12.2.jar');
    expect(args.some((arg) => arg.startsWith('-Djava.library.path=') && arg.includes('natives'))).toBe(true);
    expect(args).toContain('Legacy_Player');
    expect(args).toContain('--uuid');
    expect(args.some((arg) => /\$\{/.test(arg))).toBe(false);
    expect(cwd).toBe(join(root, 'instances', instance.id, 'game'));
  });
  it('applies shared isolation consistently to cwd and gameDir, and locks that directory until exit', async () => {
    const { root, instance, runtime, java } = await fixture();
    const javaId = 'b'.repeat(64);
    vi.spyOn(java, 'scan').mockResolvedValue([
      { id: javaId, major: 21, version: '21', architecture: 'x64', vendor: 'test' },
    ]);
    vi.spyOn(java, 'executable').mockReturnValue('C:/managed/java.exe');
    let exit: ((code: number | null) => void) | undefined;
    const spawn = vi.spyOn(processAdapter, 'startGameProcess').mockResolvedValue({
      onLog() {},
      onExit(listener) {
        exit = listener;
      },
      async stop() {
        exit?.(0);
      },
    });
    await runtime.install(instance, () => {}, new AbortController().signal);
    instance.settings = { ...defaultLaunchSettings, isolation: 'shared' };
    const session = await runtime.launch(instance, 'Shared_Player', () => {}, new AbortController().signal);
    expect(spawn.mock.calls[0]![2]).toBe(join(root, 'games', 'shared'));
    const args = await readFile(spawn.mock.calls[0]![1][0]!.slice(1), 'utf8');
    expect(args).toContain(
      processAdapter.javaArgumentFile([join(root, 'games', 'shared').replaceAll('\\', '/')]),
    );
    await expect(runtime.install(instance, () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'GAME_DIRECTORY_BUSY',
    });
    await session.stop();
    await runtime.install(instance, () => {}, new AbortController().signal);
  });
  it('uses saved Java, memory and window settings in the actual generated process specification', async () => {
    const { instance, runtime, java } = await fixture();
    const javaId = 'a'.repeat(64);
    vi.spyOn(java, 'scan').mockResolvedValue([
      { id: javaId, major: 21, version: '21', architecture: 'x64', vendor: 'test' },
    ]);
    vi.spyOn(java, 'executable').mockReturnValue('C:/managed/java.exe');
    let exit: ((code: number | null) => void) | undefined;
    const spawn = vi.spyOn(processAdapter, 'startGameProcess').mockResolvedValue({
      onLog() {},
      onExit(listener) {
        exit = listener;
      },
      async stop() {
        exit?.(0);
      },
    });
    await runtime.install(instance, () => {}, new AbortController().signal);
    instance.settings = {
      ...defaultLaunchSettings,
      javaId,
      memoryMode: 'custom',
      memoryMiB: 3072,
      width: 1280,
      height: 720,
    };
    const session = await runtime.launch(instance, 'Saved_Player', () => {}, new AbortController().signal);
    const invocation = spawn.mock.calls[0]!;
    expect(invocation[0]).toBe('C:/managed/java.exe');
    const argumentsText = await readFile(invocation[1][0]!.slice(1), 'utf8');
    expect(argumentsText).toContain('"-Xmx3072M"');
    expect(argumentsText).toContain('"--width"\n"1280"');
    expect(argumentsText).toContain('"--height"\n"720"');
    expect(argumentsText).toContain('"Saved_Player"');
    instance.settings.fullscreen = true;
    await expect(
      runtime.launch(instance, 'Saved_Player', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'GAME_DIRECTORY_BUSY' });
    await session.stop();
    await runtime.launch(instance, 'Saved_Player', () => {}, new AbortController().signal);
    const fullscreen = await readFile(spawn.mock.calls[1]![1][0]!.slice(1), 'utf8');
    expect(fullscreen).toContain('"--fullscreen"');
  });
  it('filters native CPU variants, verifies assets and commits only after completion', async () => {
    const { root, instance, runtime, calls, hash, object } = await fixture();
    expect(await runtime.isInstalled(instance)).toBe(false);
    await runtime.install(instance, () => {}, new AbortController().signal);
    expect(await runtime.isInstalled(instance)).toBe(true);
    expect(calls.some((url) => url.includes('arm64'))).toBe(false);
    const objectPath = join(root, 'shared/assets/objects', hash.slice(0, 2), hash);
    expect(await readFile(objectPath)).toEqual(object);
    const initialCalls = calls.length;
    await runtime.install(instance, () => {}, new AbortController().signal);
    expect(calls.length).toBe(initialCalls);
    await writeFile(objectPath, 'damaged');
    await runtime.install(instance, () => {}, new AbortController().signal);
    expect(await readFile(objectPath)).toEqual(object);
    expect(calls.length).toBe(initialCalls + 1);
  });
  it('does not mark an aborted install complete or remove user saves', async () => {
    const { root, instance, runtime } = await fixture();
    const controller = new AbortController();
    const userFile = join(root, 'instances', instance.id, 'game', 'user-save.txt');
    await writeFile(userFile, 'keep');
    await expect(runtime.install(instance, () => controller.abort(), controller.signal)).rejects.toThrow();
    expect(await runtime.isInstalled(instance)).toBe(false);
    expect(await readFile(userFile, 'utf8')).toBe('keep');
  });
});
