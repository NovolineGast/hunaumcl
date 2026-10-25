import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { safeChild, VerifiedDownloader } from '../packages/runtime-node/src/downloads';
import type { DownloadProgress } from '@hunaumcl/contracts';

const folders: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hunaumcl-download-'));
  folders.push(root);
  const bytes = Buffer.from('verified game file');
  return {
    root,
    bytes,
    artifact: {
      url: 'https://libraries.minecraft.net/test.jar',
      path: join(root, 'test.jar'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      size: bytes.length,
    },
  };
}
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    const child = relative(tmpdir(), folder);
    if (!child.startsWith('hunaumcl-download-') || isAbsolute(child) || child.includes('..'))
      throw Error('Unsafe cleanup');
    await rm(folder, { recursive: true, force: true });
  }
});
describe('verified downloads', () => {
  it('verifies historical mirror MD5 downloads and rejects corrupt replacements while preserving the old file', async () => {
    const { bytes, artifact } = await fixture();
    const { sha1: _sha1, ...file } = artifact;
    const legacy = { ...file, md5: createHash('md5').update(bytes).digest('hex') };
    const downloader = new VerifiedDownloader(async () => new Response(bytes));
    await downloader.ensure(legacy, new AbortController().signal);
    expect(await readFile(file.path)).toEqual(bytes);
    await expect(
      downloader.ensure({ ...legacy, md5: '0'.repeat(32) }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_HASH_MISMATCH' });
    expect(await readFile(file.path)).toEqual(bytes);
  });
  it('reports streaming bytes, speed and ETA before a single large file completes', async () => {
    const { root } = await fixture();
    const bytes = Buffer.alloc(1024 * 1024, 42);
    let position = 0;
    const downloader = new VerifiedDownloader(
      async () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              await new Promise((done) => setTimeout(done, 80));
              if (position >= bytes.length) {
                controller.close();
                return;
              }
              controller.enqueue(bytes.subarray(position, position + 128 * 1024));
              position += 128 * 1024;
            },
          }),
        ),
    );
    const snapshots: { completed: number; download: DownloadProgress }[] = [];
    const artifact = {
      url: 'https://piston-data.mojang.com/client.jar',
      path: join(root, 'client.jar'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      size: bytes.length,
    };
    await downloader.batch([artifact], new AbortController().signal, (completed, _total, download) =>
      snapshots.push({ completed, download }),
    );
    expect(
      snapshots.some(
        ({ completed, download }) =>
          completed === 0 &&
          download.completedBytes > 0 &&
          download.completedBytes < bytes.length &&
          download.bytesPerSecond > 0 &&
          download.etaSeconds !== null &&
          download.activeConnections === 1,
      ),
    ).toBe(true);
    expect(snapshots.at(-1)?.download).toMatchObject({
      completedBytes: bytes.length,
      transferredBytes: bytes.length,
      activeConnections: 0,
      cachedBytes: 0,
    });
    snapshots.length = 0;
    await downloader.batch([artifact], new AbortController().signal, (completed, _total, download) =>
      snapshots.push({ completed, download }),
    );
    expect(snapshots.at(-1)?.download).toMatchObject({
      transferredBytes: 0,
      cachedBytes: bytes.length,
      completedBytes: bytes.length,
    });
  });
  it('replaces a damaged file only after verified download and reuses valid content', async () => {
    const { bytes, artifact } = await fixture();
    let requests = 0;
    await writeFile(artifact.path, 'old corrupt file');
    const downloader = new VerifiedDownloader(async () => {
      requests++;
      return new Response(bytes);
    });
    await downloader.ensure(artifact, new AbortController().signal);
    await downloader.ensure(artifact, new AbortController().signal);
    expect(await readFile(artifact.path)).toEqual(bytes);
    expect(requests).toBe(1);
  });
  it('keeps existing data on a checksum mismatch and removes temporary files', async () => {
    const { root, artifact } = await fixture();
    await writeFile(artifact.path, 'old');
    const downloader = new VerifiedDownloader(async () => new Response('tampered'));
    await expect(downloader.ensure(artifact, new AbortController().signal)).rejects.toMatchObject({
      code: 'DOWNLOAD_HASH_MISMATCH',
    });
    expect(await readFile(artifact.path, 'utf8')).toBe('old');
    expect(await readdir(root)).toEqual(['test.jar']);
  });
  it('cancels streaming work without publishing a partial artifact', async () => {
    const { root, artifact } = await fixture();
    const controller = new AbortController();
    const downloader = new VerifiedDownloader(
      async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              stream.enqueue(new Uint8Array([1]));
              controller.abort();
            },
          }),
        ),
    );
    await expect(downloader.ensure(artifact, controller.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects an untrusted source before opening a network connection', async () => {
    const { artifact } = await fixture();
    let called = false;
    const downloader = new VerifiedDownloader(async () => {
      called = true;
      return new Response();
    });
    await expect(
      downloader.ensure({ ...artifact, url: 'https://example.com/jar' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_SOURCE_INVALID' });
    expect(called).toBe(false);
  });
  it('bounds batch concurrency and waits for all cancelled workers to settle', async () => {
    const { root, bytes, artifact } = await fixture();
    let active = 0;
    let peak = 0;
    const downloader = new VerifiedDownloader(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 5));
      active--;
      return new Response(bytes);
    });
    await downloader.batch(
      Array.from({ length: 20 }, (_, i) => ({ ...artifact, path: join(root, `${i}.jar`) })),
      new AbortController().signal,
      () => {},
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect((await readdir(root)).length).toBe(20);
  });
});
describe('manifest file paths', () => {
  it.each(['../outside', '/absolute', 'C:/outside', 'a\\..\\outside', 'a//b', './same'])(
    'rejects %s',
    (child) => {
      expect(() => safeChild('/data', child)).toThrow();
    },
  );
});
