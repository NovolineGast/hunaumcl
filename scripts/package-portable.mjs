import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/** Assemble a self-contained Windows portable build from the built out/ directory. */
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

if (process.platform !== 'win32') {
  console.error('portable packaging currently supports Windows only');
  process.exit(1);
}

const out = join(root, 'out');
for (const required of ['main/index.cjs', 'preload/index.cjs', 'renderer/index.html']) {
  if (!existsSync(join(out, required))) {
    console.error(`missing out/${required}; run "npm run build" first`);
    process.exit(1);
  }
}

const electron = join(root, 'node_modules', 'electron', 'dist');
if (!existsSync(join(electron, 'electron.exe'))) {
  console.error('electron runtime not found; run "npm ci" first');
  process.exit(1);
}

const target = join(root, 'release', `HUNAUMCL-${version}-win32-x64`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(electron, target, { recursive: true });
renameSync(join(target, 'electron.exe'), join(target, 'HUNAUMCL.exe'));
rmSync(join(target, 'resources', 'default_app.asar'), { force: true });

// Keep the Chromium locales the launcher can actually use; drop the rest to reduce size.
const locales = join(target, 'locales');
if (existsSync(locales)) {
  const keep = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
  for (const name of readdirSync(locales)) {
    if (!keep.has(name)) rmSync(join(locales, name), { force: true });
  }
}

const app = join(target, 'resources', 'app');
mkdirSync(app, { recursive: true });
cpSync(out, join(app, 'out'), { recursive: true });
cpSync(join(root, 'node_modules', 'zod'), join(app, 'node_modules', 'zod'), { recursive: true });
writeFileSync(
  join(app, 'package.json'),
  `${JSON.stringify(
    {
      name: 'hunaumcl',
      productName: 'HUNAUMCL',
      version,
      description: pkg.description,
      main: 'out/main/index.cjs',
    },
    null,
    2,
  )}\n`,
);

const directorySize = (dir) => {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    total += info.isDirectory() ? directorySize(path) : info.size;
  }
  return total;
};
const total = directorySize(target);
console.log(`portable build: ${target}`);
console.log(`size: ${(total / 1024 / 1024).toFixed(1)} MiB`);
