import { z } from 'zod';
import { getForgeVersionList } from '@xmcl/installer';
import type { ForgeVersion } from '@xmcl/installer';
import { componentCompatibilityError, componentsSchema } from '@hunaumcl/contracts';
import type { ComponentCatalog, ComponentVersion, InstanceComponents } from '@hunaumcl/contracts';
import { LauncherError } from '@hunaumcl/application';
import type { ComponentProvider } from '@hunaumcl/application';
import { fetchLoader } from './loader-fetch';

export const gameId = z.string().regex(/^[A-Za-z0-9._+\-]{1,80}$/);
const optifineSchema = z.object({
  mcversion: z.string(),
  type: z.string(),
  patch: z.string(),
  filename: z.string(),
  forge: z.string().nullable().optional(),
});
export type OptifineVersion = z.infer<typeof optifineSchema>;
const modSchema = z.object({
  id: z.string(),
  name: z.string(),
  version_number: z.string(),
  version_type: z.string(),
  game_versions: z.array(z.string()),
  loaders: z.array(z.string()),
  files: z.array(
    z.object({
      filename: z.string(),
      url: z.url(),
      size: z.number().int().nonnegative(),
      primary: z.boolean(),
      hashes: z.object({
        sha1: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
      }),
    }),
  ),
});
export type AddonVersion = z.infer<typeof modSchema>;
export function normalizeForgeRequirement(required: string | null | undefined): string | null {
  if (required == null) return null;
  const version = required
    .replace(/^Forge\s*/i, '')
    .replace(/^#\s*/, '')
    .trim();
  return /^N\/A$/i.test(version) ? null : version;
}
export function optifineForgeCompatible(required: string | null | undefined, selected: string): boolean {
  const version = normalizeForgeRequirement(required);
  if (version === null) return false;
  if (!version) return true;
  return version.includes('.') ? version === selected : selected.split('.').at(-1) === version;
}
export function neoProject(minecraft: string): 'forge' | 'neoforge' {
  return minecraft === '1.20.1' ? 'forge' : 'neoforge';
}
export class LoaderCatalogProvider implements ComponentProvider {
  private async bounded<T>(operation: Promise<T>, milliseconds = 20_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new LauncherError('COMPONENT_SOURCE_TIMEOUT', '组件源响应超时，请重试')),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private readonly cache = new Map<string, { at: number; result: ComponentCatalog }>();
  private readonly forges = new Map<string, ForgeVersion>();
  private readonly optics = new Map<string, OptifineVersion>();
  private readonly addons = new Map<string, AddonVersion>();
  constructor(private readonly fetcher: typeof fetch = fetchLoader) {}
  async request(url: string): Promise<Response> {
    let response: Response | undefined;
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.bounded(
          this.fetcher(url, {
            signal: AbortSignal.timeout(18_000),
            headers: { 'User-Agent': 'HUNAUMCL/0.1.0' },
            redirect: 'error',
          }),
        );
        break;
      } catch (error) {
        last = error;
      }
    }
    if (!response) throw last;
    if (!response.ok)
      throw new LauncherError('COMPONENT_CATALOG_HTTP', `组件目录请求失败（HTTP ${response.status}）`);
    const bytes = await this.bounded(response.arrayBuffer());
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new LauncherError('COMPONENT_CATALOG_TOO_LARGE', '组件目录超过处理上限');
    return new Response(bytes, { status: response.status, headers: response.headers });
  }
  async json(url: string): Promise<unknown> {
    return (await this.request(url)).json();
  }
  async catalog(minecraft: string): Promise<ComponentCatalog> {
    gameId.parse(minecraft);
    const cached = this.cache.get(minecraft);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.result;
    const result: ComponentCatalog = {
      minecraft,
      fabric: [],
      forge: [],
      neoforge: [],
      optifine: [],
      fabricApi: [],
      optifabric: [],
      errors: [],
    };
    const jobs: [string, () => Promise<void>][] = [
      [
        'Fabric',
        async () => {
          let data: unknown;
          try {
            data = await this.json(`https://meta.fabricmc.net/v2/versions/loader/${minecraft}`);
          } catch {
            data = await this.json(
              `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${minecraft}`,
            );
          }
          const entries = z
            .array(z.object({ loader: z.object({ version: z.string(), stable: z.boolean() }) }))
            .parse(data);
          result.fabric = entries.map(({ loader }) => ({
            id: loader.version,
            label: loader.version,
            recommended: loader.stable,
            preview: !loader.stable,
          }));
        },
      ],
      [
        'Forge',
        async () => {
          try {
            const list = await getForgeVersionList({ minecraft, fetch: (url) => this.request(url) });
            if (!list.versions.length) throw new Error('Empty Forge parser result');
            result.forge = list.versions.map((version) => {
              this.forges.set(`${minecraft}:${version.version}`, version);
              return {
                id: version.version,
                label: version.version,
                recommended: version.type === 'recommended',
              };
            });
          } catch {
            const entries = z
              .array(
                z.object({
                  version: z.string(),
                  mcversion: z.string(),
                  files: z.array(z.object({ category: z.string(), format: z.string(), hash: z.string() })),
                }),
              )
              .parse(await this.json(`https://bmclapi2.bangbang93.com/forge/minecraft/${minecraft}`));
            result.forge = entries
              .filter(
                (entry) =>
                  entry.mcversion === minecraft && entry.files.some((file) => file.category === 'installer'),
              )
              .map((entry) => {
                const checksum = entry.files.find((file) => file.category === 'installer')!.hash;
                const version: ForgeVersion = {
                  version: entry.version,
                  mcversion: minecraft,
                  type: 'common',
                  installer: {
                    md5: '',
                    sha1: checksum,
                    path: `${minecraft}-${entry.version}/forge-${minecraft}-${entry.version}-installer.jar`,
                  },
                  universal: { md5: '', sha1: '', path: '' },
                };
                this.forges.set(`${minecraft}:${entry.version}`, version);
                return { id: entry.version, label: entry.version };
              })
              .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
          }
        },
      ],
      [
        'NeoForge',
        async () => {
          const project = neoProject(minecraft);
          let versions: string[];
          try {
            versions = z
              .object({ versions: z.array(z.string()) })
              .parse(
                await this.json(
                  `https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/${project}`,
                ),
              ).versions;
          } catch {
            versions = z
              .object({ files: z.array(z.object({ name: z.string(), type: z.string() })) })
              .parse(
                await this.json(
                  `https://bmclapi2.bangbang93.com/neoforge/meta/api/maven/details/releases/net/neoforged/${project}`,
                ),
              )
              .files.filter((file) => file.type === 'DIRECTORY')
              .map((file) => file.name);
          }
          const prefix =
            minecraft === '1.20.1'
              ? '1.20.1-47.1.'
              : `${minecraft.replace(/^1\./, '')}${minecraft === '1.21' ? '.0' : ''}.`;
          result.neoforge = versions
            .filter((version) => version.startsWith(prefix))
            .reverse()
            .map((id) => ({ id, label: id, preview: /alpha|beta/.test(id) }));
        },
      ],
      [
        'OptiFine',
        async () => {
          const entries = z
            .array(optifineSchema)
            .parse(await this.json(`https://bmclapi2.bangbang93.com/optifine/${minecraft}`));
          result.optifine = entries
            .filter((entry) => entry.mcversion === minecraft)
            .map((entry) => {
              const id = `${entry.type}_${entry.patch}`;
              this.optics.set(`${minecraft}:${id}`, entry);
              return {
                id,
                label: id,
                preview: entry.filename.startsWith('preview_'),
                requiredForge: normalizeForgeRequirement(entry.forge),
              };
            })
            .sort(
              (a, b) =>
                Number(a.preview) - Number(b.preview) || b.id.localeCompare(a.id, 'en', { numeric: true }),
            );
        },
      ],
      ...(['fabric-api', 'optifabric'] as const).map(
        (project) =>
          [
            project,
            async () => {
              if (project === 'optifabric') {
                const entries = z
                  .object({
                    files: z.array(
                      z.object({
                        id: z.number().int(),
                        display: z.string(),
                        name: z.string(),
                        type: z.string(),
                        filesize: z.number().int(),
                        versions: z.array(z.string()),
                      }),
                    ),
                  })
                  .parse(await this.json('https://api.cfwidget.com/322385'));
                result.optifabric = entries.files
                  .filter((file) => file.versions.includes(minecraft) && file.versions.includes('Fabric'))
                  .map((file) => {
                    const id = `cf${file.id}`;
                    this.addons.set(id, {
                      id,
                      name: file.display,
                      version_number: file.display,
                      version_type: file.type,
                      game_versions: file.versions,
                      loaders: ['fabric'],
                      files: [
                        {
                          filename: file.name,
                          url: `https://mediafilez.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${file.name}`,
                          size: file.filesize,
                          primary: true,
                          hashes: {},
                        },
                      ],
                    });
                    return { id, label: file.display, preview: file.type !== 'release' };
                  });
                return;
              }
              const query = new URLSearchParams({
                game_versions: JSON.stringify([minecraft]),
                loaders: JSON.stringify(['fabric']),
              });
              const entries = z
                .array(modSchema)
                .parse(await this.json(`https://api.modrinth.com/v2/project/${project}/version?${query}`));
              const versions: ComponentVersion[] = [];
              for (const entry of entries)
                if (entry.game_versions.includes(minecraft) && entry.loaders.includes('fabric')) {
                  this.addons.set(entry.id, entry);
                  versions.push({
                    id: entry.id,
                    label: entry.version_number,
                    preview: entry.version_type !== 'release',
                  });
                }
              result[project === 'fabric-api' ? 'fabricApi' : 'optifabric'] = versions;
            },
          ] as [string, () => Promise<void>],
      ),
    ];
    await Promise.all(
      jobs.map(async ([label, run]) => {
        try {
          await run();
        } catch {
          result.errors.push(`${label} 列表获取失败，可重试；该组件未列出的版本不能安装`);
        }
      }),
    );
    this.cache.set(minecraft, { at: result.errors.length ? Date.now() - 285_000 : Date.now(), result });
    return result;
  }
  async validate(minecraft: string, input: InstanceComponents): Promise<void> {
    const components = componentsSchema.parse(input);
    const compatibilityError = componentCompatibilityError(minecraft, components);
    if (compatibilityError) throw new LauncherError('COMPONENT_COMPATIBILITY', compatibilityError);
    if (components.loader === 'vanilla' && !components.optifine) return;
    const catalog = await this.catalog(minecraft);
    if (
      components.loader !== 'vanilla' &&
      !catalog[components.loader].some((version) => version.id === components.loaderVersion)
    )
      throw new LauncherError('LOADER_VERSION_UNAVAILABLE', '所选加载器版本不在当前游戏版本的目录中');
    if (components.optifine) {
      const optifine = catalog.optifine.find((version) => version.id === components.optifine);
      if (!optifine)
        throw new LauncherError('OPTIFINE_UNAVAILABLE', '所选 OptiFine 不适用于当前 Minecraft 版本');
      if (
        components.loader === 'forge' &&
        !optifineForgeCompatible(optifine.requiredForge, components.loaderVersion!)
      )
        throw new LauncherError(
          'OPTIFINE_FORGE_INCOMPATIBLE',
          `此 OptiFine 需要匹配的 Forge ${optifine.requiredForge ?? '（未声明兼容）'}，不能忽略版本要求`,
        );
    }
    for (const key of ['fabricApi', 'optifabric'] as const)
      if (components[key] && !catalog[key].some((version) => version.id === components[key]))
        throw new LauncherError('ADDON_UNAVAILABLE', '所选 Fabric API / OptiFabric 不适用于当前版本');
  }
  forge(minecraft: string, version: string): ForgeVersion {
    const entry = this.forges.get(`${minecraft}:${version}`);
    if (!entry) throw new LauncherError('FORGE_NOT_IN_CATALOG', 'Forge 目录已失效，请刷新组件列表');
    return entry;
  }
  optifine(minecraft: string, id: string): OptifineVersion {
    const entry = this.optics.get(`${minecraft}:${id}`);
    if (!entry) throw new LauncherError('OPTIFINE_NOT_IN_CATALOG', 'OptiFine 目录已失效，请刷新组件列表');
    return entry;
  }
  addon(id: string): AddonVersion {
    const entry = this.addons.get(id);
    if (!entry) throw new LauncherError('ADDON_NOT_IN_CATALOG', '附属组件目录已失效，请刷新组件列表');
    return entry;
  }
}
