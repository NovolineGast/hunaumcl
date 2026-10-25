import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { MinecraftFolder } from '@xmcl/core';
import type { ResolvedVersion } from '@xmcl/core';
import {
  createModernForgeInstallWorkflow,
  resolveFabricProfileInstallManifest,
  resolveForgeArtifactVersion,
  resolveForgeInstallerFile,
  resolveLibraryInstallFiles,
} from '@xmcl/installer';
import { componentsSchema, vanillaComponents } from '@hunaumcl/contracts';
import type { InstanceComponents, InstanceSummary } from '@hunaumcl/contracts';
import { LauncherError } from '@hunaumcl/application';
import type { ApplicationEnvironment, RuntimeProgress } from '@hunaumcl/application';
import { z } from 'zod';
import { LoaderCatalogProvider, neoProject } from './component-catalog';
import { LoaderPlanExecutor } from './loader-executor';
import { fileSHA1, within } from './loader-network';
import { safeChild } from './downloads';
import { resolveInstalledVersion } from './version-resolution';
import { atomicJSON } from './json-file';
import { gameDirectory } from './isolation';
import { validateFabricAddon } from './addon-validation';
import { rollbackModChanges } from './component-recovery';
import type { ModChange } from './component-recovery';
import { optifinePlan } from './optifine-plan';
import { downloadOfficialOptifine } from './optifine-download';

export const managedModSchema = z.object({ name: z.string(), sha1: z.string().regex(/^[a-f0-9]{40}$/) });
export const composedReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    versionId: z.string(),
    target: z.string(),
    components: componentsSchema,
    runtime: z.string(),
    profileId: z.string(),
    documents: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    managedMods: z.array(managedModSchema),
    modDirectory: z.string(),
    additionalModDirectories: z.array(z.string()).default([]),
    transactionId: z.string().uuid(),
  })
  .strict();
export type ComposedReceipt = z.infer<typeof composedReceiptSchema>;
export function componentsKey(components: InstanceComponents): string {
  return JSON.stringify(componentsSchema.parse(components));
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Mutable preparation lives under transactions; the receipt is the final publication point. */
export class ComponentInstaller {
  constructor(
    private readonly root: string,
    private readonly shared: string,
    private readonly catalog: LoaderCatalogProvider,
    private readonly host: ApplicationEnvironment,
  ) {}
  async install(
    instance: InstanceSummary,
    base: ResolvedVersion,
    java: string,
    report: (progress: RuntimeProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const components = instance.components ?? vanillaComponents;
    await this.catalog.validate(instance.versionId, components);
    const transactionId = randomUUID();
    const transaction = join(this.root, 'transactions', transactionId);
    const workspace = join(transaction, 'work');
    const runtimeRelative = `instances/${instance.id}/runtime/${transactionId}`;
    const committed = safeChild(this.root, runtimeRelative);
    const journal = join(transaction, 'journal.json');
    const receiptPath = join(this.root, 'instances', instance.id, 'install.json');
    const previousText = await readFile(receiptPath, 'utf8').catch(() => undefined);
    let previous: ComposedReceipt | undefined;
    try {
      previous = composedReceiptSchema.parse(JSON.parse(previousText ?? 'null'));
    } catch {
      /* A v1 receipt owns no add-on files. */
    }
    const state = {
      schemaVersion: 1,
      transactionId,
      instanceId: instance.id,
      components,
      state: 'preparing',
      startedAt: new Date().toISOString(),
    };
    await mkdir(workspace, { recursive: true });
    await atomicJSON(journal, state);
    const plan = new LoaderPlanExecutor(workspace, this.shared, java, report, signal);
    const profileId = `hunaumcl-${instance.id}-${createHash('sha256').update(componentsKey(components)).digest('hex').slice(0, 12)}`;
    const mods: { source: string; name: string; sha1: string }[] = [];
    let restoreMods: (() => Promise<void>) | undefined;
    try {
      report({ stage: '准备安装文件', completed: 0, total: 0, progress: 0.1 });
      const baseFiles = [
        `versions/${instance.versionId}/${instance.versionId}.json`,
        `versions/${instance.versionId}/${instance.versionId}.jar`,
        ...base.libraries.map((library) => `libraries/${library.download.path}`),
      ];
      for (const local of new Set(baseFiles)) {
        signal.throwIfAborted();
        const destination = safeChild(workspace, local);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(safeChild(this.shared, local), destination);
      }
      await symlink(
        join(this.shared, 'assets'),
        join(workspace, 'assets'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const folder = MinecraftFolder.from(workspace);
      const installOptions = {
        versionId: profileId,
        inheritsFrom: instance.versionId,
        java,
        signal,
        side: 'client' as const,
      };
      let finalProfile = instance.versionId;
      if (components.loader === 'fabric') {
        const response = await this.catalog.request(
          `https://meta.fabricmc.net/v2/versions/loader/${instance.versionId}/${components.loaderVersion}/profile/json`,
        );
        const resolved = resolveFabricProfileInstallManifest(await response.json(), {
          ...installOptions,
          minecraftVersion: instance.versionId,
          version: components.loaderVersion!,
          minecraft: folder,
        });
        await plan.execute(resolved.plan);
        finalProfile = resolved.version;
      } else if (components.loader === 'forge' || components.loader === 'neoforge') {
        const forge =
          components.loader === 'forge'
            ? this.catalog.forge(instance.versionId, components.loaderVersion!)
            : undefined;
        const artifactVersion = forge
          ? resolveForgeArtifactVersion(instance.versionId, forge.version)
          : components.loaderVersion!;
        const project = neoProject(instance.versionId);
        const neoPath = `net/neoforged/${project}/${components.loaderVersion}/${project}-${components.loaderVersion}-installer.jar`;
        const installer = forge
          ? resolveForgeInstallerFile(artifactVersion, forge.installer, folder, installOptions).file
          : {
              path: folder.getLibraryByPath(neoPath),
              urls: [`https://maven.neoforged.net/releases/${neoPath}`],
              validator: 'zip' as const,
            };
        const installed = await plan.workflow(
          createModernForgeInstallWorkflow({
            id: components.loader,
            minecraft: folder,
            minecraftVersion: instance.versionId,
            installer,
            artifactVersion,
            java,
            installOptions,
            side: 'client',
          }),
        );
        finalProfile = installed.version;
      }
      if (components.optifine) {
        const optifine = this.catalog.optifine(instance.versionId, components.optifine);
        const installerPath = safeChild(workspace, `installers/${optifine.filename}`);
        const mirrorSource = `https://bmclapi2.bangbang93.com/maven/com/optifine/${instance.versionId}/${optifine.filename}`;
        await plan.network.one(
          {
            path: installerPath,
            urls: [mirrorSource],
            validator: 'zip',
          },
          report,
          () => downloadOfficialOptifine(optifine.filename, mirrorSource, installerPath, signal, report),
        );
        const installed = await optifinePlan(installerPath, folder, {
          ...installOptions,
          expected: components.optifine,
        });
        if (components.loader === 'vanilla') {
          await plan.execute(installed.plan);
          finalProfile = installed.version;
        } else
          mods.push({ source: installerPath, name: optifine.filename, sha1: await fileSHA1(installerPath) });
      }
      for (const id of [components.fabricApi, components.optifabric])
        if (id) {
          const addon = this.catalog.addon(id);
          const file = addon.files.find((file) => file.primary) ?? addon.files[0];
          if (!file) throw new LauncherError('ADDON_HAS_NO_FILE', '附属组件没有可安装文件');
          const path = safeChild(workspace, `installers/${file.filename}`);
          let sha1 = file.hashes.sha1;
          if (sha1)
            await plan.network.one(
              {
                path,
                urls: [file.url],
                size: file.size,
                checksum: { algorithm: 'sha1', value: sha1 },
                validator: 'zip',
              },
              report,
            );
          else sha1 = await plan.network.pinCDN(file.url, path, file.size);
          await validateFabricAddon(
            path,
            id === components.optifabric ? 'optifabric' : 'fabric-api',
            instance.versionId,
            components.loaderVersion!,
          );
          mods.push({ source: path, name: file.filename, sha1 });
        }
      report({ stage: '整理版本文件', completed: 0, total: 0, progress: 0.85 });
      const resolved = await resolveInstalledVersion(workspace, finalProfile, this.host);
      await plan.execute({
        schemaVersion: 1,
        tasks: [
          {
            id: 'final-profile-libraries',
            type: 'files',
            files: resolveLibraryInstallFiles(resolved.version.libraries, folder, { signal }),
          },
        ],
      });
      signal.throwIfAborted();
      const documents = Object.fromEntries(
        Object.entries(resolved.documents).map(([path, text]) => [
          path,
          createHash('sha256').update(text).digest('hex'),
        ]),
      );
      // The workspace must no longer contain absolute transaction locations in published metadata.
      if (
        Object.values(resolved.documents).some(
          (text) => text.includes(workspace) || text.includes(workspace.replaceAll('\\', '/')),
        )
      )
        throw new LauncherError('INSTALL_ABSOLUTE_PATH', '加载器安装结果异常，已停止安装');
      const directory = await gameDirectory(this.root, instance, components);
      state.state = 'committing';
      await atomicJSON(journal, state);
      await mkdir(dirname(committed), { recursive: true });
      within(this.root, committed);
      within(this.root, workspace);
      await rename(workspace, committed);
      const moved = mods.map((mod) => ({ ...mod, source: join(committed, relative(workspace, mod.source)) }));
      restoreMods = await this.commitMods(moved, directory, previous, transaction);
      const receipt: ComposedReceipt = {
        schemaVersion: 2,
        versionId: instance.versionId,
        target: `${this.host.os}-${this.host.architecture}`,
        components,
        runtime: runtimeRelative,
        profileId: finalProfile,
        documents,
        managedMods: mods.map(({ name, sha1 }) => ({ name, sha1 })),
        modDirectory: relative(this.root, directory).replaceAll('\\', '/'),
        additionalModDirectories: [],
        transactionId,
      };
      await atomicJSON(receiptPath, receipt);
      await atomicJSON(join(transaction, 'mod-changes.json'), { state: 'complete', changes: [] }).catch(
        () => {},
      );
      state.state = 'complete';
      await atomicJSON(journal, state).catch(() => {});
      report({ stage: '加载器与高清修复安装完成', completed: 1, total: 1, progress: 1 });
    } catch (error) {
      if (restoreMods) await restoreMods();
      state.state = signal.aborted ? 'cancelled' : 'failed';
      await atomicJSON(journal, {
        ...state,
        error: error instanceof Error ? error.message.slice(0, 4000) : 'unknown',
      }).catch(() => {});
      if (signal.aborted || error instanceof LauncherError) throw error;
      throw new LauncherError(
        'COMPONENT_INSTALL_FAILED',
        '组件安装未完成，原启动配置仍保留；可在事务 journal.json / processors.log 中查看失败阶段',
      );
    }
  }
  private async commitMods(
    mods: { source: string; name: string; sha1: string }[],
    game: string,
    previous: ComposedReceipt | undefined,
    transaction: string,
  ): Promise<() => Promise<void>> {
    const changes: ModChange[] = [];
    const persist = () => atomicJSON(join(transaction, 'mod-changes.json'), { state: 'pending', changes });
    const rollback = async () => {
      await rollbackModChanges(this.root, changes);
      await atomicJSON(join(transaction, 'mod-changes.json'), { state: 'rolled-back', changes });
    };
    try {
      for (const oldDirectory of previous
        ? [previous.modDirectory, ...previous.additionalModDirectories]
        : [])
        for (const old of previous?.managedMods ?? []) {
          let sharedOwner = false;
          if (oldDirectory === 'games/shared') {
            const entries = await readdir(join(this.root, 'instances'), { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const otherPath = join(this.root, 'instances', entry.name, 'install.json');
              if (
                otherPath ===
                join(this.root, 'instances', previous!.runtime.split('/')[1] ?? '', 'install.json')
              )
                continue;
              try {
                const other = composedReceiptSchema.parse(JSON.parse(await readFile(otherPath, 'utf8')));
                if (
                  other.transactionId !== previous!.transactionId &&
                  [other.modDirectory, ...other.additionalModDirectories].includes(oldDirectory) &&
                  other.managedMods.some((mod) => mod.name === old.name && mod.sha1 === old.sha1)
                )
                  sharedOwner = true;
              } catch {}
            }
          }
          if (sharedOwner) continue;
          const target = safeChild(safeChild(this.root, oldDirectory), `mods/${old.name}`);
          if (!(await exists(target))) continue;
          if ((await fileSHA1(target)) !== old.sha1)
            throw new LauncherError(
              'MANAGED_MOD_CHANGED',
              '之前安装的组件文件已被修改，不能自动覆盖或删除，请先备份并处理该文件',
            );
          const backup = join(transaction, 'mod-backup', old.name);
          await mkdir(dirname(backup), { recursive: true });
          await copyFile(target, backup);
          changes.push({
            target: relative(this.root, target).replaceAll('\\', '/'),
            backup: relative(this.root, backup).replaceAll('\\', '/'),
            previousHash: old.sha1,
          });
          await persist();
          await rm(target);
        }
      for (const mod of mods) {
        const target = safeChild(game, `mods/${mod.name}`);
        if (await exists(target)) {
          if ((await fileSHA1(target)) !== mod.sha1)
            throw new LauncherError('MOD_FILE_CONFLICT', '模组目录中已有同名文件，已保留原文件');
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        changes.push({ target: relative(this.root, target).replaceAll('\\', '/'), installed: mod.sha1 });
        await persist();
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await copyFile(mod.source, temporary);
          if ((await fileSHA1(temporary)) !== mod.sha1)
            throw new LauncherError('MOD_COPY_FAILED', '组件写入校验失败，已停止安装');
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      await mkdir(join(game, 'mods'), { recursive: true });
      await mkdir(join(game, 'resourcepacks'), { recursive: true });
      return rollback;
    } catch (error) {
      await rollback();
      throw error;
    }
  }
}
