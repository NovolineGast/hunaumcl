import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LauncherError } from '@hunaumcl/application';
import type { DownloadProgress } from '@hunaumcl/contracts';

export type DownloadArtifact = {
  url: string;
  path: string;
  size: number;
  resolveURL?: () => Promise<string>;
} & ({ sha1: string; md5?: never } | { md5: string; sha1?: never });

function artifactChecksum(artifact: DownloadArtifact): { algorithm: 'sha1' | 'md5'; value: string } {
  if (artifact.sha1 && /^[a-f0-9]{40}$/.test(artifact.sha1))
    return { algorithm: 'sha1', value: artifact.sha1 };
  if (artifact.md5 && /^[a-f0-9]{32}$/.test(artifact.md5)) return { algorithm: 'md5', value: artifact.md5 };
  throw new LauncherError('INVALID_ARTIFACT', '游戏文件缺少校验信息，已停止下载');
}
export type DownloadFetch = (url: string, init: RequestInit) => Promise<Response>;
const hosts = new Set([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'launcher.mojang.com',
  'launchermeta.mojang.com',
]);

export function safeChild(root: string, child: string): string {
  if (
    !child ||
    child.includes('\\') ||
    child.includes(':') ||
    child.split('/').some((part) => part === '..' || part === '.' || !part)
  )
    throw new LauncherError('UNSAFE_PATH', '游戏文件列表包含无效路径，已停止下载');
  const target = resolve(root, child);
  const location = relative(resolve(root), target);
  if (isAbsolute(child) || isAbsolute(location) || location.startsWith('..'))
    throw new LauncherError('UNSAFE_PATH', '游戏文件路径超出数据目录，已停止下载');
  return target;
}
export function trustedDownload(url: string): void {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.port ||
    !hosts.has(target.hostname)
  )
    throw new LauncherError('DOWNLOAD_SOURCE_INVALID', '游戏文件来源不可信，已停止下载');
}
export async function validArtifact(artifact: DownloadArtifact, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const checksum = artifactChecksum(artifact);
  try {
    if ((await stat(artifact.path)).size !== artifact.size) return false;
    const hash = createHash(checksum.algorithm);
    for await (const chunk of createReadStream(artifact.path, { signal })) hash.update(chunk);
    return hash.digest('hex') === checksum.value;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** One caller owns the installation queue. Cross-task writes are serialized by ActivityManager. */
export class VerifiedDownloader {
  constructor(
    private readonly fetcher: DownloadFetch = (url, init) => fetch(url, init),
    private readonly authorize: (url: string) => void = trustedDownload,
  ) {}
  async ensure(
    artifact: DownloadArtifact,
    signal: AbortSignal,
    onBytes?: (received: number, transferred: number, cached: boolean) => void,
  ): Promise<void> {
    this.authorize(artifact.url);
    const checksum = artifactChecksum(artifact);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 1024 * 1024 * 1024)
      throw new LauncherError('INVALID_ARTIFACT', '游戏文件缺少大小信息，已停止下载');
    if (await validArtifact(artifact, signal)) {
      onBytes?.(artifact.size, 0, true);
      return;
    }
    await mkdir(dirname(artifact.path), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const temporary = `${artifact.path}.${randomUUID()}.part`;
      onBytes?.(0, 0, false);
      try {
        const requestURL = artifact.resolveURL ? await artifact.resolveURL() : artifact.url;
        this.authorize(requestURL);
        const response = await this.fetcher(requestURL, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          redirect: 'error',
          headers: { 'User-Agent': 'HUNAUMCL/0.1.0', 'Accept-Encoding': 'identity' },
        });
        if (!response.ok || !response.body)
          throw new LauncherError('DOWNLOAD_HTTP', `游戏下载请求失败（HTTP ${response.status}）`);
        const handle = await open(temporary, 'wx');
        let bytes = 0;
        const hash = createHash(checksum.algorithm);
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            bytes += chunk.byteLength;
            if (bytes > artifact.size)
              throw new LauncherError('DOWNLOAD_SIZE_MISMATCH', '下载文件超过清单声明的大小');
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const written = await handle.write(chunk, offset, chunk.byteLength - offset);
              if (written.bytesWritten <= 0) throw new Error('Short write');
              offset += written.bytesWritten;
            }
            onBytes?.(bytes, chunk.byteLength, false);
          }
          if (bytes !== artifact.size || hash.digest('hex') !== checksum.value)
            throw new LauncherError('DOWNLOAD_HASH_MISMATCH', '下载文件完整性校验失败');
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal.throwIfAborted();
        await rename(temporary, artifact.path);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (attempt === 2)
          throw error instanceof LauncherError
            ? error
            : new LauncherError('DOWNLOAD_FAILED', '游戏下载失败，请检查网络或磁盘空间后重试');
        await delay(300 * (attempt + 1), undefined, { signal });
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  async batch(
    artifacts: DownloadArtifact[],
    signal: AbortSignal,
    progress: (completed: number, total: number, download: DownloadProgress) => void,
  ): Promise<void> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let cursor = 0;
    let completed = 0;
    let verifiedBytes = 0;
    let transferredBytes = 0;
    let cachedBytes = 0;
    let lastReport = 0;
    let sampleTime = performance.now();
    let sampleBytes = 0;
    let speed = 0;
    let currentFile: string | null = null;
    const active = new Map<number, number>();
    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
    const publish = (force = false) => {
      const now = performance.now();
      if (!force && now - lastReport < 120) return;
      const elapsed = (now - sampleTime) / 1000;
      if (elapsed >= 0.2) {
        speed = (transferredBytes - sampleBytes) / elapsed;
        sampleTime = now;
        sampleBytes = transferredBytes;
      }
      lastReport = now;
      const completedBytes = Math.min(
        totalBytes,
        verifiedBytes + [...active.values()].reduce((a, b) => a + b, 0),
      );
      progress(completed, artifacts.length, {
        totalBytes,
        completedBytes,
        transferredBytes,
        cachedBytes,
        bytesPerSecond: active.size ? Math.round(speed) : 0,
        activeConnections: active.size,
        currentFile,
        etaSeconds:
          speed > 0 && completedBytes < totalBytes ? Math.ceil((totalBytes - completedBytes) / speed) : null,
      });
    };
    publish(true);
    const workers = Array.from({ length: Math.min(8, artifacts.length) }, async () => {
      while (cursor < artifacts.length) {
        const index = cursor++;
        const artifact = artifacts[index]!;
        try {
          let cached = false;
          await this.ensure(artifact, combined, (received, transferred, isCached) => {
            cached = isCached;
            if (!isCached) active.set(index, received);
            transferredBytes += transferred;
            currentFile = basename(artifact.path);
            publish();
          });
          active.delete(index);
          verifiedBytes += artifact.size;
          if (cached) cachedBytes += artifact.size;
          completed++;
          publish(true);
        } catch (error) {
          active.delete(index);
          controller.abort(error);
          throw error;
        }
      }
    });
    const result = await Promise.allSettled(workers);
    currentFile = null;
    publish(true);
    signal.throwIfAborted();
    const failed = result.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failed) throw controller.signal.reason ?? failed.reason;
  }
}
