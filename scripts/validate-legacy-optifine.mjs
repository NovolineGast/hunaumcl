import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Live integration check: downloads upstream files and starts Minecraft with local Java 8.
// Its data and offline identity stay inside a separate validation directory.
const require = createRequire(import.meta.url);
const root = resolve('.research/legacy-optifine-validation');
const artifacts = resolve('test-results');
const edition = process.env.HUNAUMCL_TEST_OPTIFINE ?? 'HD_U_G5';
await mkdir(artifacts, { recursive: true });
const desktop = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${join(root, 'electron')}`],
  env: { ...process.env, HUNAUMCL_DATA_DIR: root },
  timeout: 30000,
});
let invoke;
let latestActivity;
let desktopOutput = '';
desktop.process().stdout?.on('data', (chunk) => {
  desktopOutput = (desktopOutput + chunk).slice(-32000);
});
desktop.process().stderr?.on('data', (chunk) => {
  desktopOutput = (desktopOutput + chunk).slice(-32000);
});
try {
  const page = await desktop.firstWindow();
  invoke = (method, value) =>
    page.evaluate(
      async ({ method, value }) => {
        const result = await window.launcher[method](value);
        if (!result.ok) throw Error(JSON.stringify(result.error));
        return result.value;
      },
      { method, value },
    );
  const catalog = await invoke('componentCatalog', '1.12.2');
  assert(catalog.optifine.some((entry) => entry.id === edition));
  console.log(JSON.stringify({ stage: 'catalog', edition, errors: catalog.errors }));
  const components = {
    loader: 'vanilla',
    loaderVersion: null,
    optifine: edition,
    fabricApi: null,
    optifabric: null,
  };
  const name = `1.12.2 OptiFine ${edition} 实测`;
  let instance = (await invoke('listInstances')).find((item) => item.name === name);
  if (!instance) instance = await invoke('createInstance', { name, versionId: '1.12.2', components });
  const check = await invoke('checkLaunch', instance.id);
  assert.equal(check.recommendedJavaMajor, 8);
  assert.equal(check.status, 'compatible-java-found', 'This live check requires local Java 8');
  console.log(JSON.stringify({ stage: 'preflight', check }));
  const { taskId } = await invoke('install', instance.id);
  const deadline = Date.now() + 12 * 60_000;
  let complete = false;
  let last = '';
  while (Date.now() < deadline) {
    const task = (await invoke('activity')).tasks.find((item) => item.id === taskId);
    const state = `${task.state} ${task.stage} ${task.completed}/${task.total}`;
    if (state !== last) {
      console.log(JSON.stringify(task));
      last = state;
    }
    if (task.state === 'failed' || task.state === 'cancelled') throw Error(JSON.stringify(task));
    if (task.state === 'succeeded') {
      complete = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  assert(complete, 'Installation deadline exceeded');
  const receipt = JSON.parse(await readFile(join(root, 'instances', instance.id, 'install.json'), 'utf8'));
  assert.equal(receipt.components.optifine, edition);
  const runtime = join(root, receipt.runtime);
  const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');
  const installerName = catalog.optifine.find((entry) => entry.id === edition).preview
    ? `preview_OptiFine_1.12.2_${edition}.jar`
    : `OptiFine_1.12.2_${edition}.jar`;
  assert.equal(
    sha1(await readFile(join(runtime, 'installers', installerName))),
    sha1(
      await readFile(
        join(runtime, `libraries/optifine/Optifine/1.12.2_${edition}/Optifine-1.12.2_${edition}.jar`),
      ),
    ),
  );
  assert.equal(receipt.managedMods.length, 0);
  console.log(JSON.stringify({ stage: 'installed', profile: receipt.profileId }));
  if (!(await invoke('accounts')).accounts.length)
    await invoke('createAccount', { playerName: 'Legacy_Test' });
  const launch = await invoke('launchAccount', { instanceId: instance.id });
  const launchDeadline = Date.now() + 180000;
  let initializedAt;
  let activity;
  while (Date.now() < launchDeadline) {
    activity = await invoke('activity');
    latestActivity = activity;
    const task = activity.tasks.find((item) => item.id === launch.taskId);
    const session = activity.sessions.at(-1);
    if (task?.state === 'failed' || session?.state === 'failed' || session?.state === 'exited')
      throw Error(JSON.stringify(activity));
    if (
      session?.state === 'running' &&
      session.logs.some((line) => /\[OptiFine\].*OptiFine_1\.12\.2/.test(line.text)) &&
      session.logs.some((line) => /Sound engine started|Created:.*textures|Created:.*atlas/.test(line.text))
    ) {
      initializedAt ??= Date.now();
      if (Date.now() - initializedAt >= 15000) break;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  await writeFile(join(artifacts, `legacy-optifine-${edition}.json`), JSON.stringify(activity, null, 2));
  assert(
    initializedAt && activity.sessions.at(-1)?.state === 'running',
    'Missing OptiFine / renderer initialization evidence',
  );
  await invoke('stopSession', activity.sessions.at(-1).id);
  console.log(JSON.stringify({ stage: 'passed', minecraft: '1.12.2', edition, java: 8 }));
} catch (error) {
  if (invoke)
    await writeFile(
      join(artifacts, `legacy-optifine-${edition}-failure.json`),
      JSON.stringify(await invoke('activity').catch(() => latestActivity), null, 2),
    );
  await writeFile(join(artifacts, `legacy-optifine-${edition}-desktop.log`), desktopOutput);
  throw error;
} finally {
  await desktop.close();
}
