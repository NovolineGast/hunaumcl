/** Protocol logic only: no Node, Electron or UI dependencies. */
export type GameOS = 'windows' | 'linux' | 'osx';
export interface RuleEnvironment {
  os: GameOS;
  osVersion: string;
  architecture: string;
  features: Readonly<Record<string, boolean>>;
}
export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; version?: string; arch?: string };
  features?: Record<string, boolean>;
}
export interface Library {
  name: string;
  rules?: Rule[];
  downloads?: {
    artifact?: { path: string; url: string; sha1?: string; size?: number };
    classifiers?: Record<string, { path: string; url: string }>;
  };
  natives?: Record<string, string>;
}
export interface VersionMetadata {
  [key: string]: unknown;
  id: string;
  mainClass: string;
  inheritsFrom?: string;
  javaVersion?: { majorVersion: number; component?: string };
  libraries: Library[];
}

export function evaluateRules(rules: readonly Rule[] | undefined, env: RuleEnvironment): boolean {
  if (rules === undefined) return true;
  let allowed = false;
  for (const rule of rules) {
    const matches =
      (!rule.os?.name || rule.os.name === env.os) &&
      (!rule.os?.version || matchesPattern(rule.os.version, env.osVersion)) &&
      (!rule.os?.arch || matchesPattern(rule.os.arch, env.architecture)) &&
      Object.entries(rule.features ?? {}).every(
        ([key, expected]) => (env.features[key] ?? false) === expected,
      );
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern.length > 256) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

export interface JavaCandidate {
  major: number;
  architecture: string;
}
export interface JavaConstraint {
  minMajor?: number;
  maxMajor?: number;
  compatibleMajors?: readonly number[];
}
export function matchesJava(java: JavaCandidate, requirement: JavaConstraint): boolean {
  return (
    (requirement.minMajor === undefined || java.major >= requirement.minMajor) &&
    (requirement.maxMajor === undefined || java.major <= requirement.maxMajor) &&
    (requirement.compatibleMajors === undefined || requirement.compatibleMajors.includes(java.major))
  );
}

/** Preflight prefers the exact declared Java major; higher majors need explicit policy. */
export function selectJava<T extends JavaCandidate>(
  candidates: readonly T[],
  major: number,
  architecture: string,
): T | undefined {
  return candidates.find((java) => java.major === major && java.architecture === architecture);
}

export function toGameOS(platform: string): GameOS {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    case 'linux':
      return 'linux';
    default:
      throw new Error('Unsupported desktop platform');
  }
}

export function toJavaArchitecture(architecture: string): string {
  return (
    ({ x64: 'amd64', ia32: 'x86', arm64: 'aarch64' } as Record<string, string>)[architecture] ?? architecture
  );
}

/** Modern Mojang manifests list several native architectures under the same OS rule. */
export function nativeLibraryArchitecture(name: string): string | undefined {
  const classifier = name.split(':')[3];
  if (!classifier || !/^natives-(?:windows|macos|osx|linux)(?:-(?:arm64|aarch64|x86|x64))?$/.test(classifier))
    return undefined;
  if (classifier.endsWith('-arm64') || classifier.endsWith('-aarch64')) return 'arm64';
  if (classifier.endsWith('-x86')) return 'ia32';
  return 'x64';
}

/** Detect every inheritance cycle before format-specific merge is implemented. */
export function inheritanceChain(
  id: string,
  versions: ReadonlyMap<string, Pick<VersionMetadata, 'id' | 'inheritsFrom'>>,
): string[] {
  const chain: string[] = [];
  let current: string | undefined = id;
  while (current) {
    if (chain.includes(current))
      throw new Error(`Version inheritance cycle: ${[...chain, current].join(' → ')}`);
    if (chain.length >= 64) throw new Error('Version inheritance exceeds 64 levels');
    const version = versions.get(current);
    if (!version) throw new Error(`Missing inherited version: ${current}`);
    chain.push(current);
    current = version.inheritsFrom;
  }
  return chain.reverse();
}
