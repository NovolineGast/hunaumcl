import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { JavaProvider } from '@hunaumcl/application';
import type { JavaSummary } from '@hunaumcl/contracts';

const execute = promisify(execFile);
export function parseJavaProperties(output: string): Omit<JavaSummary, 'id'> | undefined {
  const property = (key: string): string | undefined =>
    output.match(new RegExp(`^\\s*${key.replaceAll('.', '\\.')}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();
  const version = property('java.version') ?? output.match(/(?:openjdk|java) version "([^"]+)"/)?.[1];
  const arch = property('os.arch');
  if (!version || !arch) return undefined;
  const parts = version.split(/[._+\-]/);
  const major = Number(parts[0] === '1' ? parts[1] : parts[0]);
  if (!Number.isSafeInteger(major) || major <= 0) return undefined;
  const architecture =
    ({ amd64: 'x64', x86_64: 'x64', aarch64: 'arm64', x86: 'ia32', i386: 'ia32' } as Record<string, string>)[
      arch
    ] ?? arch;
  return { version, major, architecture, vendor: property('java.vendor') ?? 'Java' };
}

export class LocalJavaProvider implements JavaProvider {
  private readonly executables = new Map<string, string>();
  executable(id: string): string | undefined {
    return this.executables.get(id);
  }
  private active: Promise<JavaSummary[]> | undefined;
  scan(): Promise<JavaSummary[]> {
    if (this.active) return this.active;
    this.active = this.scanInternal().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async scanInternal(): Promise<JavaSummary[]> {
    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    const candidates = new Set<string>();
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
      candidates.add(join(dir.replace(/^"|"$/g, ''), executable));
    if (process.env.JAVA_HOME) candidates.add(join(process.env.JAVA_HOME, 'bin', executable));
    const roots =
      process.platform === 'win32'
        ? ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft'].map((vendor) =>
            join(process.env.ProgramFiles ?? 'C:\\Program Files', vendor),
          )
        : process.platform === 'darwin'
          ? ['/Library/Java/JavaVirtualMachines', join(homedir(), 'Library/Java/JavaVirtualMachines')]
          : ['/usr/lib/jvm', '/usr/java', '/opt/java'];
    roots.push(join(homedir(), '.jdks'));
    await Promise.all(
      roots.map(async (root) => {
        try {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const home = join(root, entry.name);
            candidates.add(join(home, 'bin', executable));
            if (process.platform === 'darwin') candidates.add(join(home, 'Contents/Home/bin', executable));
          }
        } catch {
          /* A JVM vendor directory need not exist. */
        }
      }),
    );
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execute('/usr/libexec/java_home', [], {
          timeout: 3000,
          maxBuffer: 64 * 1024,
        });
        candidates.add(join(stdout.trim(), 'bin', executable));
      } catch {
        /* macOS may have no registered JVM. */
      }
    }
    const pending = [...candidates];
    const seen = new Set<string>();
    const results: JavaSummary[] = [];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (;;) {
          const candidate = pending.shift();
          if (!candidate) return;
          try {
            await access(candidate);
            const resolved = await realpath(candidate);
            const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const { stdout, stderr } = await execute(resolved, ['-XshowSettings:properties', '-version'], {
              timeout: 5000,
              maxBuffer: 256 * 1024,
              windowsHide: true,
              encoding: 'utf8',
            });
            const java = parseJavaProperties(`${stdout}\n${stderr}`);
            if (java) {
              const id = createHash('sha256').update(identity).digest('hex');
              this.executables.set(id, resolved);
              results.push({ id, ...java });
            }
          } catch {
            /* Missing, unusable or stalled Java installations are not candidates. */
          }
        }
      }),
    );
    return results.sort(
      (left, right) =>
        right.major - left.major || right.version.localeCompare(left.version, 'en', { numeric: true }),
    );
  }
}
