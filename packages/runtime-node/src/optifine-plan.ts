import { ClassReader, ClassVisitor, Opcodes } from '@xmcl/asm';
import { generateOptifineVersion } from '@xmcl/installer';
import type { InstallManifest, InstallMaterializeOperation } from '@xmcl/installer';
import { MinecraftFolder } from '@xmcl/core';
import { open, readAllEntries, readEntry } from '@xmcl/unzip';
import { dirname } from 'node:path';
import { LauncherError } from '@hunaumcl/application';

/** Select legacy library or modern patcher installation, closing the archive before Windows commits. */
export async function optifinePlan(
  installer: string,
  folder: MinecraftFolder,
  options: { versionId: string; inheritsFrom: string; java: string; expected?: string },
): Promise<{ version: string; plan: InstallManifest }> {
  const zip = await open(installer);
  try {
    const entries = await readAllEntries(zip);
    const config = entries.find((entry) =>
      ['net/optifine/Config.class', 'Config.class', 'notch/net/optifine/Config.class'].includes(
        entry.fileName,
      ),
    );
    if (!config || config.uncompressedSize > 2 * 1024 * 1024 || entries.length > 50000)
      throw new LauncherError('OPTIFINE_CONFIG_INVALID', 'OptiFine 安装器元数据缺失或超出处理限制');
    const fields: Record<string, unknown> = {};
    class ConfigVisitor extends ClassVisitor {
      visitField(
        _access: number,
        name: string,
        _descriptor: string | null,
        _signature: string | null,
        value: unknown,
      ) {
        fields[name] = value;
        return null;
      }
    }
    new ClassReader(await readEntry(zip, config)).accept(new ConfigVisitor(Opcodes.ASM5));
    if (
      fields.MC_VERSION !== options.inheritsFrom ||
      typeof fields.OF_EDITION !== 'string' ||
      typeof fields.OF_RELEASE !== 'string'
    )
      throw new LauncherError('OPTIFINE_MC_MISMATCH', 'OptiFine 安装器中的 Minecraft 版本与所选版本不一致');
    const versionPart = `${fields.OF_EDITION}_${fields.OF_RELEASE}`;
    if (options.expected && versionPart !== options.expected)
      throw new LauncherError('OPTIFINE_VERSION_MISMATCH', 'OptiFine 文件中声明的高清修复版本与选择不一致');
    const versionEntry = entries.find((entry) => entry.fileName === 'launchwrapper-of.txt');
    const wrapper = versionEntry ? (await readEntry(zip, versionEntry)).toString('utf8').trim() : undefined;
    const version = generateOptifineVersion(versionPart, options.inheritsFrom, wrapper, options);
    const json = folder.getVersionJson(version.id);
    const operations: InstallMaterializeOperation[] = [
      { type: 'write', path: json, content: JSON.stringify(version, null, 2) },
    ];
    if (wrapper) {
      const entry = entries.find((entry) => entry.fileName === `launchwrapper-of-${wrapper}.jar`);
      if (!entry || entry.uncompressedSize > 8 * 1024 * 1024)
        throw new LauncherError('OPTIFINE_WRAPPER_MISSING', 'OptiFine 安装器缺少声明的 LaunchWrapper');
      operations.push({
        type: 'extract',
        archive: installer,
        entry: entry.fileName,
        path: folder.getLibraryByPath(`optifine/launchwrapper-of/${wrapper}/launchwrapper-of-${wrapper}.jar`),
      });
    }
    const output = folder.getLibraryByPath(
      `optifine/Optifine/${options.inheritsFrom}_${versionPart}/Optifine-${options.inheritsFrom}_${versionPart}.jar`,
    );
    operations.push({ type: 'ensure-directory', path: dirname(output) });
    // Before Minecraft 1.14 the downloaded jar is already the LaunchWrapper library.
    // These releases do not use the modern OptiFine patcher installation workflow.
    const legacy = /^1\.(\d+)(?:\.|$)/.exec(options.inheritsFrom);
    if (legacy && Number(legacy[1]) < 14) {
      operations.push({ type: 'copy', source: installer, path: output });
      return {
        version: version.id,
        plan: {
          schemaVersion: 1,
          tasks: [
            {
              id: 'optifine-legacy-profile',
              type: 'materialize',
              operations,
              outputs: [
                { path: json, validator: 'json' },
                { path: output, validator: 'zip' },
              ],
            },
          ],
        },
      };
    }
    return {
      version: version.id,
      plan: {
        schemaVersion: 1,
        tasks: [
          {
            id: 'optifine-profile',
            type: 'materialize',
            operations,
            outputs: [{ path: json, validator: 'json' }],
          },
          {
            id: 'optifine-patcher',
            type: 'java',
            strategies: [
              [
                {
                  executable: options.java,
                  args: [
                    '-cp',
                    installer,
                    'optifine.Patcher',
                    folder.getVersionJar(options.inheritsFrom),
                    installer,
                    output,
                  ],
                },
              ],
            ],
            outputs: [{ path: output, validator: 'zip' }],
          },
        ],
      },
    };
  } finally {
    zip.close();
  }
}
