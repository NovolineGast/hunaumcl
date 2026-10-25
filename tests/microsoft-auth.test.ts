import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { MicrosoftAuthProvider } from '../packages/runtime-node/src/microsoft-auth';
import { MicrosoftLoginManager } from '../packages/runtime-node/src/microsoft-login';
import { FileAccountRepository } from '../packages/runtime-node/src/accounts';
import type {
  CredentialProtector,
  MicrosoftAuthentication,
} from '../packages/runtime-node/src/account-credentials';

const clientId = 'a175e2a4-8808-4444-aaaa-0123456789ab';
const uuid = '0123456789abcdef0123456789abcdef';
const folders: string[] = [];
const protector = (): CredentialProtector => {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
};
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'hunaumcl-ms-'));
  folders.push(path);
  return path;
}
const authentication = (
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
): MicrosoftAuthentication => ({
  playerName: 'Online_Player',
  uuid,
  expiresAt,
  credentials: {
    clientId,
    refreshToken: 'private-refresh-token',
    accessToken: 'private-minecraft-token',
    xuid: '12345',
  },
});
function transport(
  overrides: {
    tokenErrors?: string[];
    xstsError?: number;
    owned?: boolean;
    profileStatus?: number;
    minecraftStatus?: number;
    minecraftBody?: unknown;
  } = {},
) {
  const pending = [...(overrides.tokenErrors ?? [])];
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/devicecode'))
      return response({
        device_code: 'private-device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://www.microsoft.com/link',
        expires_in: 900,
        interval: 5,
      });
    if (url.endsWith('/token')) {
      const data = new URLSearchParams(String(init?.body));
      expect(data.get('client_id')).toBe(clientId);
      expect(data.has('client_secret')).toBe(false);
      if (pending.length)
        return response({ error: pending.shift(), error_description: 'do-not-expose-server-secret' }, 400);
      return response({ access_token: 'private-oauth-token', refresh_token: 'rotated-refresh-token' });
    }
    if (url.includes('user.auth.xboxlive.com')) {
      expect(JSON.parse(String(init?.body)).Properties.RpsTicket).toBe('d=private-oauth-token');
      return response({ Token: 'private-xbox-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } });
    }
    if (url.includes('xsts.auth.xboxlive.com')) {
      if (overrides.xstsError)
        return response({ XErr: overrides.xstsError, Message: 'raw-sensitive-response' }, 401);
      return response({
        Token: 'private-xsts-token',
        DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '12345' }] },
      });
    }
    if (url.endsWith('/login_with_xbox')) {
      expect(JSON.parse(String(init?.body)).identityToken).toBe('XBL3.0 x=user-hash;private-xsts-token');
      return response(
        overrides.minecraftBody ?? { access_token: 'private-minecraft-token', expires_in: 3600 },
        overrides.minecraftStatus ?? 200,
      );
    }
    if (url.endsWith('/entitlements/mcstore')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-minecraft-token');
      return response({ items: overrides.owned === false ? [] : [{ name: 'game_minecraft' }] });
    }
    if (url.endsWith('/minecraft/profile'))
      return response({ id: uuid, name: 'Online_Player' }, overrides.profileStatus ?? 200);
    throw Error(`Unexpected test endpoint ${url}`);
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of folders.splice(0)) {
    const child = relative(tmpdir(), path);
    if (isAbsolute(child) || !child.startsWith('hunaumcl-ms-') || child.includes('..'))
      throw Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
describe('Microsoft device-code protocol', () => {
  it('honors polling intervals and slow_down, then completes Xbox, XSTS, ownership and profile checks', async () => {
    const fetcher = transport({ tokenErrors: ['authorization_pending', 'slow_down'] });
    let now = 1000;
    const waits: number[] = [];
    const provider = new MicrosoftAuthProvider(
      fetcher,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    const signal = new AbortController().signal;
    const device = await provider.device(clientId, signal);
    const oauth = await provider.poll(clientId, device, signal);
    const stages: string[] = [];
    const result = await provider.complete(oauth, clientId, signal, (stage) => stages.push(stage));
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(result.uuid).toBe(uuid);
    expect(result.credentials.xuid).toBe('12345');
    expect(result.credentials.refreshToken).toBe('rotated-refresh-token');
    expect(stages).toHaveLength(4);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it.each([
    [{ owned: false }, 'MINECRAFT_NOT_OWNED'],
    [{ profileStatus: 404 }, 'MINECRAFT_PROFILE_REQUIRED'],
    [{ minecraftStatus: 403 }, 'MINECRAFT_API_DENIED'],
    [{ xstsError: 2148916238 }, 'XBOX_XSTS_DENIED'],
  ] as const)(
    'reports actionable account/entitlement failures without including upstream secrets (%s)',
    async (options, code) => {
      const provider = new MicrosoftAuthProvider(transport(options));
      const error = await provider
        .complete(
          { access_token: 'private-oauth-token', refresh_token: 'refresh' },
          clientId,
          new AbortController().signal,
          () => {},
        )
        .catch((failure) => failure);
      expect(error).toMatchObject({ code });
      expect(error.message).not.toContain('raw-sensitive-response');
    },
  );
  it('distinguishes a rejected Client ID from other Minecraft 403 responses', async () => {
    const provider = new MicrosoftAuthProvider(
      transport({
        minecraftStatus: 403,
        minecraftBody: {
          path: '/authentication/login_with_xbox',
          errorType: 'FORBIDDEN',
          errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information',
        },
      }),
    );
    const error = await provider
      .complete(
        { access_token: 'private-oauth-token', refresh_token: 'refresh' },
        clientId,
        new AbortController().signal,
        () => {},
      )
      .catch((failure) => failure);
    expect(error).toMatchObject({ code: 'MINECRAFT_API_DENIED' });
    expect(error.message).toContain('mce-reviewappid');
    expect(error.message).not.toContain('for more information');
  });
  it('requires reauthentication for invalid_grant and does not expose error_description', async () => {
    const provider = new MicrosoftAuthProvider(transport({ tokenErrors: ['invalid_grant'] }));
    await expect(
      provider.refresh(clientId, 'private-refresh-token', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MICROSOFT_REAUTH_REQUIRED' });
  });
  it('turns AADSTS registration failures into concrete fixes without repeating the raw response', async () => {
    const deviceFailure = async (body: Record<string, unknown>) => {
      const provider = new MicrosoftAuthProvider(
        async () => new Response(JSON.stringify(body), { status: 400 }),
      );
      return provider.device(clientId, new AbortController().signal).catch((failure) => failure);
    };
    const wrongAudience = await deviceFailure({
      error: 'unauthorized_client',
      error_codes: [700016],
      error_description:
        "AADSTS700016: Application with identifier 'x' was not found in the directory 'consumers'. Trace ID: raw-trace",
    });
    expect(wrongAudience).toMatchObject({ code: 'MICROSOFT_AUTHORIZATION_FAILED' });
    expect(wrongAudience.message).toContain('受支持的帐户类型');
    expect(wrongAudience.message).toContain('AADSTS700016');
    expect(wrongAudience.message).not.toContain('raw-trace');
    const confidentialClient = await deviceFailure({
      error: 'invalid_client',
      error_description:
        "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.",
    });
    expect(confidentialClient.message).toContain('允许公共客户端流');
    expect(confidentialClient.message).toContain('AADSTS7000218');
    const unknown = await deviceFailure({
      error: 'invalid_client',
      error_codes: [7000999],
      error_description: 'AADSTS7000999: Other condition.',
    });
    expect(unknown.message).toContain('AADSTS7000999');
  });
  it('expires a code without polling beyond its deadline and rejects foreign verification pages', async () => {
    let now = 0;
    const fetcher = transport();
    const provider = new MicrosoftAuthProvider(
      fetcher,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    await expect(
      provider.poll(
        clientId,
        {
          deviceCode: 'secret',
          userCode: 'CODE',
          verificationUri: 'https://microsoft.com/link',
          expiresAt: 1000,
          interval: 5000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'MICROSOFT_CODE_EXPIRED' });
    expect(fetcher).not.toHaveBeenCalled();
    const foreign = new MicrosoftAuthProvider(
      async () =>
        new Response(
          JSON.stringify({
            device_code: 'private',
            user_code: 'CODE',
            verification_uri: 'https://example.com/login',
            expires_in: 900,
          }),
        ),
    );
    await expect(foreign.device(clientId, new AbortController().signal)).rejects.toMatchObject({
      code: 'MICROSOFT_RESPONSE_INVALID',
    });
  });
});
describe('encrypted Microsoft accounts', () => {
  it('migrates offline records, encrypts secrets, preserves IDs on relogin and exposes only public account metadata', async () => {
    const path = await root();
    const encryption = protector();
    const accounts = new FileAccountRepository(path, encryption);
    const offline = (await accounts.create('Offline_Player')).accounts[0]!;
    const before = JSON.parse(await readFile(join(path, 'accounts.json'), 'utf8'));
    before.schemaVersion = 1;
    await writeFile(join(path, 'accounts.json'), JSON.stringify(before));
    const saved = await accounts.saveMicrosoft(authentication());
    const microsoft = saved.accounts.find((a) => a.kind === 'microsoft')!;
    const again = await accounts.saveMicrosoft({ ...authentication(), playerName: 'Renamed_Player' });
    expect(again.accounts).toHaveLength(2);
    expect(again.accounts[1]!.id).toBe(microsoft.id);
    expect(again.accounts[0]!.id).toBe(offline.id);
    const disk = await readFile(join(path, 'accounts.json'), 'utf8');
    expect(disk).not.toContain('private-refresh-token');
    expect(disk).not.toContain('private-minecraft-token');
    expect(JSON.stringify(again)).not.toContain('encryptedCredentials');
    expect(
      (await new FileAccountRepository(path, encryption).microsoft(microsoft.id)).credentials.refreshToken,
    ).toBe('private-refresh-token');
    await expect(accounts.update(microsoft.id, 'Other_Player')).rejects.toMatchObject({
      code: 'MICROSOFT_NAME_MANAGED',
    });
    await accounts.delete(microsoft.id);
    await expect(accounts.microsoft(microsoft.id)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
  it('refuses plaintext fallback and preserves accounts when credentials cannot be decrypted', async () => {
    const path = await root();
    await expect(new FileAccountRepository(path).saveMicrosoft(authentication())).rejects.toMatchObject({
      code: 'SECURE_STORAGE_UNAVAILABLE',
    });
    const accounts = new FileAccountRepository(path, protector());
    const saved = await accounts.saveMicrosoft(authentication());
    const otherUser = new FileAccountRepository(path, protector());
    expect((await otherUser.list()).accounts).toHaveLength(1);
    await expect(otherUser.microsoft(saved.selectedId!)).rejects.toMatchObject({
      code: 'CREDENTIAL_DECRYPTION_FAILED',
    });
  });
});
describe('Microsoft login lifecycle', () => {
  it('persists configuration and completes a full login without exposing device or access tokens in status', async () => {
    vi.stubEnv('HUNAUMCL_MICROSOFT_CLIENT_ID', '');
    const path = await root();
    const accounts = new FileAccountRepository(path, protector());
    const provider = new MicrosoftAuthProvider(transport(), Date.now, async () => {});
    const manager = new MicrosoftLoginManager(path, accounts, provider);
    await expect(manager.start()).rejects.toMatchObject({ code: 'MICROSOFT_NOT_CONFIGURED' });
    await manager.configure({ clientId });
    expect((await new MicrosoftLoginManager(path, accounts).configuration()).clientId).toBe(clientId);
    await manager.start();
    await expect.poll(() => manager.snapshot()?.state).toBe('succeeded');
    const snapshot = JSON.stringify(manager.snapshot());
    expect(snapshot).not.toMatch(/private-|rotated-|deviceCode|accessToken|refreshToken/);
    expect((await accounts.list()).accounts[0]?.kind).toBe('microsoft');
    await manager.shutdown();
  });
  it('cancels pending authorization, blocks concurrent jobs and ignores stale browser/code actions', async () => {
    vi.stubEnv('HUNAUMCL_MICROSOFT_CLIENT_ID', clientId);
    const path = await root();
    const accounts = new FileAccountRepository(path, protector());
    const provider = new MicrosoftAuthProvider(
      transport(),
      Date.now,
      async (_ms, signal) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const manager = new MicrosoftLoginManager(path, accounts, provider);
    const login = await manager.start();
    await expect.poll(() => manager.snapshot()?.state).toBe('awaiting-authorization');
    expect(manager.authorization(login.id).code).toBe('ABCD-EFGH');
    expect(JSON.stringify(manager.snapshot())).not.toContain('private-device-code');
    await expect(manager.start()).rejects.toMatchObject({ code: 'MICROSOFT_BUSY' });
    manager.cancel(login.id);
    await expect.poll(() => manager.snapshot()?.state).toBe('cancelled');
    expect(() => manager.authorization(login.id)).toThrow('已不可用');
    expect((await accounts.list()).accounts).toHaveLength(0);
    await manager.shutdown();
  });
  it('refreshes expired Minecraft sessions, persists rotated refresh tokens and returns a server UUID for launch', async () => {
    const path = await root();
    const accounts = new FileAccountRepository(path, protector());
    const saved = await accounts.saveMicrosoft(authentication(new Date(Date.now() - 1000).toISOString()));
    const manager = new MicrosoftLoginManager(path, accounts, new MicrosoftAuthProvider(transport()));
    const identity = await manager.resolve(saved.selectedId!, new AbortController().signal, () => {});
    expect(identity).toMatchObject({
      uuid,
      kind: 'microsoft',
      accessToken: 'private-minecraft-token',
      clientId,
      xuid: '12345',
    });
    expect((await accounts.microsoft(saved.selectedId!)).credentials.refreshToken).toBe(
      'rotated-refresh-token',
    );
  });
  it('retains a rotated refresh token if downstream Xbox validation fails and marks revoked authorizations for relogin', async () => {
    const path = await root();
    const accounts = new FileAccountRepository(path, protector());
    const saved = await accounts.saveMicrosoft(authentication(new Date(0).toISOString()));
    const manager = new MicrosoftLoginManager(
      path,
      accounts,
      new MicrosoftAuthProvider(transport({ xstsError: 2148916238 })),
    );
    await expect(
      manager.resolve(saved.selectedId!, new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: 'XBOX_XSTS_DENIED' });
    expect((await accounts.microsoft(saved.selectedId!)).credentials.refreshToken).toBe(
      'rotated-refresh-token',
    );
    const revoked = new MicrosoftLoginManager(
      path,
      accounts,
      new MicrosoftAuthProvider(transport({ tokenErrors: ['invalid_grant'] })),
    );
    await expect(
      revoked.resolve(saved.selectedId!, new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: 'MICROSOFT_REAUTH_REQUIRED' });
    expect((await accounts.microsoft(saved.selectedId!)).account.needsReauthentication).toBe(true);
  });
  it('never resurrects a deleted target or replaces it with a different Microsoft player', async () => {
    const path = await root();
    const accounts = new FileAccountRepository(path, protector());
    const saved = await accounts.saveMicrosoft(authentication());
    const id = saved.selectedId!;
    await expect(
      accounts.saveMicrosoft({ ...authentication(), uuid: 'f'.repeat(32) }, id),
    ).rejects.toMatchObject({ code: 'MICROSOFT_ACCOUNT_MISMATCH' });
    await accounts.delete(id);
    await expect(accounts.saveMicrosoft(authentication(), id)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect((await accounts.list()).accounts).toHaveLength(0);
  });
});
