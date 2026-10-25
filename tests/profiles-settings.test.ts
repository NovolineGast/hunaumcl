import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { FileAccountRepository } from '../packages/runtime-node/src/accounts';
import { FileInstanceRepository } from '../packages/runtime-node/src/instances';
import { defaultLaunchSettings, launchSettingsSchema } from '@hunaumcl/contracts';
import { LauncherService } from '@hunaumcl/application';
import type { ActivityService, InstanceRepository } from '@hunaumcl/application';

const folders: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'hunaumcl-profiles-'));
  folders.push(root);
  return root;
}
afterEach(async () => {
  for (const root of folders.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('hunaumcl-profiles-') || path.includes('..'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

describe('saved offline accounts', () => {
  it('serializes concurrent additions and persists selection across restart', async () => {
    const root = await directory();
    const store = new FileAccountRepository(root);
    await Promise.all(['Alpha', 'Bravo', 'Charlie'].map((name) => store.create(name)));
    const accounts = (await store.list()).accounts;
    await store.select(accounts[1]!.id);
    const reloaded = await new FileAccountRepository(root).list();
    expect(reloaded.accounts).toHaveLength(3);
    expect(reloaded.selectedId).toBe(accounts[1]!.id);
  });
  it('rejects duplicates and updates UUID only when the offline name changes', async () => {
    const store = new FileAccountRepository(await directory());
    const before = (await store.create('Steve')).accounts[0]!;
    await expect(store.create('steve')).rejects.toMatchObject({ code: 'ACCOUNT_DUPLICATE' });
    const after = (await store.update(before.id, 'Alex')).accounts[0]!;
    expect(after.id).toBe(before.id);
    expect(after.uuid).not.toBe(before.uuid);
    await store.delete(after.id);
    expect(await store.list()).toEqual({ selectedId: null, accounts: [] });
  });
  it('preserves corrupted or incompatible account storage instead of resetting it', async () => {
    const root = await directory();
    const raw = '{"schemaVersion":99,"accounts":[]}';
    await writeFile(join(root, 'accounts.json'), raw);
    await expect(new FileAccountRepository(root).create('Steve')).rejects.toMatchObject({
      code: 'ACCOUNT_STORE_UNREADABLE',
    });
    expect(await readFile(join(root, 'accounts.json'), 'utf8')).toBe(raw);
  });
});
describe('per-instance settings', () => {
  it('loads defaults for existing records and keeps changes isolated per instance', async () => {
    const root = await directory();
    const repository = new FileInstanceRepository(root);
    const first = await repository.create({ name: 'First', versionId: '1.21.1' });
    const second = await repository.create({ name: 'Second', versionId: '1.21.1' });
    const records = { ...JSON.parse(await readFile(join(root, 'instances.json'), 'utf8')) };
    for (const instance of records.instances) delete instance.settings;
    await writeFile(join(root, 'instances.json'), JSON.stringify(records));
    expect((await repository.list())[0]?.settings).toEqual(defaultLaunchSettings);
    await repository.update({
      instanceId: first.id,
      name: 'Renamed',
      settings: { ...defaultLaunchSettings, memoryMode: 'custom', memoryMiB: 3072, width: 1280, height: 720 },
    });
    const reloaded = await new FileInstanceRepository(root).list();
    expect(reloaded.find((instance) => instance.id === first.id)?.settings?.memoryMiB).toBe(3072);
    expect(reloaded.find((instance) => instance.id === second.id)?.settings).toEqual(defaultLaunchSettings);
  });
  it('rejects invalid dimensions and undeclared executable fields', () => {
    expect(launchSettingsSchema.safeParse({ ...defaultLaunchSettings, width: 0 }).success).toBe(false);
    expect(
      launchSettingsSchema.safeParse({ ...defaultLaunchSettings, javaExecutable: 'cmd.exe' }).success,
    ).toBe(false);
  });
  it('uses a bound account over the global selection and rejects deleted bindings', async () => {
    const root = await directory();
    const accounts = new FileAccountRepository(root);
    const instances = new FileInstanceRepository(root);
    const alpha = (await accounts.create('Alpha')).accounts[0]!;
    const bravo = (await accounts.create('Bravo')).accounts[1]!;
    const instance = await instances.create({ name: 'Bound', versionId: '1.21.1' });
    await instances.update({
      instanceId: instance.id,
      name: instance.name,
      settings: { ...defaultLaunchSettings, accountId: bravo.id },
    });
    let launchedAs = '';
    const activity: ActivityService = {
      snapshot: () => ({ tasks: [], sessions: [] }),
      start: (_kind, _instance, name) => {
        launchedAs = name!;
        return { taskId: 'test' };
      },
      cancel() {},
      async stop() {},
      async shutdown() {},
    };
    const service = new LauncherService(
      instances as InstanceRepository,
      {
        async catalog() {
          throw Error('unused');
        },
        async metadata() {
          throw Error('unused');
        },
      },
      { scan: async () => [] },
      { os: 'windows', architecture: 'x64', osVersion: '10', appVersion: 'test' },
      undefined,
      activity,
      accounts,
    );
    await service.launchAccount({ instanceId: instance.id });
    expect(launchedAs).toBe('Bravo');
    await service.launchAccount({ instanceId: instance.id, accountId: alpha.id });
    expect(launchedAs).toBe('Alpha');
    await accounts.delete(bravo.id);
    await expect(service.launchAccount({ instanceId: instance.id })).rejects.toMatchObject({
      code: 'ACCOUNT_REQUIRED',
    });
  });
});
