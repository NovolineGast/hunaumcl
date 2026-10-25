import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LauncherError } from '@hunaumcl/application';
import type { RuntimeProgress } from '@hunaumcl/application';
import type { DownloadArtifact } from './downloads';
import { fetchLoader, fetchIPv4 } from './loader-fetch';

/** Official fallback; a BMCLAPI content digest still verifies the selected upstream file. */
export async function downloadOfficialOptifine(
  filename: string,
  mirrorSource: string,
  path: string,
  signal: AbortSignal,
  report: (progress: RuntimeProgress) => void,
): Promise<DownloadArtifact> {
  const source = new URL(mirrorSource);
  if (
    source.origin !== 'https://bmclapi2.bangbang93.com' ||
    !source.pathname.startsWith('/maven/com/optifine/') ||
    source.pathname.split('/').at(-1) !== filename ||
    !/^(?:preview_)?OptiFine_[A-Za-z0-9._-]+\.jar$/.test(filename)
  )
    throw new LauncherError('OPTIFINE_SOURCE_INVALID', 'OptiFine 文件来源与选择不一致');
  report({ stage: '下载源不可用，正在切换到官方源', completed: 0, total: 1 });
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  // Do not follow the mirror here: its trusted endpoint can supply the digest even if its node is down.
  const metadata = await fetchIPv4(source.href, {
    method: 'HEAD',
    redirect: 'manual',
    signal: requestSignal(),
  });
  const digest = metadata.headers.get('x-bmclapi-hash');
  if (
    (!metadata.ok && metadata.status !== 302 && metadata.status !== 307) ||
    !digest ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(digest)
  )
    throw new LauncherError('OPTIFINE_HASH_UNAVAILABLE', '无法获取 OptiFine 的来源校验值，请稍后重试');
  const page = await fetchLoader(`https://optifine.net/adloadx?f=${encodeURIComponent(filename)}`, {
    redirect: 'error',
    signal: requestSignal(),
    headers: { 'User-Agent': 'HUNAUMCL/0.1.0' },
  });
  if (!page.ok || !page.body)
    throw new LauncherError('OPTIFINE_OFFICIAL_HTTP', `OptiFine 官方下载页请求失败（HTTP ${page.status}）`);
  const chunks: Uint8Array[] = [];
  let pageSize = 0;
  for await (const chunk of page.body) {
    pageSize += chunk.byteLength;
    if (pageSize > 1024 * 1024)
      throw new LauncherError('OPTIFINE_PAGE_INVALID', 'OptiFine 官方下载页超出处理上限');
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const links = html.match(/\bdownloadx\?[^"'<>\s]+/g) ?? [];
  const url = links
    .map((link) => new URL(link.replaceAll('&amp;', '&'), 'https://optifine.net/'))
    .find(
      (link) =>
        link.pathname === '/downloadx' &&
        link.searchParams.get('f') === filename &&
        link.searchParams.has('x'),
    );
  if (!url) throw new LauncherError('OPTIFINE_PAGE_INVALID', '官方页面未提供所选 OptiFine 的下载链接');
  const response = await fetchLoader(url.href, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { 'User-Agent': 'HUNAUMCL/0.1.0', 'Accept-Encoding': 'identity' },
  });
  if (!response.ok || !response.body)
    throw new LauncherError('OPTIFINE_OFFICIAL_HTTP', `OptiFine 官方文件下载失败（HTTP ${response.status}）`);
  const declared = response.headers.get('content-length');
  const size = declared === null ? undefined : Number(declared);
  const limit = 32 * 1024 * 1024;
  if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > limit)) {
    await response.body.cancel();
    throw new LauncherError('OPTIFINE_SIZE_INVALID', 'OptiFine 官方文件大小异常');
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.part`;
  const hash = createHash(digest.length === 32 ? 'md5' : 'sha1');
  const sha1 = createHash('sha1');
  let bytes = 0;
  const started = performance.now();
  let lastReport = 0;
  try {
    const output = await open(temporary, 'wx');
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > (size ?? limit))
          throw new LauncherError('OPTIFINE_SIZE_INVALID', 'OptiFine 文件超过声明大小或处理上限');
        hash.update(chunk);
        sha1.update(chunk);
        await output.writeFile(chunk);
        const now = performance.now();
        if (now - lastReport >= 120) {
          lastReport = now;
          report({
            stage: '从官方源下载 OptiFine',
            completed: 0,
            total: 1,
            download: {
              totalBytes: size ?? 0,
              completedBytes: bytes,
              transferredBytes: bytes,
              cachedBytes: 0,
              bytesPerSecond: Math.round(bytes / Math.max((now - started) / 1000, 0.001)),
              etaSeconds: null,
              activeConnections: 1,
              currentFile: filename,
            },
          });
        }
      }
      if (!bytes || (size !== undefined && size !== bytes) || hash.digest('hex') !== digest)
        throw new LauncherError('DOWNLOAD_HASH_MISMATCH', 'OptiFine 官方文件与来源校验值不一致，已停止安装');
      await output.sync();
    } finally {
      await output.close();
    }
    signal.throwIfAborted();
    await rename(temporary, path);
    report({
      stage: 'OptiFine 下载完成',
      completed: 1,
      total: 1,
      download: {
        totalBytes: bytes,
        completedBytes: bytes,
        transferredBytes: bytes,
        cachedBytes: 0,
        bytesPerSecond: 0,
        etaSeconds: null,
        activeConnections: 0,
        currentFile: null,
      },
    });
    return { path, url: url.href, sha1: sha1.digest('hex'), size: bytes };
  } finally {
    await rm(temporary, { force: true });
  }
}
