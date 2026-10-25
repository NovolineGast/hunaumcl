import { readFile } from 'node:fs/promises';
import { Version } from '@xmcl/core';
import type { ResolvedVersion } from '@xmcl/core';
import { LauncherError } from '@hunaumcl/application';
import type { ApplicationEnvironment } from '@hunaumcl/application';
import { evaluateRules, nativeLibraryArchitecture, toJavaArchitecture } from '@hunaumcl/domain';
import type { Rule, VersionMetadata } from '@hunaumcl/domain';
import { safeChild } from './downloads';

export async function resolveInstalledVersion(
  root: string,
  id: string,
  host: ApplicationEnvironment,
): Promise<{ version: ResolvedVersion; documents: Record<string, string> }> {
  const chain: VersionMetadata[] = [];
  const documents: Record<string, string> = {};
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current) {
    if (seen.has(current) || seen.size >= 64)
      throw new LauncherError('VERSION_INHERITANCE_CYCLE', '检测到循环或过深的版本继承，已停止启动');
    seen.add(current);
    const path = `versions/${current}/${current}.json`;
    const text = await readFile(safeChild(root, path), 'utf8');
    const document = JSON.parse(text) as VersionMetadata;
    if (document.id !== current) throw new LauncherError('VERSION_ID_MISMATCH', '继承版本 ID 与目录不一致');
    documents[path] = text;
    chain.push(document);
    current = document.inheritsFrom;
  }
  const env = {
    os: host.os,
    osVersion: host.osVersion,
    architecture: toJavaArchitecture(host.architecture),
    features: {},
  };
  const platform = {
    name: host.os,
    version: host.osVersion,
    arch: host.architecture === 'ia32' ? 'x86' : host.architecture,
  };
  const normalized = chain.map((document) => {
    const copy = structuredClone(document);
    copy.libraries = (copy.libraries ?? []).filter(
      (library) =>
        evaluateRules(library.rules, env) &&
        (!nativeLibraryArchitecture(library.name) ||
          nativeLibraryArchitecture(library.name) === host.architecture),
    );
    if (copy.arguments) {
      const arguments_ = copy.arguments as { game?: unknown[]; jvm?: unknown[] };
      const flatten = (args: unknown[] = []) =>
        args.flatMap((argument) => {
          if (typeof argument === 'string') return [argument];
          const conditional = argument as { rules?: Rule[]; value: string | string[] };
          return evaluateRules(conditional.rules, env) ? [conditional.value].flat() : [];
        });
      copy.arguments = { game: flatten(arguments_.game), jvm: flatten(arguments_.jvm) };
    }
    return Version.normalizeVersionJson(JSON.stringify(copy), root, platform);
  });
  return { version: Version.resolve(root, normalized), documents };
}
