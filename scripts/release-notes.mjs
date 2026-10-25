import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Build the automatically filled GitHub Release body for a version tag.
 * Requires RELEASE_TAG (for example v0.1.0) and optionally RELEASE_SHA256.
 */
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = process.env.RELEASE_TAG ?? `v${version}`;
const repository = process.env.GITHUB_REPOSITORY ?? 'NovolineGast/hunaumcl';
const sha256 = process.env.RELEASE_SHA256 ?? '';

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
const body = [
  '## 下载与运行',
  '',
  `- 下载 \`${archive}\`，解压后运行 \`${folder}/HUNAUMCL.exe\`（整个文件夹一起保留）。`,
  '- Windows x64 便携版，未签名；首次运行可能触发 SmartScreen（更多信息 → 仍要运行）。',
  '- 需要本机安装匹配的 Java：1.12.2 / Java 8、1.20.1 / Java 17、1.21.1 / Java 21。',
  '- Microsoft 正版登录需要自己的 Client ID，并已取得 Minecraft Java API 准入。',
  '',
  sha256 ? `SHA256：\`${sha256}\`（另见附件 \`SHA256SUMS.txt\`）` : '',
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
