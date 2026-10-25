import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir, totalmem } from 'node:os';
import { z } from 'zod';
import { generateArguments, LaunchPrecheck, MinecraftFolder, Version } from '@xmcl/core';
import type { ResolvedVersion } from '@xmcl/core';
import { LauncherError } from '@hunaumcl/application';
import type {
  ApplicationEnvironment,
  GameRuntime,
  GameSession,
  GameIdentity,
  RuntimeProgress,
  VersionProvider,
} from '@hunaumcl/application';
import type { InstanceSummary } from '@hunaumcl/contracts';
import { componentCompatibilityError, defaultLaunchSettings, vanillaComponents } from '@hunaumcl/contracts';
import type { InstanceComponents } from '@hunaumcl/contracts';
import { ComponentInstaller, composedReceiptSchema } from './component-install';
import { LoaderCatalogProvider } from './component-catalog';
import { gameDirectory } from './isolation';
import { resolveInstalledVersion } from './version-resolution';
import { fileSHA1 } from './loader-network';
import { atomicJSON } from './json-file';
import { offlineUUID } from './identity';
export { offlineUUID } from './identity';
import { evaluateRules, nativeLibraryArchitecture, selectJava, toJavaArchitecture } from '@hunaumcl/domain';
import type { Rule, VersionMetadata } from '@hunaumcl/domain';
import { LocalJavaProvider } from './java';
import { safeChild, VerifiedDownloader } from './downloads';
import type { DownloadArtifact } from './downloads';
import { javaArgumentFile, startGameProcess } from './process';

const downloadSchema = z.object({
  url: z.url(),
  sha1: z.string().regex(/^[a-f0-9]{40}$/),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024 * 1024),
});
const installMetadata = z
  .object({
    id: z.string(),
    mainClass: z.string(),
    javaVersion: z.object({ majorVersion: z.number().int().positive() }),
    arguments: z.object({ game: z.array(z.unknown()), jvm: z.array(z.unknown()) }).optional(),
    minecraftArguments: z.string().trim().min(1).optional(),
    downloads: z.object({ client: downloadSchema }),
    assetIndex: downloadSchema.extend({ id: z.string() }),
    libraries: z.array(z.unknown()),
  })
  .passthrough()
  .refine((metadata) => metadata.arguments !== undefined || metadata.minecraftArguments !== undefined);
const assetSchema = z.object({
  objects: z.record(
    z.string(),
    z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().nonnegative() }),
  ),
  virtual: z.boolean().optional(),
  map_to_resources: z.boolean().optional(),
});
const receiptSchema = z
  .object({ schemaVersion: z.literal(1), versionId: z.string(), sha256: z.string(), target: z.string() })
  .strict();
export function finalizeOfflineArguments(argv: readonly string[]): string[] {
  return finalizeLaunchArguments(argv);
}
export function finalizeLaunchArguments(argv: readonly string[], identity?: GameIdentity): string[] {
  const resolved = argv.map((argument) =>
    argument
      .replaceAll('${auth_xuid}', identity?.xuid ?? '')
      .replaceAll('${clientid}', identity?.clientId ?? ''),
  );
  if (resolved.some((argument) => /\$\{[^}]+\}/.test(argument)))
    throw new LauncherError('UNRESOLVED_ARGUMENT', '这个版本含未识别的启动参数，已停止启动');
  const userType = resolved.indexOf('--userType');
  if (identity && userType >= 0 && userType + 1 < resolved.length) resolved[userType + 1] = 'msa';
  return resolved;
}

/** Original Java Edition adapter with hash-verified Mojang metadata and both argument formats. */
export class VanillaGameRuntime implements GameRuntime {
  private readonly runningGames = new Set<string>();
  private readonly resources: string;
  constructor(
    private readonly root: string,
    private readonly versions: VersionProvider,
    private readonly java: LocalJavaProvider,
    private readonly host: ApplicationEnvironment,
    private readonly downloader = new VerifiedDownloader(),
    private readonly componentCatalog = new LoaderCatalogProvider(),
  ) {
    this.resources = join(root, 'shared');
  }
  private receipt(instance: InstanceSummary): string {
    return join(this.root, 'instances', instance.id, 'install.json');
  }
  private versionFile(instance: InstanceSummary): string {
    return safeChild(this.resources, `versions/${instance.versionId}/${instance.versionId}.json`);
  }
  private target(): string {
    return `${this.host.os}-${this.host.architecture}`;
  }
  async isInstalled(instance: InstanceSummary): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(this.receipt(instance), 'utf8'));
      const receipt = raw.schemaVersion === 2 ? composedReceiptSchema.parse(raw) : receiptSchema.parse(raw);
      return receipt.versionId === instance.versionId && receipt.target === this.target();
    } catch {
      return false;
    }
  }
  private resolve(metadata: VersionMetadata): ResolvedVersion {
    const valid = installMetadata.safeParse(metadata);
    if (!valid.success || metadata.inheritsFrom)
      throw new LauncherError(
        'VERSION_UNSUPPORTED',
        '原版描述缺少 Java 声明、可用启动参数或可校验的下载信息',
      );
    const environment = {
      os: this.host.os,
      osVersion: this.host.osVersion,
      architecture: toJavaArchitecture(this.host.architecture),
      features: {},
    };
    const filtered = {
      ...metadata,
      libraries: metadata.libraries.filter(
        (library) =>
          evaluateRules(library.rules, environment) &&
          (!nativeLibraryArchitecture(library.name) ||
            nativeLibraryArchitecture(library.name) === this.host.architecture),
      ),
    };
    const requiredNativeGroups = metadata.libraries
      .filter(
        (library) => evaluateRules(library.rules, environment) && nativeLibraryArchitecture(library.name),
      )
      .map((library) => library.name.split(':').slice(0, 3).join(':'));
    for (const group of new Set(requiredNativeGroups)) {
      if (
        !filtered.libraries.some(
          (library) =>
            library.name.startsWith(`${group}:`) &&
            nativeLibraryArchitecture(library.name) === this.host.architecture,
        )
      ) {
        throw new LauncherError(
          'NATIVE_ARCH_UNAVAILABLE',
          '这个版本缺少适用于当前电脑的运行文件，暂时无法启动',
        );
      }
    }
    if (this.host.architecture === 'arm64' && filtered.libraries.some((library) => library.natives)) {
      throw new LauncherError(
        'LEGACY_NATIVE_ARCH_UNSUPPORTED',
        '这个版本使用旧式本地库，当前暂不支持在 ARM64 电脑上启动',
      );
    }
    // Evaluate modern argument rules with our tested ordered-rule implementation first.
    const argumentsFor = (values: unknown[]): string[] =>
      values.flatMap((value) => {
        if (typeof value === 'string') return [value];
        const conditional = z
          .object({
            rules: z.array(z.unknown()).optional(),
            value: z.union([z.string(), z.array(z.string())]),
          })
          .parse(value);
        return evaluateRules(conditional.rules as Rule[] | undefined, environment)
          ? [conditional.value].flat()
          : [];
      });
    if (valid.data.arguments)
      Object.assign(filtered, {
        arguments: {
          jvm: argumentsFor(valid.data.arguments.jvm),
          game: argumentsFor(valid.data.arguments.game),
        },
      });
    // Keep minecraftArguments intact: XMCL supplies legacy JVM defaults, including the classpath
    // and native library directory. Creating an empty arguments object would suppress those defaults.
    const platform = {
      name: this.host.os,
      version: this.host.osVersion,
      arch: this.host.architecture === 'ia32' ? 'x86' : this.host.architecture,
    };
    const resolved = Version.resolve(this.resources, [
      Version.normalizeVersionJson(JSON.stringify(filtered), this.resources, platform),
    ]);
    if (resolved.libraries.length === 0)
      throw new LauncherError('VERSION_UNSUPPORTED', '这个版本缺少游戏文件信息，暂时无法启动');
    return resolved;
  }
  async installedComponents(instance: InstanceSummary): Promise<InstanceComponents | undefined> {
    try {
      const receipt = JSON.parse(await readFile(this.receipt(instance), 'utf8'));
      return receipt.schemaVersion === 2
        ? composedReceiptSchema.parse(receipt).components
        : { ...vanillaComponents };
    } catch {
      return undefined;
    }
  }
  async install(
    instance: InstanceSummary,
    report: (progress: RuntimeProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const components = instance.components ?? vanillaComponents;
    const targetDirectory = await gameDirectory(this.root, instance, components);
    if (this.runningGames.has(process.platform === 'win32' ? targetDirectory.toLowerCase() : targetDirectory))
      throw new LauncherError(
        'GAME_DIRECTORY_BUSY',
        '这个游戏目录仍被运行中的实例使用，请结束游戏后再安装组件',
      );
    const previous = await this.installedComponents(instance);
    const composed =
      components.loader !== 'vanilla' ||
      components.optifine !== null ||
      (previous !== undefined && (previous.loader !== 'vanilla' || previous.optifine !== null));
    await this.installBase(
      instance,
      (progress) => report({ ...progress, progress: (progress.progress ?? 0) * (composed ? 0.5 : 1) }),
      signal,
      !composed,
    );
    if (!composed) return;
    const base = this.resolve(await this.versions.metadata(instance.versionId));
    const settings = instance.settings ?? defaultLaunchSettings;
    const candidates = await this.java.scan();
    const selected = settings.javaId
      ? candidates.find(
          (candidate) =>
            candidate.id === settings.javaId &&
            candidate.major === base.javaVersion.majorVersion &&
            candidate.architecture === this.host.architecture,
        )
      : selectJava(candidates, base.javaVersion.majorVersion, this.host.architecture);
    const java = selected && this.java.executable(selected.id);
    if (!java)
      throw new LauncherError(
        'INSTALL_JAVA_REQUIRED',
        `加载器安装需要 Java ${base.javaVersion.majorVersion}，请先检测或指定兼容 Java`,
      );
    const installer = new ComponentInstaller(this.root, this.resources, this.componentCatalog, this.host);
    let lastProgress = 0.5;
    await installer.install(
      instance,
      base,
      java,
      (progress) => {
        lastProgress = Math.max(lastProgress, 0.5 + 0.5 * (progress.progress ?? 0.2));
        report({ ...progress, progress: lastProgress });
      },
      signal,
    );
  }
  private async installBase(
    instance: InstanceSummary,
    report: (progress: RuntimeProgress) => void,
    signal: AbortSignal,
    publishReceipt: boolean,
  ): Promise<void> {
    report({ stage: '获取游戏版本信息', completed: 0, total: 0, progress: 0 });
    const metadata = await this.versions.metadata(instance.versionId);
    signal.throwIfAborted();
    const version = this.resolve(metadata);
    const data = installMetadata.parse(metadata);
    const clientPath = safeChild(this.resources, `versions/${instance.versionId}/${instance.versionId}.jar`);
    const indexPath = safeChild(this.resources, `assets/indexes/${data.assetIndex.id}.json`);
    const artifacts: DownloadArtifact[] = [
      { ...data.downloads.client, path: clientPath },
      { ...data.assetIndex, path: indexPath },
    ];
    for (const library of version.libraries) {
      const download = downloadSchema.safeParse(library.download);
      if (!download.success)
        throw new LauncherError('UNVERIFIABLE_LIBRARY', '这个版本缺少文件校验信息，暂时无法安装');
      artifacts.push({
        ...download.data,
        path: safeChild(this.resources, `libraries/${library.download.path}`),
      });
    }
    for (const logging of Object.values(version.logging ?? {})) {
      artifacts.push({
        ...downloadSchema.parse(logging.file),
        path: safeChild(this.resources, `assets/log_configs/${logging.file.id}`),
      });
    }
    const unique = [...new Map(artifacts.map((artifact) => [artifact.path, artifact])).values()];
    await this.downloader.batch(unique, signal, (completed, total, download) =>
      report({
        stage: '下载游戏文件',
        completed,
        total,
        download,
        progress:
          0.03 +
          0.32 *
            (download.totalBytes
              ? download.completedBytes / download.totalBytes
              : completed / Math.max(total, 1)),
      }),
    );
    const assetIndex = assetSchema.parse(JSON.parse(await readFile(indexPath, 'utf8')));
    if (assetIndex.virtual || assetIndex.map_to_resources)
      throw new LauncherError('LEGACY_ASSETS_UNSUPPORTED', '这个版本暂不支持自动安装');
    const objects = Object.values(assetIndex.objects);
    if (objects.length > 100_000) throw new LauncherError('ASSETS_LIMIT', '这个版本的游戏资源数量超出处理上限');
    const assets = [...new Map(objects.map((object) => [object.hash, object])).values()].map((object) => ({
      url: `https://resources.download.minecraft.net/${object.hash.slice(0, 2)}/${object.hash}`,
      path: safeChild(this.resources, `assets/objects/${object.hash.slice(0, 2)}/${object.hash}`),
      sha1: object.hash,
      size: object.size,
    }));
    await this.downloader.batch(assets, signal, (completed, total, download) =>
      report({
        stage: '下载游戏资源',
        completed,
        total,
        download,
        progress:
          0.35 +
          0.63 *
            (download.totalBytes
              ? download.completedBytes / download.totalBytes
              : completed / Math.max(total, 1)),
      }),
    );
    signal.throwIfAborted();
    const text = JSON.stringify(metadata);
    await mkdir(join(this.resources, 'versions', instance.versionId), { recursive: true });
    await this.atomicWrite(this.versionFile(instance), text);
    if (publishReceipt)
      await this.atomicWrite(
        this.receipt(instance),
        JSON.stringify({
          schemaVersion: 1,
          versionId: instance.versionId,
          sha256: createHash('sha256').update(text).digest('hex'),
          target: this.target(),
        }),
      );
  }
  private async atomicWrite(path: string, text: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async launch(
    instance: InstanceSummary,
    playerName: string,
    report: (progress: RuntimeProgress) => void,
    signal: AbortSignal,
    identity?: GameIdentity,
  ): Promise<GameSession> {
    if (!(await this.isInstalled(instance)))
      throw new LauncherError('GAME_NOT_INSTALLED', '请先安装这个实例的游戏文件');
    report({ stage: '检查安装与 Java', completed: 0, total: 0 });
    const rawReceipt = JSON.parse(await readFile(this.receipt(instance), 'utf8'));
    let resourcePath = this.resources;
    let version: ResolvedVersion;
    let activeComponents: InstanceComponents = { ...vanillaComponents };
    if (rawReceipt.schemaVersion === 2) {
      const receipt = composedReceiptSchema.parse(rawReceipt);
      resourcePath = safeChild(this.root, receipt.runtime);
      const resolved = await resolveInstalledVersion(resourcePath, receipt.profileId, this.host);
      for (const [path, text] of Object.entries(resolved.documents))
        if (createHash('sha256').update(text).digest('hex') !== receipt.documents[path])
          throw new LauncherError('METADATA_CHANGED', '加载器配置已更新，请重新校验安装');
      version = resolved.version;
      activeComponents = receipt.components;
    } else {
      const receipt = receiptSchema.parse(rawReceipt);
      const raw = await readFile(this.versionFile(instance), 'utf8');
      if (createHash('sha256').update(raw).digest('hex') !== receipt.sha256)
        throw new LauncherError('METADATA_CHANGED', '本地版本文件已变化，请重新安装校验');
      version = this.resolve(JSON.parse(raw));
    }
    const compatibilityError = componentCompatibilityError(instance.versionId, activeComponents);
    if (compatibilityError) throw new LauncherError('COMPONENT_COMPATIBILITY', compatibilityError);
    const settings = instance.settings ?? defaultLaunchSettings;
    const candidates = await this.java.scan();
    const selected = settings.javaId
      ? candidates.find(
          (java) =>
            java.id === settings.javaId &&
            java.major === version.javaVersion.majorVersion &&
            java.architecture === this.host.architecture,
        )
      : selectJava(candidates, version.javaVersion.majorVersion, this.host.architecture);
    const executable = selected && this.java.executable(selected.id);
    if (!selected || !executable)
      throw new LauncherError(
        'JAVA_REQUIRED',
        `本机没有匹配的 Java ${version.javaVersion.majorVersion}，请安装后重新检测`,
      );
    const gamePath = await gameDirectory(this.root, instance, activeComponents);
    const gameKey = process.platform === 'win32' ? gamePath.toLowerCase() : gamePath;
    if (this.runningGames.has(gameKey))
      throw new LauncherError('GAME_DIRECTORY_BUSY', '另一个实例正在使用同一共享游戏目录，请先结束该游戏');
    if (rawReceipt.schemaVersion === 2) {
      const receipt = composedReceiptSchema.parse(rawReceipt);
      for (const mod of receipt.managedMods) {
        const target = safeChild(gamePath, `mods/${mod.name}`);
        const existing = await fileSHA1(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (existing && existing !== mod.sha1)
          throw new LauncherError(
            'MANAGED_MOD_CONFLICT',
            '当前游戏目录中存在同名不同内容的组件，已保留文件并停止启动',
          );
        if (!existing) {
          const source = safeChild(resourcePath, `installers/${mod.name}`);
          if ((await fileSHA1(source)) !== mod.sha1)
            throw new LauncherError('MANAGED_MOD_CHANGED', '组件文件校验失败，请重新安装');
          await mkdir(join(gamePath, 'mods'), { recursive: true });
          await copyFile(source, target);
        }
      }
      const location = relative(this.root, gamePath).replaceAll('\\', '/');
      if (
        receipt.managedMods.length &&
        location !== receipt.modDirectory &&
        !receipt.additionalModDirectories.includes(location)
      ) {
        receipt.additionalModDirectories.push(location);
        await atomicJSON(this.receipt(instance), receipt);
      }
    }
    const sessionRoot = join(this.root, 'sessions', randomUUID());
    const nativeRoot = join(sessionRoot, 'natives');
    await mkdir(nativeRoot, { recursive: true });
    const options = {
      version,
      gamePath,
      resourcePath,
      nativeRoot,
      javaPath: executable,
      accessToken: identity?.accessToken ?? '0',
      userType: identity ? ('mojang' as const) : ('legacy' as const),
      gameProfile: {
        name: identity?.playerName ?? playerName,
        id: identity?.uuid ?? offlineUUID(playerName),
      },
      launcherName: 'HUNAUMCL',
      launcherBrand: this.host.appVersion,
      maxMemory:
        settings.memoryMode === 'custom'
          ? settings.memoryMiB
          : Math.max(512, Math.min(2048, Math.floor(totalmem() / 1024 / 1024 / 3))),
      extraJVMArgs: [],
      resolution: settings.fullscreen
        ? { fullscreen: true }
        : { width: settings.width, height: settings.height },
      platform: { name: this.host.os, version: this.host.osVersion, arch: this.host.architecture },
    };
    signal.throwIfAborted();
    report({ stage: '准备游戏运行文件', completed: 0, total: 0 });
    const folder = MinecraftFolder.from(resourcePath);
    try {
      await LaunchPrecheck.checkVersion(folder, version, options);
      await LaunchPrecheck.checkLibraries(folder, version, options);
      await LaunchPrecheck.checkNatives(folder, version, options);
    } catch {
      throw new LauncherError('GAME_FILES_INVALID', '游戏文件准备失败，请点击「校验文件」后重试');
    }
    signal.throwIfAborted();
    const command = await generateArguments(options);
    const argv = finalizeLaunchArguments(command.slice(1), identity);
    if (this.host.os === 'osx' && !argv.includes('-XstartOnFirstThread'))
      argv.unshift('-XstartOnFirstThread');
    let launchArguments = argv;
    if (selected.major >= 9) {
      const argumentFile = join(sessionRoot, 'java.args');
      const mainClassIndex = argv.indexOf(version.mainClass);
      if (identity && mainClassIndex < 0)
        throw new LauncherError('MAIN_CLASS_UNRESOLVED', '无法定位游戏入口，已停止启动');
      // Keep access tokens out of the on-disk JVM argfile. Game arguments follow the main class.
      const jvmArguments = identity ? argv.slice(0, mainClassIndex + 1) : argv;
      await writeFile(argumentFile, javaArgumentFile(jvmArguments), { encoding: 'utf8', mode: 0o600 });
      launchArguments = [`@${argumentFile}`, ...(identity ? argv.slice(mainClassIndex + 1) : [])];
    } else if (this.host.os === 'windows' && argv.join(' ').length > 28_000)
      throw new LauncherError('COMMAND_TOO_LONG', '这个 Java 8 启动命令过长，请缩短启动器数据目录路径');
    signal.throwIfAborted();
    report({ stage: '启动游戏', completed: 0, total: 0 });
    this.runningGames.add(gameKey);
    try {
      const session = await startGameProcess(
        executable,
        launchArguments,
        gamePath,
        (text) =>
          (identity ? text.replaceAll(identity.accessToken, '[redacted]') : text)
            .replaceAll(this.root, '<data>')
            .replaceAll(this.root.replaceAll('\\', '/'), '<data>')
            .replaceAll(homedir(), '<user>')
            .replaceAll(homedir().replaceAll('\\', '/'), '<user>'),
        identity?.kind,
      );
      let listener: ((code: number | null) => void) | undefined;
      let exited = false;
      let exitCode: number | null = null;
      session.onExit((code) => {
        this.runningGames.delete(gameKey);
        exited = true;
        exitCode = code;
        listener?.(code);
      });
      return {
        stop: () => session.stop(),
        onLog: (handler) => session.onLog(handler),
        onExit: (handler) => {
          listener = handler;
          if (exited) handler(exitCode);
        },
      };
    } catch (error) {
      this.runningGames.delete(gameKey);
      throw error;
    }
  }
}
