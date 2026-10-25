import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { MinecraftFolder } from '@xmcl/core';
import { createNodeInstallRuntime, executeInstallManifest } from '@xmcl/installer';
import { optifinePlan } from '../packages/runtime-node/src/optifine-plan';
import { downloadOfficialOptifine } from '../packages/runtime-node/src/optifine-download';
import { LoaderNetwork } from '../packages/runtime-node/src/loader-network';
import { resolveInstalledVersion } from '../packages/runtime-node/src/version-resolution';
import { optifineFixture } from './fixtures/optifine-installer';

const folders: string[] = [];
const host = { os: 'windows' as const, architecture: 'x64', osVersion: '10.0', appVersion: 'test' };
async function fixture(minecraft = '1.12.2') {
  const root = await mkdtemp(join(tmpdir(), 'hunaumcl-optifine-'));
  folders.push(root);
  const installer = join(root, 'installer.jar');
  const jar = optifineFixture(minecraft);
  await writeFile(installer, jar);
  return { root, installer, jar, folder: MinecraftFolder.from(root) };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of folders.splice(0)) {
    const child = relative(tmpdir(), root);
    if (isAbsolute(child) || !child.startsWith('hunaumcl-optifine-') || child.includes('..'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
describe('historical OptiFine installation', () => {
  it('cancels an official download without replacing the old file or leaving a partial file', async () => {
    const { root, jar, installer } = await fixture();
    const filename = 'OptiFine_1.12.2_HD_U_G5.jar';
    const source = `https://bmclapi2.bangbang93.com/maven/com/optifine/1.12.2/${filename}`;
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === source)
          return new Response(null, {
            status: 302,
            headers: { 'x-bmclapi-hash': createHash('md5').update(jar).digest('hex') },
          });
        if (String(input).includes('/adloadx?'))
          return new Response(`<a href="downloadx?f=${filename}&x=test">Download</a>`);
        return new Response(
          new ReadableStream({
            pull(stream) {
              controller.abort(new Error('cancelled'));
              stream.enqueue(new Uint8Array(jar));
              stream.close();
            },
          }),
        );
      }),
    );
    await expect(
      downloadOfficialOptifine(filename, source, installer, controller.signal, () => {}),
    ).rejects.toThrow('cancelled');
    expect(await readFile(installer)).toEqual(jar);
    expect(await readdir(root)).toEqual(['installer.jar']);
  });
  it('falls back from an unavailable mirror to the official source, verifies MD5 without content-length and caches the result', async () => {
    const { root, jar } = await fixture();
    const filename = 'OptiFine_1.12.2_HD_U_G5.jar';
    const source = `https://bmclapi2.bangbang93.com/maven/com/optifine/1.12.2/${filename}`;
    const md5 = createHash('md5').update(jar).digest('hex');
    const mirror = `https://unavailable.example/download/${md5}`;
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === source)
        return new Response(null, { status: 302, headers: { location: mirror, 'x-bmclapi-hash': md5 } });
      if (url === mirror) throw Error('Mirror node is unavailable');
      if (url.startsWith('https://optifine.net/adloadx?'))
        return new Response(`<a href="downloadx?f=${filename}&amp;x=test">Download</a>`);
      expect(url).toBe(`https://optifine.net/downloadx?f=${filename}&x=test`);
      return new Response(new Uint8Array(jar));
    });
    vi.stubGlobal('fetch', transport);
    const destination = join(root, 'official.jar');
    const shared = join(root, 'shared');
    const report = vi.fn();
    const network = new LoaderNetwork(new AbortController().signal, shared);
    await network.one({ path: destination, urls: [source] }, report, () =>
      downloadOfficialOptifine(filename, source, destination, new AbortController().signal, report),
    );
    expect(await readFile(destination)).toEqual(jar);
    expect(report.mock.calls.some(([progress]) => progress.download?.transferredBytes === jar.length)).toBe(
      true,
    );
    const count = transport.mock.calls.length;
    await new LoaderNetwork(new AbortController().signal, shared).one(
      { path: join(root, 'cached.jar'), urls: [source] },
      report,
    );
    expect(transport).toHaveBeenCalledTimes(count);
  });
  it('rejects corrupt official content and preserves the previous file', async () => {
    const { jar, installer } = await fixture();
    const filename = 'OptiFine_1.12.2_HD_U_G5.jar';
    const source = `https://bmclapi2.bangbang93.com/maven/com/optifine/1.12.2/${filename}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === source)
          return new Response(null, {
            status: 302,
            headers: { 'x-bmclapi-hash': createHash('md5').update(jar).digest('hex') },
          });
        if (String(input).includes('/adloadx?'))
          return new Response(`<a href="downloadx?f=${filename}&x=test">Download</a>`);
        return new Response('corrupt upstream content');
      }),
    );
    await expect(
      downloadOfficialOptifine(filename, source, installer, new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_HASH_MISMATCH' });
    expect(await readFile(installer)).toEqual(jar);
  });
  it('copies the 1.12.2 jar without running a patcher and inherits legacy JVM/game arguments with its tweaker', async () => {
    const { root, folder, installer, jar } = await fixture();
    const base = {
      id: '1.12.2',
      mainClass: 'net.minecraft.client.main.Main',
      javaVersion: { majorVersion: 8 },
      minecraftArguments: '--username ${auth_player_name} --gameDir ${game_directory}',
      libraries: [],
    };
    await mkdir(folder.getVersionRoot('1.12.2'), { recursive: true });
    await writeFile(folder.getVersionJson('1.12.2'), JSON.stringify(base));
    const installed = await optifinePlan(installer, folder, {
      versionId: 'legacy-optifine',
      inheritsFrom: '1.12.2',
      java: 'unused-java',
      expected: 'HD_U_G5',
    });
    const runJava = vi.fn(async () => {
      throw Error('Legacy OptiFine must not run a patcher');
    });
    await executeInstallManifest(installed.plan, createNodeInstallRuntime({ runJava }));
    expect(runJava).not.toHaveBeenCalled();
    expect(
      await readFile(folder.getLibraryByPath('optifine/Optifine/1.12.2_HD_U_G5/Optifine-1.12.2_HD_U_G5.jar')),
    ).toEqual(jar);
    const { version } = await resolveInstalledVersion(root, installed.version, host);
    expect(version.javaVersion.majorVersion).toBe(8);
    expect(version.mainClass).toBe('net.minecraft.launchwrapper.Launch');
    expect(version.arguments.game).toEqual([
      '--username',
      '${auth_player_name}',
      '--gameDir',
      '${game_directory}',
      '--tweakClass',
      'optifine.OptiFineTweaker',
    ]);
    expect(version.arguments.jvm).toContain('-cp');
    expect(version.arguments.jvm).toContain('-Djava.library.path=${natives_directory}');
    expect(version.libraries.some((library) => library.name === 'net.minecraft:launchwrapper:1.12')).toBe(
      true,
    );
  });
  it('keeps modern patcher installation and rejects a jar declaring another Minecraft version', async () => {
    const { folder, installer } = await fixture('1.20.1');
    const installed = await optifinePlan(installer, folder, {
      versionId: 'modern-optifine',
      inheritsFrom: '1.20.1',
      java: 'selected-java',
    });
    expect(installed.plan.tasks.some((task) => task.type === 'java')).toBe(true);
    await expect(
      optifinePlan(installer, folder, {
        versionId: 'wrong-game',
        inheritsFrom: '1.12.2',
        java: 'selected-java',
      }),
    ).rejects.toMatchObject({ code: 'OPTIFINE_MC_MISMATCH' });
  });
  it('resolves BMCLAPI MD5 redirects, verifies the jar and stores a reusable SHA-1 cache entry', async () => {
    const { root, jar } = await fixture();
    const md5 = createHash('md5').update(jar).digest('hex');
    const sha1 = createHash('sha1').update(jar).digest('hex');
    const source = 'https://bmclapi2.bangbang93.com/maven/com/optifine/1.12.2/OptiFine_1.12.2_HD_U_G5.jar';
    const mirror = `https://mirror.example/download/${md5}?signature=first`;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === source)
        return new Response(null, {
          status: 302,
          headers: { location: mirror, 'x-bmclapi-hash': md5 },
        });
      expect(String(input)).toBe(mirror);
      return new Response(init?.method === 'HEAD' ? null : new Uint8Array(jar), {
        headers: { 'content-length': String(jar.length) },
      });
    });
    vi.stubGlobal('fetch', transport);
    const shared = join(root, 'shared');
    const network = new LoaderNetwork(new AbortController().signal, shared);
    const first = { path: join(root, 'first.jar'), urls: [source] };
    await network.one(first, () => {});
    expect(await readFile(first.path)).toEqual(jar);
    expect(await readFile(join(shared, 'components', `${sha1}.jar`))).toEqual(jar);
    const requestCount = transport.mock.calls.length;
    await new LoaderNetwork(new AbortController().signal, shared).one(
      { ...first, path: join(root, 'second.jar') },
      () => {},
    );
    expect(transport.mock.calls.length).toBe(requestCount);
    expect(await readFile(join(root, 'second.jar'))).toEqual(jar);
  });
  it('rejects a mirror redirect that is not bound to the returned content hash', async () => {
    const { root, jar } = await fixture();
    const transport = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://mirror.example/arbitrary.jar',
            'x-bmclapi-hash': createHash('md5').update(jar).digest('hex'),
          },
        }),
    );
    vi.stubGlobal('fetch', transport);
    await expect(
      new LoaderNetwork(new AbortController().signal).artifact({
        path: join(root, 'jar'),
        urls: ['https://bmclapi2.bangbang93.com/maven/test.jar'],
      }),
    ).rejects.toMatchObject({ code: 'LOADER_SOURCE_INVALID' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
