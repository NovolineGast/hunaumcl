import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { recoverComponentTransactions } from '../packages/runtime-node/src/component-recovery';
const directories: string[] = [];
const hash = (text: string) => createHash('sha1').update(text).digest('hex');
afterEach(async () => {
  for (const root of directories.splice(0)) {
    const child = relative(tmpdir(), root);
    if (isAbsolute(child) || child.includes('..') || !child.startsWith('hunaumcl-recovery-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hunaumcl-recovery-'));
  directories.push(root);
  const transactionId = randomUUID();
  const instanceId = randomUUID();
  const txn = join(root, 'transactions', transactionId);
  const game = join(root, 'instances', instanceId, 'game', 'mods');
  await mkdir(game, { recursive: true });
  await mkdir(join(txn, 'mod-backup'), { recursive: true });
  await writeFile(join(txn, 'journal.json'), JSON.stringify({ transactionId, instanceId }));
  await writeFile(join(txn, 'mod-backup', 'old.jar'), 'old');
  const changes = [
    {
      target: `instances/${instanceId}/game/mods/old.jar`,
      backup: `transactions/${transactionId}/mod-backup/old.jar`,
      previousHash: hash('old'),
    },
    { target: `instances/${instanceId}/game/mods/new.jar`, installed: hash('new') },
  ];
  await writeFile(join(game, 'new.jar'), 'new');
  await writeFile(join(txn, 'mod-changes.json'), JSON.stringify({ state: 'pending', changes }));
  return { root, transactionId, instanceId, txn, game };
}
describe('interrupted component commit recovery', () => {
  it('restores old owned files and removes new owned files when receipt was not published', async () => {
    const f = await fixture();
    await recoverComponentTransactions(f.root);
    expect(await readFile(join(f.game, 'old.jar'), 'utf8')).toBe('old');
    await expect(readFile(join(f.game, 'new.jar'))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(f.txn, 'mod-changes.json'), 'utf8')).state).toBe('rolled-back');
    await recoverComponentTransactions(f.root);
    expect(await readFile(join(f.game, 'old.jar'), 'utf8')).toBe('old');
  });
  it('keeps the new files when the receipt already points at the transaction', async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, 'instances', f.instanceId, 'install.json'),
      JSON.stringify({ transactionId: f.transactionId }),
    );
    await recoverComponentTransactions(f.root);
    expect(await readFile(join(f.game, 'new.jar'), 'utf8')).toBe('new');
    expect(JSON.parse(await readFile(join(f.txn, 'mod-changes.json'), 'utf8')).state).toBe('complete');
  });
  it('preserves user edits and backups instead of overwriting a recovery conflict', async () => {
    const f = await fixture();
    await writeFile(join(f.game, 'new.jar'), 'user edited');
    await expect(recoverComponentTransactions(f.root)).rejects.toMatchObject({
      code: 'RECOVERY_MOD_CONFLICT',
    });
    expect(await readFile(join(f.game, 'new.jar'), 'utf8')).toBe('user edited');
    expect(await readFile(join(f.txn, 'mod-backup', 'old.jar'), 'utf8')).toBe('old');
  });
});
