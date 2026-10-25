import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LauncherError } from '@hunaumcl/application';
import type { VersionProvider } from '@hunaumcl/application';
import type { VersionCatalog } from '@hunaumcl/contracts';
import type { VersionMetadata } from '@hunaumcl/domain';

const manifestSchema = z.object({
  latest: z.object({ release: z.string() }),
  versions: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      url: z.url(),
      sha1: z.string().regex(/^[a-f0-9]{40}$/),
      releaseTime: z.string(),
    }),
  ),
});
const ruleSchema = z.object({
  action: z.enum(['allow', 'disallow']),
  os: z
    .object({ name: z.string().optional(), version: z.string().optional(), arch: z.string().optional() })
    .optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});
const artifactSchema = z.object({
  path: z.string(),
  url: z.string(),
  sha1: z.string().optional(),
  size: z.number().optional(),
});
const metadataSchema = z
  .object({
    id: z.string(),
    mainClass: z.string(),
    inheritsFrom: z.string().optional(),
    javaVersion: z
      .object({ majorVersion: z.number().int().positive(), component: z.string().optional() })
      .optional(),
    libraries: z.array(
      z.object({
        name: z.string(),
        rules: z.array(ruleSchema).optional(),
        downloads: z
          .object({
            artifact: artifactSchema.optional(),
            classifiers: z.record(z.string(), artifactSchema).optional(),
          })
          .optional(),
        natives: z.record(z.string(), z.string()).optional(),
      }),
    ),
  })
  .passthrough();
type Manifest = z.infer<typeof manifestSchema>;
export type FetchMetadata = (url: string, init?: RequestInit) => Promise<Response>;

export class MojangVersionProvider implements VersionProvider {
  private manifest: Manifest | undefined;
  private fetchedAt = 0;
  private fetching: Promise<{ manifest: Manifest; cached: boolean }> | undefined;
  private readonly documents = new Map<string, VersionMetadata>();
  constructor(private readonly fetcher: FetchMetadata = (url, init) => globalThis.fetch(url, init)) {}

  private async readManifest(): Promise<{ manifest: Manifest; cached: boolean }> {
    if (this.manifest && Date.now() - this.fetchedAt < 5 * 60_000)
      return { manifest: this.manifest, cached: true };
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      try {
        const document = await this.read('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
        this.manifest = manifestSchema.parse(JSON.parse(document.toString('utf8')));
        this.fetchedAt = Date.now();
        return { manifest: this.manifest, cached: false };
      } catch {
        if (this.manifest) return { manifest: this.manifest, cached: true };
        throw new LauncherError('CATALOG_UNAVAILABLE', '暂时无法获取 Mojang 版本列表，请检查网络后重试');
      }
    })();
    try {
      return await this.fetching;
    } finally {
      this.fetching = undefined;
    }
  }

  async catalog(): Promise<VersionCatalog> {
    const { manifest, cached } = await this.readManifest();
    return {
      latestRelease: manifest.latest.release,
      releases: manifest.versions
        .filter((version) => version.type === 'release')
        .map(({ id, releaseTime }) => ({ id, releaseTime })),
      cached,
    };
  }

  async metadata(id: string): Promise<VersionMetadata> {
    const existing = this.documents.get(id);
    if (existing) return existing;
    const { manifest } = await this.readManifest();
    const entry = manifest.versions.find((version) => version.id === id && version.type === 'release');
    if (!entry) throw new LauncherError('VERSION_UNAVAILABLE', 'Mojang 列表中没有这个正式版本');
    const url = new URL(entry.url);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'piston-meta.mojang.com' ||
      url.port ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/v1/packages/')
    ) {
      throw new LauncherError('METADATA_SOURCE_INVALID', '版本描述文件的来源不符合预期');
    }
    try {
      const bytes = await this.read(url.href);
      if (createHash('sha1').update(bytes).digest('hex') !== entry.sha1)
        throw new LauncherError('METADATA_HASH_MISMATCH', '版本描述文件校验失败，请稍后重试');
      const metadata = metadataSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (metadata.id !== id) throw new LauncherError('METADATA_ID_MISMATCH', '版本描述与所选版本不一致');
      this.documents.set(id, metadata);
      return metadata;
    } catch (error) {
      if (error instanceof LauncherError) throw error;
      throw new LauncherError('METADATA_UNAVAILABLE', '无法读取这个版本的描述文件，请检查网络后重试');
    }
  }

  private async read(url: string): Promise<Buffer> {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { 'User-Agent': 'HUNAUMCL/0.1.0' },
    });
    if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
    const limit = 12 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Metadata too large');
    if (!response.body) throw new Error('Empty metadata response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('Metadata too large');
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  }
}
