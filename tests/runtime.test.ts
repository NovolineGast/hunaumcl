import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { FileInstanceRepository, MojangVersionProvider, parseJavaProperties } from '@hunaumcl/runtime-node';
import type { FetchMetadata } from '../packages/runtime-node/src/mojang';

const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) {
    const child = relative(tmpdir(), folder);
    if (!child.startsWith('hunaumcl-test-') || isAbsolute(child) || child.includes('..'))
      throw new Error('Unsafe test cleanup path');
    await rm(folder, { recursive: true, force: true });
  }
});
async function directory() {
  const folder = await mkdtemp(join(tmpdir(), 'hunaumcl-test-'));
  temporary.push(folder);
  return folder;
}

describe('instance persistence', () => {
  it('preserves concurrent creates and survives a new repository instance', async () => {
    const folder = await directory();
    const repo = new FileInstanceRepository(folder);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => repo.create({ name: `实例 ${index}`, versionId: '1.21.1' })),
    );
    const instances = await new FileInstanceRepository(folder).list();
    expect(instances).toHaveLength(12);
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(12);
  });
  it('keeps corrupt records intact and refuses to overwrite them', async () => {
    const folder = await directory();
    const contents = '{ broken user data';
    await writeFile(join(folder, 'instances.json'), contents);
    const repo = new FileInstanceRepository(folder);
    await expect(repo.create({ name: 'new', versionId: '1.21.1' })).rejects.toMatchObject({
      code: 'INSTANCE_STORE_UNREADABLE',
    });
    expect(await readFile(join(folder, 'instances.json'), 'utf8')).toBe(contents);
  });
  it('validates identifiers and does not use the display name as a path', async () => {
    const folder = await directory();
    const repo = new FileInstanceRepository(folder);
    const instance = await repo.create({ name: '../显示名', versionId: '1.21.1' });
    expect(instance.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(repo.create({ name: 'invalid', versionId: '../file' })).rejects.toThrow();
    expect(await repo.list()).toHaveLength(1);
  });
});

const metadata = JSON.stringify({
  id: '1.21.1',
  mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { majorVersion: 21 },
  libraries: [],
});
function source(options: { bytes?: string; url?: string } = {}): FetchMetadata {
  const manifest = {
    latest: { release: '1.21.1' },
    versions: [
      {
        id: '1.21.1',
        type: 'release',
        releaseTime: '2024-08-08T00:00:00Z',
        url: options.url ?? 'https://piston-meta.mojang.com/v1/packages/example/1.21.1.json',
        sha1: createHash('sha1').update(metadata).digest('hex'),
      },
    ],
  };
  return async (url) =>
    new Response(
      url.endsWith('version_manifest_v2.json') ? JSON.stringify(manifest) : (options.bytes ?? metadata),
    );
}
describe('Mojang metadata trust', () => {
  it('loads and caches verified metadata', async () => {
    let requests = 0;
    const base = source();
    const provider = new MojangVersionProvider(async (url, init) => {
      requests++;
      return base(url, init);
    });
    expect((await provider.catalog()).latestRelease).toBe('1.21.1');
    expect((await provider.metadata('1.21.1')).javaVersion?.majorVersion).toBe(21);
    await provider.metadata('1.21.1');
    expect(requests).toBe(2);
  });
  it('rejects tampered bytes before parsing or caching', async () => {
    const provider = new MojangVersionProvider(source({ bytes: metadata.replace('21', '17') }));
    await expect(provider.metadata('1.21.1')).rejects.toMatchObject({ code: 'METADATA_HASH_MISMATCH' });
  });
  it('rejects metadata redirects to an untrusted manifest URL', async () => {
    const provider = new MojangVersionProvider(source({ url: 'https://example.com/version.json' }));
    await expect(provider.metadata('1.21.1')).rejects.toMatchObject({ code: 'METADATA_SOURCE_INVALID' });
  });
  it('turns network failures into a public actionable error', async () => {
    const provider = new MojangVersionProvider(async () => {
      throw new Error('private network details');
    });
    await expect(provider.catalog()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
  });
});

describe('Java probe output', () => {
  it('normalizes legacy Java 8 and x64 architecture', () => {
    expect(
      parseJavaProperties('    java.version = 1.8.0_412\n    os.arch = amd64\n    java.vendor = Example'),
    ).toEqual({ major: 8, version: '1.8.0_412', architecture: 'x64', vendor: 'Example' });
  });
  it('reads modern ARM Java and ignores incomplete probes', () => {
    expect(parseJavaProperties('    java.version = 25.0.1\n    os.arch = aarch64')?.architecture).toBe(
      'arm64',
    );
    expect(parseJavaProperties('openjdk version "21"')).toBeUndefined();
  });
});
