import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { LauncherError } from '@hunaumcl/application';
import type { RuntimeProgress } from '@hunaumcl/application';
import type { InstallFile } from '@xmcl/installer';
import { safeChild, validArtifact, VerifiedDownloader } from './downloads';
import type { DownloadArtifact } from './downloads';
import { fetchLoader as fetch, fetchIPv4 } from './loader-fetch';
import { atomicJSON } from './json-file';
import { readFile } from 'node:fs/promises';

type FileChecksum = { algorithm: 'sha1' | 'md5'; value: string };

const hosts = new Set([
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
  'maven.neoforged.net',
  'maven.fabricmc.net',
  'libraries.minecraft.net',
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
  'launcher.mojang.com',
  'launchermeta.mojang.com',
  'repo.spongepowered.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'maven.parchmentmc.org',
  'cdn.modrinth.com',
  'bmclapi2.bangbang93.com',
  'mirrors.cernet.edu.cn',
  'mirrors.tuna.tsinghua.edu.cn',
]);
export function loaderURL(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !hosts.has(parsed.hostname)
  )
    throw new LauncherError('LOADER_SOURCE_INVALID', `加载器声明了未受支持的来源：${parsed.hostname}`);
}
export function within(root: string, target: string): void {
  const child = relative(resolve(root), resolve(target));
  if (
    isAbsolute(child) ||
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
    throw new LauncherError('INSTALL_PATH_ESCAPE', '安装器文件路径超出本次事务目录');
}
export async function fileSHA1(path: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export class LoaderNetwork {
  async pinCDN(url: string, path: string, expectedSize: number): Promise<string> {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.hostname !== 'mediafilez.forgecdn.net' ||
      target.port ||
      target.username ||
      expectedSize > 32 * 1024 * 1024 ||
      expectedSize <= 0
    )
      throw new LauncherError('ADDON_SOURCE_INVALID', '附属模组来源或大小不符合预期');
    const temporary = `${path}.part`;
    await mkdir(dirname(path), { recursive: true });
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(90_000)]),
        redirect: 'error',
      });
      if (!response.ok || !response.body)
        throw new LauncherError('ADDON_DOWNLOAD_FAILED', '附属模组下载失败');
      const output = await open(temporary, 'w');
      let bytes = 0;
      const hash = createHash('sha1');
      try {
        for await (const chunk of response.body) {
          this.signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > expectedSize)
            throw new LauncherError('ADDON_SIZE_MISMATCH', '附属模组大小与目录不一致');
          hash.update(chunk);
          await output.writeFile(chunk);
        }
        if (bytes !== expectedSize) throw new LauncherError('ADDON_SIZE_MISMATCH', '附属模组下载不完整');
      } finally {
        await output.close();
      }
      await rename(temporary, path);
      return hash.digest('hex');
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private readonly allowed = new Set<string>();
  private readonly downloader = new VerifiedDownloader(
    (url, init) => this.downloadResponse(url, init),
    (url) => {
      if (!this.allowed.has(url)) loaderURL(url);
    },
  );
  private async downloadResponse(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      const digest = new URL(url).pathname.match(/(?:[a-f0-9]{40}|[a-f0-9]{32})(?![a-f0-9])/i)?.[0];
      if (!this.allowed.has(url) || !digest) throw error;
      let current = url;
      for (let hop = 0; hop < 6; hop++) {
        const response = await fetchIPv4(current, { ...init, redirect: 'manual' });
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400 && location) {
          const next = new URL(location, current);
          if (
            next.protocol !== 'https:' ||
            next.username ||
            next.password ||
            next.port ||
            !next.pathname.includes(digest) ||
            /^(localhost|127\.|10\.|192\.168\.|\[)/.test(next.hostname)
          )
            throw new LauncherError('MIRROR_REDIRECT_INVALID', '镜像重定向地址不符合内容 hash');
          this.allowed.add(next.href);
          current = next.href;
          continue;
        }
        if (!response.ok) throw error;
        return fetch(current, init);
      }
      throw error;
    }
  }
  constructor(
    private readonly signal: AbortSignal,
    private readonly shared?: string,
  ) {}
  private async head(
    url: string,
    expected?: FileChecksum,
  ): Promise<{ response: Response; url: string; checksum?: FileChecksum }> {
    loaderURL(url);
    let current = url;
    let checksum = expected;
    let contentHash: string | undefined;
    const bmcl = new URL(url).hostname === 'bmclapi2.bangbang93.com';
    for (let hop = 0; hop < 6; hop++) {
      const init: RequestInit = {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
        headers: { 'User-Agent': 'HUNAUMCL/0.1.0' },
      };
      let response: Response;
      if (!bmcl) {
        try {
          response = await fetch(current, { ...init, redirect: 'error' });
        } catch {
          response = await fetchIPv4(current, init);
        }
      } else response = await fetchIPv4(current, init);
      const digest = response.headers.get('x-bmclapi-hash');
      if (
        new URL(current).hostname === 'bmclapi2.bangbang93.com' &&
        digest &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{32})$/.test(digest)
      ) {
        contentHash = digest;
        checksum ??= { algorithm: digest.length === 40 ? 'sha1' : 'md5', value: digest };
      }
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        const next = new URL(response.headers.get('location')!, current);
        if (
          bmcl &&
          contentHash &&
          next.pathname.includes(contentHash) &&
          next.protocol === 'https:' &&
          !next.username &&
          !next.password &&
          !next.port &&
          !/^(localhost|127\.|10\.|192\.168\.|\[)/.test(next.hostname)
        )
          this.allowed.add(next.href);
        if (!this.allowed.has(next.href)) loaderURL(next.href);
        current = next.href;
        continue;
      }
      if (!response.ok)
        throw new LauncherError(
          'LOADER_DOWNLOAD_HTTP',
          `加载器文件请求失败（HTTP ${response.status}）：${new URL(url).hostname}${new URL(url).pathname}`,
        );
      return { response, url: current, checksum };
    }
    throw new LauncherError('LOADER_REDIRECT_LIMIT', '加载器下载重定向次数过多');
  }
  async artifact(file: InstallFile): Promise<DownloadArtifact> {
    const candidates = [...file.urls];
    for (const url of file.urls) {
      try {
        const parsed = new URL(url);
        if (
          [
            'maven.minecraftforge.net',
            'maven.neoforged.net',
            'maven.fabricmc.net',
            'libraries.minecraft.net',
          ].includes(parsed.hostname)
        ) {
          const path = parsed.pathname.replace(/^\/(?:releases\/|maven2\/)?/, '');
          candidates.push(`https://bmclapi2.bangbang93.com/maven/${path}`);
        }
      } catch {}
    }
    let failure: unknown;
    for (const source of [...new Set(candidates)].filter(Boolean)) {
      try {
        return await this.resolveArtifact({ ...file, urls: [source] });
      } catch (error) {
        this.signal.throwIfAborted();
        failure = error;
      }
    }
    throw failure ?? new LauncherError('GENERATED_FILE_MISSING', '加载器安装缺少必要文件，已停止安装');
  }
  private async resolveArtifact(file: InstallFile): Promise<DownloadArtifact> {
    const source = file.urls[0];
    if (!source)
      throw new LauncherError('GENERATED_FILE_MISSING', '加载器安装缺少必要文件，已停止安装');
    let checksum: FileChecksum | undefined =
      file.checksum?.algorithm === 'sha1' || file.checksum?.algorithm === 'md5'
        ? { algorithm: file.checksum.algorithm, value: file.checksum.value }
        : undefined;
    let url = source;
    let size = file.size;
    if (size === undefined || size < 0 || !checksum || new URL(url).hostname === 'bmclapi2.bangbang93.com') {
      const head = await this.head(source, checksum);
      url = head.url;
      checksum ??= head.checksum;
      if (size === undefined || size < 0) size = Number(head.response.headers.get('content-length') ?? -1);
    }
    if (!checksum) {
      loaderURL(source);
      const response = await fetch(`${source}.sha1`, {
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]),
        redirect: 'error',
      });
      const text = response.ok ? (await response.text()).trim() : '';
      const sha1 = text.match(/^[a-f0-9]{40}(?=\s|$)/i)?.[0]?.toLowerCase();
      if (sha1) checksum = { algorithm: 'sha1', value: sha1 };
    }
    if (!checksum || size === undefined || size < 0 || !Number.isSafeInteger(size))
      throw new LauncherError('LOADER_FILE_UNVERIFIABLE', '加载器文件缺少校验信息，已停止安装');
    const digest = checksum;
    const expectedSize = size;
    let firstRequest = true;
    return {
      url,
      path: file.path,
      ...(checksum.algorithm === 'sha1' ? { sha1: checksum.value } : { md5: checksum.value }),
      size,
      ...(new URL(source).hostname === 'bmclapi2.bangbang93.com'
        ? {
            resolveURL: async () => {
              if (firstRequest) {
                firstRequest = false;
                return url;
              }
              const fresh = await this.head(source, digest);
              if (Number(fresh.response.headers.get('content-length')) !== expectedSize)
                throw new LauncherError('MIRROR_FILE_CHANGED', '镜像文件大小发生变化，已停止下载');
              return fresh.url;
            },
          }
        : {}),
    };
  }
  async download(
    files: InstallFile[],
    workspace: string,
    shared: string,
    report: (progress: RuntimeProgress) => void,
  ): Promise<void> {
    const artifacts: DownloadArtifact[] = [];
    for (const file of files) {
      report({
        stage: '下载加载器文件',
        completed: artifacts.length,
        total: files.length,
      });
      this.signal.throwIfAborted();
      within(workspace, file.path);
      // Processor outputs are local artifacts. A valid existing output is handled by the plan executor.
      const artifact = await this.artifact(file);
      const local = relative(workspace, file.path).replaceAll('\\', '/');
      const cached = safeChild(shared, local);
      if (await validArtifact({ ...artifact, path: cached }, this.signal)) {
        await mkdir(dirname(file.path), { recursive: true });
        await copyFile(cached, file.path);
      }
      artifacts.push(artifact);
    }
    await this.downloader.batch(artifacts, this.signal, (completed, total, download) =>
      report({ stage: '下载加载器文件', completed, total, download }),
    );
  }
  async one(
    file: InstallFile,
    report: (progress: RuntimeProgress) => void,
    fallback?: () => Promise<DownloadArtifact>,
  ): Promise<DownloadArtifact> {
    const key = createHash('sha256')
      .update(file.urls[0] ?? '')
      .digest('hex');
    const record = this.shared ? safeChild(this.shared, `components/${key}.json`) : undefined;
    if (record) {
      try {
        const previous = JSON.parse(await readFile(record, 'utf8')) as { sha1: string; size: number };
        if (
          /^[a-f0-9]{40}$/.test(previous.sha1) &&
          Number.isSafeInteger(previous.size) &&
          (!file.checksum || file.checksum.value === previous.sha1)
        ) {
          const cached = safeChild(this.shared!, `components/${previous.sha1}.jar`);
          const artifact = { url: file.urls[0]!, path: cached, sha1: previous.sha1, size: previous.size };
          if (await validArtifact(artifact, this.signal)) {
            await mkdir(dirname(file.path), { recursive: true });
            await copyFile(cached, file.path);
            return { ...artifact, path: file.path };
          }
        }
      } catch {
        this.signal.throwIfAborted();
      }
    }
    const cache = async (artifact: DownloadArtifact) => {
      if (record) {
        // Historical sources may expose MD5; preserve the SHA-1 cache record format.
        const sha1 = artifact.sha1 ?? (await fileSHA1(file.path));
        const cached = safeChild(this.shared!, `components/${sha1}.jar`);
        await mkdir(dirname(cached), { recursive: true });
        await copyFile(file.path, cached);
        await atomicJSON(record, { sha1, size: artifact.size });
      }
      return artifact;
    };
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const artifact = await this.artifact(file);
        await this.downloader.batch([artifact], this.signal, (completed, total, download) =>
          report({ stage: '下载高清修复组件', completed, total, download }),
        );
        return await cache(artifact);
      } catch (error) {
        this.signal.throwIfAborted();
        failure = error;
        if (attempt === 0 && fallback) {
          try {
            return await cache(await fallback());
          } catch (fallbackError) {
            this.signal.throwIfAborted();
            failure = fallbackError;
          }
        }
        report({ stage: `下载源响应失败，正在重试（${attempt + 1}/3）`, completed: 0, total: 0 });
      }
    }
    throw failure;
  }
}
