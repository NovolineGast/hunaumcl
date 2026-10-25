import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultLaunchSettings, vanillaComponents } from '@hunaumcl/contracts';
import type { InstanceComponents, InstanceSummary } from '@hunaumcl/contracts';
export async function gameDirectory(
  root: string,
  instance: InstanceSummary,
  components: InstanceComponents = instance.components ?? vanillaComponents,
): Promise<string> {
  const independent = join(root, 'instances', instance.id, 'game');
  const mode = (instance.settings ?? defaultLaunchSettings).isolation;
  let isolated = mode !== 'shared';
  if (mode === 'auto') {
    const existing = await Promise.all(
      ['mods', 'saves'].map(async (folder) => {
        try {
          return (await readdir(join(independent, folder))).length > 0;
        } catch {
          return false;
        }
      }),
    );
    isolated = components.loader !== 'vanilla' || existing.some(Boolean);
  }
  const directory = isolated ? independent : join(root, 'games', 'shared');
  await mkdir(directory, { recursive: true });
  return directory;
}
