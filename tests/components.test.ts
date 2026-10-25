import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Version } from '@xmcl/core';
import {
  componentCompatibilityError,
  componentsSchema,
  defaultLaunchSettings,
  vanillaComponents,
} from '@hunaumcl/contracts';
import type { InstanceSummary } from '@hunaumcl/contracts';
import { gameDirectory } from '../packages/runtime-node/src/isolation';
import {
  LoaderCatalogProvider,
  neoProject,
  optifineForgeCompatible,
} from '../packages/runtime-node/src/component-catalog';
import { ComponentInstaller, composedReceiptSchema } from '../packages/runtime-node/src/component-install';
import { resolveInstalledVersion } from '../packages/runtime-node/src/version-resolution';

const folders: string[] = [];
const host = { os: 'windows' as const, architecture: 'x64', osVersion: '10.0', appVersion: 'test' };
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'hunaumcl-components-'));
  folders.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const path of folders.splice(0)) {
    const child = relative(tmpdir(), path);
    if (isAbsolute(child) || !child.startsWith('hunaumcl-components-') || child.includes('..'))
      throw Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
const instance = (id = '8d6e2a48-8888-4444-aaaa-0123456789ab'): InstanceSummary => ({
  id,
  name: 'Test',
  versionId: '1.20.1',
  loader: 'vanilla',
  createdAt: new Date().toISOString(),
  settings: { ...defaultLaunchSettings },
  components: { ...vanillaComponents },
});
describe('component combination constraints', () => {
  it('keeps old persisted records readable while blocking a known runtime-incompatible combination', () => {
    const old = {
      ...vanillaComponents,
      loader: 'fabric' as const,
      loaderVersion: '0.19.5',
      optifine: 'HD_U_I6',
      optifabric: 'cf5025647',
    };
    expect(componentsSchema.safeParse(old).success).toBe(true);
    expect(componentCompatibilityError('1.20.1', old)).toContain('0.15.11');
    expect(componentCompatibilityError('1.20.1', { ...old, loaderVersion: '0.15.11' })).toBeUndefined();
  });
  it('rejects incompatible component combinations before reaching an installer', () => {
    expect(
      componentsSchema.safeParse({
        ...vanillaComponents,
        loader: 'neoforge',
        loaderVersion: '21.1.1',
        optifine: 'HD_U_J1',
      }).success,
    ).toBe(false);
    expect(
      componentsSchema.safeParse({
        ...vanillaComponents,
        loader: 'fabric',
        loaderVersion: '0.16.0',
        optifine: 'HD_U_I6',
      }).success,
    ).toBe(false);
    expect(componentsSchema.safeParse({ ...vanillaComponents, fabricApi: 'addon' }).success).toBe(false);
    expect(
      componentsSchema.safeParse({
        ...vanillaComponents,
        loader: 'forge',
        loaderVersion: '47.2.18',
        optifine: 'HD_U_I6',
      }).success,
    ).toBe(true);
  });
  it('uses exact or legacy build Forge requirements, not a minimum version approximation', () => {
    expect(optifineForgeCompatible('47.2.18', '47.2.18')).toBe(true);
    expect(optifineForgeCompatible('47.2.18', '47.4.10')).toBe(false);
    expect(optifineForgeCompatible('2859', '14.23.5.2859')).toBe(true);
    expect(optifineForgeCompatible('Forge #2847', '14.23.5.2847')).toBe(true);
    expect(optifineForgeCompatible('Forge #2847', '14.23.5.2859')).toBe(false);
    expect(optifineForgeCompatible('Forge N/A', '14.23.5.2847')).toBe(false);
    expect(optifineForgeCompatible(null, '47.2.18')).toBe(false);
    expect(optifineForgeCompatible('', '47.2.18')).toBe(true);
    expect(neoProject('1.20.1')).toBe('forge');
    expect(neoProject('1.21.1')).toBe('neoforge');
  });
});
describe('game directory isolation', () => {
  it('uses distinct independent gameDirs and an explicit shared gameDir', async () => {
    const path = await root();
    const first = instance();
    const second = instance('7d6e2a48-8888-4444-aaaa-0123456789ab');
    const a = await gameDirectory(path, first);
    const b = await gameDirectory(path, second);
    expect(a).not.toBe(b);
    await writeFile(join(a, 'save-marker.txt'), 'keep');
    first.settings!.isolation = 'shared';
    second.settings!.isolation = 'shared';
    expect(await gameDirectory(path, first)).toBe(await gameDirectory(path, second));
    expect(await readFile(join(a, 'save-marker.txt'), 'utf8')).toBe('keep');
  });
  it('auto-isolates loader instances and previously used independent saves', async () => {
    const path = await root();
    const item = instance();
    item.settings!.isolation = 'auto';
    expect(await gameDirectory(path, item)).toBe(join(path, 'games', 'shared'));
    item.components = { ...vanillaComponents, loader: 'fabric', loaderVersion: '0.16.0' };
    expect(await gameDirectory(path, item)).toBe(join(path, 'instances', item.id, 'game'));
    item.components = { ...vanillaComponents };
    await mkdir(join(path, 'instances', item.id, 'game', 'saves'), { recursive: true });
    await writeFile(join(path, 'instances', item.id, 'game', 'saves', 'world'), 'keep');
    expect(await gameDirectory(path, item)).toBe(join(path, 'instances', item.id, 'game'));
  });
});
describe('version inheritance and install transactions', () => {
  it('reports a three-node cycle without consuming unbounded stack', async () => {
    const path = await root();
    for (const [id, parent] of [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
    ]) {
      await mkdir(join(path, 'versions', id!), { recursive: true });
      await writeFile(
        join(path, 'versions', id!, `${id}.json`),
        JSON.stringify({ id, inheritsFrom: parent, libraries: [] }),
      );
    }
    await expect(resolveInstalledVersion(path, 'A', host)).rejects.toMatchObject({
      code: 'VERSION_INHERITANCE_CYCLE',
    });
  });
  it('preserves the old receipt on a failed dependency and publishes the full inherited profile only after success', async () => {
    const path = await root();
    const item = instance();
    item.loader = 'fabric';
    item.components = { ...vanillaComponents, loader: 'fabric', loaderVersion: '0.16.0' };
    const shared = join(path, 'shared');
    const jar = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    const sha = createHash('sha1').update(jar).digest('hex');
    const base = {
      id: '1.20.1',
      mainClass: 'net.minecraft.client.main.Main',
      type: 'release',
      assets: 'test',
      assetIndex: {
        id: 'test',
        url: 'https://piston-meta.mojang.com/test',
        sha1: sha,
        size: 1,
        totalSize: 0,
      },
      javaVersion: { majorVersion: 17, component: 'test' },
      downloads: {
        client: { sha1: sha, size: jar.length, url: 'https://piston-data.mojang.com/client.jar' },
      },
      arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] },
      libraries: [],
    };
    await mkdir(join(shared, 'versions', '1.20.1'), { recursive: true });
    await mkdir(join(shared, 'assets'), { recursive: true });
    await mkdir(join(path, 'instances', item.id, 'game'), { recursive: true });
    await writeFile(join(shared, 'versions', '1.20.1', '1.20.1.json'), JSON.stringify(base));
    await writeFile(join(shared, 'versions', '1.20.1', '1.20.1.jar'), jar);
    const receiptPath = join(path, 'instances', item.id, 'install.json');
    const previous = '{"schemaVersion":1,"old":"valid"}';
    await writeFile(receiptPath, previous);
    await writeFile(join(path, 'instances', item.id, 'game', 'save.txt'), 'keep');
    const catalog = new LoaderCatalogProvider();
    vi.spyOn(catalog, 'validate').mockResolvedValue();
    const profile = {
      id: 'fabric-loader-0.16.0-1.20.1',
      inheritsFrom: '1.20.1',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [
        {
          name: 'test:loader:1',
          downloads: {
            artifact: {
              url: 'https://maven.fabricmc.net/test/loader/1/loader-1.jar',
              path: 'test/loader/1/loader-1.jar',
              sha1: sha,
              size: jar.length,
            },
          },
        },
      ],
      arguments: { game: [], jvm: [] },
    };
    vi.spyOn(catalog, 'request').mockImplementation(async () => new Response(JSON.stringify(profile)));
    let tampered = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(tampered ? 'bad' : jar)),
    );
    const installer = new ComponentInstaller(path, shared, catalog, host);
    const version = Version.resolve(shared, [
      Version.normalizeVersionJson(JSON.stringify(base), shared, {
        name: 'windows',
        arch: 'x64',
        version: '10',
      }),
    ]);
    await expect(
      installer.install(item, version, process.execPath, () => {}, new AbortController().signal),
    ).rejects.toThrow();
    expect(await readFile(receiptPath, 'utf8')).toBe(previous);
    expect(await readFile(join(path, 'instances', item.id, 'game', 'save.txt'), 'utf8')).toBe('keep');
    tampered = false;
    await installer.install(item, version, process.execPath, () => {}, new AbortController().signal);
    const receipt = composedReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')));
    expect(receipt.components.loader).toBe('fabric');
    const resolved = await resolveInstalledVersion(join(path, receipt.runtime), receipt.profileId, host);
    expect(resolved.version.mainClass).toContain('KnotClient');
    expect(resolved.version.libraries.some((lib) => lib.name === 'test:loader:1')).toBe(true);
    expect(Object.keys(receipt.documents)).toHaveLength(2);
    const directories = await readdir(join(path, 'transactions'));
    expect(directories).toHaveLength(2);
  });
});
