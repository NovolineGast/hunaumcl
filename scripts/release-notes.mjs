import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Build the automatically filled GitHub Release body for a version tag.
 * Requires RELEASE_TAG (for example v0.1.0), RELEASE_SHA256 (folder zip) and
 * RELEASE_SHA256_EXE (single-file exe).
 */
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = process.env.RELEASE_TAG ?? `v${version}`;
const repository = process.env.GITHUB_REPOSITORY ?? 'NovolineGast/hunaumcl';
const zipSha256 = process.env.RELEASE_SHA256 ?? '';
const exeSha256 = process.env.RELEASE_SHA256_EXE ?? '';

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let previous = '';
try {
  previous = git('describe', '--tags', '--abbrev=0', 'HEAD^');
} catch {
  previous = '';
}
let commits = [];
try {
  commits = git('log', '--no-merges', '--pretty=format:- %s (%h)', previous ? `${previous}..HEAD` : 'HEAD')
    .split('\n')
    .filter(Boolean);
} catch {
  commits = [];
}
if (!commits.length) commits = ['- 维护性更新'];

const compare = previous
  ? `https://github.com/${repository}/compare/${previous}...${tag}`
  : `https://github.com/${repository}/commits/${tag}`;

const archive = `HUNAUMCL-${version}-win32-x64.zip`;
const folder = `HUNAUMCL-${version}-win32-x64`;
const executable = `HUNAUMCL-${version}-portable-x64.exe`;
const body = [
  '## 单文件便携版（推荐）',
  '',
  `- 下载 \`${executable}\`，双击运行，不需要安装。`,
  '- 首次启动会自解压到临时目录；账号、实例和缓存保存在 exe 同级的 `profile/`。',
  exeSha256 ? `- SHA256：\`${exeSha256}\`` : '',
  '',
  '## 文件夹版',
  '',
  `- 下载 \`${archive}\`，解压后运行 \`${folder}/HUNAUMCL.exe\`（整个文件夹一起保留）。`,
  zipSha256 ? `- SHA256：\`${zipSha256}\`` : '',
  '',
  '- 两个版本都未签名；首次运行可能触发 SmartScreen（更多信息 → 仍要运行）。',
  '- 需要本机安装匹配的 Java：1.12.2 / Java 8、1.20.1 / Java 17、1.21.1 / Java 21。',
  '- Microsoft 正版登录需要自己的 Client ID，并已取得 Minecraft Java API 准入。',
  '',
  '## 更新内容',
  '',
  ...commits,
  '',
  `**完整变更**：${compare}`,
  '',
]
  .filter((line) => line !== undefined)
  .join('\n');

mkdirSync(join(root, 'release'), { recursive: true });
writeFileSync(join(root, 'release', 'RELEASE_NOTES.md'), `${body}\n`);
console.log(`release notes: v${version} (${previous ? `${previous}..${tag}` : 'initial'})`);
