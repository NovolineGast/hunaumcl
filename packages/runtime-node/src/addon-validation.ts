import { open, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import { parseVersionRange, parseSemanticVersion } from '@xmcl/semver';
import { LauncherError } from '@hunaumcl/application';
import { z } from 'zod';

export async function validateFabricAddon(
  path: string,
  expectedId: string,
  minecraft: string,
  loader: string,
): Promise<void> {
  const zip = await open(path, { lazyEntries: true, autoClose: false });
  try {
    let count = 0;
    for await (const entry of walkEntriesGenerator(zip)) {
      if (++count > 50_000) throw new LauncherError('ADDON_ARCHIVE_LIMIT', '附属模组条目过多');
      if (entry.fileName !== 'fabric.mod.json') continue;
      if (entry.uncompressedSize > 2 * 1024 * 1024)
        throw new LauncherError('ADDON_METADATA_LIMIT', '附属模组元数据过大');
      const metadata = z
        .object({
          id: z.string(),
          depends: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        })
        .parse(JSON.parse((await readEntry(zip, entry)).toString('utf8')));
      if (metadata.id !== expectedId)
        throw new LauncherError('ADDON_ID_MISMATCH', '下载的附属模组身份不符合目录记录');
      for (const [key, version] of [
        ['minecraft', minecraft],
        ['fabricloader', loader],
      ] as const) {
        const constraint = metadata.depends?.[key];
        if (constraint) {
          const ranges = typeof constraint === 'string' ? [constraint] : constraint;
          if (!ranges.some((range) => parseVersionRange(range).test(parseSemanticVersion(version))))
            throw new LauncherError(
              'ADDON_RUNTIME_INCOMPATIBLE',
              `${expectedId} 不兼容所选 ${key} ${version}，请调整加载器或附属组件版本`,
            );
        }
      }
      return;
    }
    throw new LauncherError('ADDON_METADATA_MISSING', '附属组件没有 Fabric 模组声明');
  } finally {
    zip.close();
  }
}
