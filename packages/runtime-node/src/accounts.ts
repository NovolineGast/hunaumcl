import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { playerNameSchema } from '@hunaumcl/contracts';
import type { AccountCollection, MicrosoftAccount } from '@hunaumcl/contracts';
import { LauncherError } from '@hunaumcl/application';
import type { AccountRepository } from '@hunaumcl/application';
import { atomicJSON } from './json-file';
import { offlineUUID } from './identity';
import { microsoftCredentialsSchema } from './account-credentials';
import type {
  CredentialProtector,
  MicrosoftAuthentication,
  MicrosoftCredentials,
} from './account-credentials';

const common = {
  id: z.string().uuid(),
  playerName: playerNameSchema,
  uuid: z.string().regex(/^[a-f0-9]{32}$/),
  createdAt: z.iso.datetime(),
};
const offlineSchema = z.object({ ...common, kind: z.literal('offline') }).strict();
const microsoftSchema = z
  .object({
    ...common,
    kind: z.literal('microsoft'),
    expiresAt: z.iso.datetime(),
    lastValidatedAt: z.iso.datetime(),
    needsReauthentication: z.boolean(),
    encryptedCredentials: z.string().min(1).max(200000),
  })
  .strict();
const storeSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    selectedId: z.string().uuid().nullable(),
    accounts: z.array(z.discriminatedUnion('kind', [offlineSchema, microsoftSchema])).max(64),
  })
  .strict()
  .superRefine((store, context) => {
    const offline = store.accounts.filter((a) => a.kind === 'offline');
    const microsoft = store.accounts.filter((a) => a.kind === 'microsoft');
    if (
      new Set(store.accounts.map((a) => a.id)).size !== store.accounts.length ||
      new Set(offline.map((a) => a.playerName.toLowerCase())).size !== offline.length ||
      new Set(microsoft.map((a) => a.uuid)).size !== microsoft.length ||
      (store.selectedId && !store.accounts.some((a) => a.id === store.selectedId)) ||
      offline.some((a) => a.uuid !== offlineUUID(a.playerName)) ||
      (store.schemaVersion === 1 && microsoft.length)
    )
      context.addIssue({ code: 'custom', message: 'Invalid account identities' });
  });
type StoredAccounts = z.infer<typeof storeSchema>;
function publicCollection(store: StoredAccounts): AccountCollection {
  return {
    selectedId: store.selectedId,
    accounts: store.accounts.map((account) => {
      if (account.kind === 'offline') return { ...account };
      const { encryptedCredentials: _credentials, ...summary } = account;
      return summary;
    }),
  };
}
export class FileAccountRepository implements AccountRepository {
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;
  constructor(
    root: string,
    private readonly protector?: CredentialProtector,
  ) {
    this.file = join(root, 'accounts.json');
  }
  secureStorageAvailable(): boolean {
    return this.protector?.available() ?? false;
  }
  private async read(): Promise<StoredAccounts> {
    try {
      return storeSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 2, accounts: [], selectedId: null };
      throw new LauncherError(
        'ACCOUNT_STORE_UNREADABLE',
        '账号记录无法读取，请保留 accounts.json 并检查文件或访问权限',
      );
    }
  }
  async list(): Promise<AccountCollection> {
    return publicCollection(await this.read());
  }
  private mutate(change: (store: StoredAccounts) => void, signal?: AbortSignal): Promise<AccountCollection> {
    const operation = this.queue.then(async () => {
      const store = await this.read();
      signal?.throwIfAborted();
      change(store);
      signal?.throwIfAborted();
      await atomicJSON(this.file, storeSchema.parse({ ...store, schemaVersion: 2 }));
      return publicCollection(store);
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private encrypt(credentials: MicrosoftCredentials): string {
    if (!this.secureStorageAvailable())
      throw new LauncherError(
        'SECURE_STORAGE_UNAVAILABLE',
        '系统凭据加密不可用，请解锁系统密钥环后重试微软登录',
      );
    try {
      return this.protector!.encrypt(JSON.stringify(microsoftCredentialsSchema.parse(credentials)));
    } catch {
      throw new LauncherError('CREDENTIAL_ENCRYPTION_FAILED', '无法加密微软凭据，请检查系统密钥环');
    }
  }
  private decrypt(value: string): MicrosoftCredentials {
    if (!this.secureStorageAvailable())
      throw new LauncherError('SECURE_STORAGE_UNAVAILABLE', '系统凭据加密不可用，请解锁系统密钥环');
    try {
      return microsoftCredentialsSchema.parse(JSON.parse(this.protector!.decrypt(value)));
    } catch {
      throw new LauncherError('CREDENTIAL_DECRYPTION_FAILED', '微软凭据无法解密，请重新登录此账号');
    }
  }
  create(playerName: string): Promise<AccountCollection> {
    const name = playerNameSchema.parse(playerName);
    return this.mutate((store) => {
      if (store.accounts.length >= 64) throw new LauncherError('ACCOUNT_LIMIT', '最多保存 64 个账号');
      if (
        store.accounts.some((a) => a.kind === 'offline' && a.playerName.toLowerCase() === name.toLowerCase())
      )
        throw new LauncherError('ACCOUNT_DUPLICATE', '这个离线玩家名称已存在');
      const id = randomUUID();
      store.accounts.push({
        id,
        playerName: name,
        uuid: offlineUUID(name),
        kind: 'offline',
        createdAt: new Date().toISOString(),
      });
      store.selectedId ??= id;
    });
  }
  update(id: string, playerName: string): Promise<AccountCollection> {
    const name = playerNameSchema.parse(playerName);
    return this.mutate((store) => {
      const account = store.accounts.find((a) => a.id === id);
      if (!account) throw new LauncherError('ACCOUNT_NOT_FOUND', '账号已不存在，请刷新账号列表');
      if (account.kind !== 'offline')
        throw new LauncherError('MICROSOFT_NAME_MANAGED', '微软账号名称由 Minecraft 档案提供，请在官网修改');
      if (
        store.accounts.some(
          (a) => a.id !== id && a.kind === 'offline' && a.playerName.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new LauncherError('ACCOUNT_DUPLICATE', '这个离线玩家名称已存在');
      Object.assign(account, { playerName: name, uuid: offlineUUID(name) });
    });
  }
  select(id: string): Promise<AccountCollection> {
    return this.mutate((store) => {
      if (!store.accounts.some((a) => a.id === id))
        throw new LauncherError('ACCOUNT_NOT_FOUND', '账号已不存在');
      store.selectedId = id;
    });
  }
  delete(id: string): Promise<AccountCollection> {
    return this.mutate((store) => {
      store.accounts = store.accounts.filter((a) => a.id !== id);
      if (store.selectedId === id) store.selectedId = store.accounts[0]?.id ?? null;
    });
  }
  async microsoft(id: string): Promise<{ account: MicrosoftAccount; credentials: MicrosoftCredentials }> {
    const stored = (await this.read()).accounts.find((a) => a.id === id);
    if (!stored || stored.kind !== 'microsoft')
      throw new LauncherError('ACCOUNT_NOT_FOUND', '微软账号已不存在');
    const { encryptedCredentials, ...account } = stored;
    return { account, credentials: this.decrypt(encryptedCredentials) };
  }
  saveMicrosoft(
    authentication: MicrosoftAuthentication,
    targetId?: string,
    signal?: AbortSignal,
  ): Promise<AccountCollection> {
    return this.mutate((store) => {
      const existing = targetId
        ? store.accounts.find((a) => a.id === targetId)
        : store.accounts.find((a) => a.kind === 'microsoft' && a.uuid === authentication.uuid);
      if (targetId && !existing)
        throw new LauncherError('ACCOUNT_NOT_FOUND', '账号已删除，本次登录结果未保存');
      if (existing && (existing.kind !== 'microsoft' || existing.uuid !== authentication.uuid))
        throw new LauncherError(
          'MICROSOFT_ACCOUNT_MISMATCH',
          '登录的微软账号与需要重新授权的游戏档案不一致，请选择原账号或添加新账号',
        );
      if (!existing && store.accounts.length >= 64)
        throw new LauncherError('ACCOUNT_LIMIT', '最多保存 64 个账号');
      const account = {
        id: existing?.id ?? randomUUID(),
        kind: 'microsoft' as const,
        playerName: authentication.playerName,
        uuid: authentication.uuid,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        expiresAt: authentication.expiresAt,
        lastValidatedAt: new Date().toISOString(),
        needsReauthentication: false,
        encryptedCredentials: this.encrypt(authentication.credentials),
      };
      if (existing) store.accounts[store.accounts.indexOf(existing)] = account;
      else store.accounts.push(account);
      if (!targetId) store.selectedId = account.id;
    }, signal);
  }
  rotateMicrosoft(id: string, refreshToken: string): Promise<AccountCollection> {
    return this.mutate((store) => {
      const account = store.accounts.find((a) => a.id === id);
      if (!account || account.kind !== 'microsoft')
        throw new LauncherError('ACCOUNT_NOT_FOUND', '账号已不存在');
      account.encryptedCredentials = this.encrypt({
        ...this.decrypt(account.encryptedCredentials),
        refreshToken,
      });
    });
  }
  markMicrosoftExpired(id: string): Promise<AccountCollection> {
    return this.mutate((store) => {
      const account = store.accounts.find((a) => a.id === id);
      if (account?.kind === 'microsoft') account.needsReauthentication = true;
    });
  }
}
