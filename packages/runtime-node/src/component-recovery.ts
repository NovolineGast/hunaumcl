import { copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJSON } from './json-file';
import { safeChild } from './downloads';
import { fileSHA1 } from './loader-network';
import { LauncherError } from '@hunaumcl/application';

export const modChangeSchema = z
  .object({
    target: z.string(),
    backup: z.string().optional(),
    previousHash: z.string().optional(),
    installed: z.string().optional(),
  })
  .strict();
export type ModChange = z.infer<typeof modChangeSchema>;
const journalSchema = z
  .object({ state: z.enum(['pending', 'rolled-back', 'complete']), changes: z.array(modChangeSchema) })
  .strict();
export async function rollbackModChanges(root: string, changes: ModChange[]): Promise<void> {
  for (const change of [...changes].reverse()) {
    const target = safeChild(root, change.target);
    const hash = await fileSHA1(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (change.installed) {
      if (hash === change.installed) await rm(target);
      else if (hash)
        throw new LauncherError(
          'RECOVERY_MOD_CONFLICT',
          '恢复安装时发现组件文件已被用户修改，已保留文件，请手动检查事务备份',
        );
    }
    if (change.backup) {
      if (hash && hash !== change.previousHash)
        throw new LauncherError(
          'RECOVERY_MOD_CONFLICT',
          '恢复安装时发现同名不同内容的文件，已保留文件及备份',
        );
      await copyFile(safeChild(root, change.backup), target);
    }
  }
}
export async function recoverComponentTransactions(root: string): Promise<void> {
  const entries = await readdir(join(root, 'transactions'), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
    const directory = join(root, 'transactions', entry.name);
    const file = join(directory, 'mod-changes.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const changes = journalSchema.parse(JSON.parse(raw));
    if (changes.state !== 'pending') continue;
    const journal = z
      .object({ instanceId: z.string().uuid(), transactionId: z.string().uuid() })
      .parse(JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')));
    const receipt = await readFile(join(root, 'instances', journal.instanceId, 'install.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (receipt?.transactionId === journal.transactionId) {
      await atomicJSON(file, { ...changes, state: 'complete' });
      continue;
    }
    await rollbackModChanges(root, changes.changes);
    await atomicJSON(file, { ...changes, state: 'rolled-back' });
  }
}
