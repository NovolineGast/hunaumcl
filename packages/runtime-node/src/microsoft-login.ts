import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { microsoftConfigSchema } from '@hunaumcl/contracts';
import type { MicrosoftConfiguration, MicrosoftLoginSnapshot } from '@hunaumcl/contracts';
import { LauncherError } from '@hunaumcl/application';
import type { GameIdentity, IdentityProvider, RuntimeProgress } from '@hunaumcl/application';
import { FileAccountRepository } from './accounts';
import { MicrosoftAuthProvider } from './microsoft-auth';
import { atomicJSON } from './json-file';

const active = (session?: MicrosoftLoginSnapshot) =>
  session && ['requesting', 'awaiting-authorization', 'authenticating', 'saving'].includes(session.state);
export class MicrosoftLoginManager implements IdentityProvider {
  private readonly file: string;
  private session?: MicrosoftLoginSnapshot;
  private controller?: AbortController;
  private done: Promise<void> = Promise.resolve();
  private refreshing = false;
  private closed = false;
  constructor(
    root: string,
    private readonly accounts: FileAccountRepository,
    private readonly provider = new MicrosoftAuthProvider(),
  ) {
    this.file = join(root, 'microsoft.json');
  }
  async configuration(): Promise<MicrosoftConfiguration> {
    let clientId = process.env.HUNAUMCL_MICROSOFT_CLIENT_ID?.trim() ?? '';
    let source: MicrosoftConfiguration['source'] = clientId ? 'environment' : 'unconfigured';
    if (!clientId) {
      try {
        clientId = microsoftConfigSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).clientId;
        source = 'local';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new LauncherError(
            'MICROSOFT_CONFIG_INVALID',
            '微软登录配置无法读取，请检查 microsoft.json 中的 Client ID',
          );
      }
    }
    if (clientId && !microsoftConfigSchema.safeParse({ clientId }).success)
      throw new LauncherError('MICROSOFT_CONFIG_INVALID', '配置的 Microsoft Client ID 格式无效');
    return { clientId, source, secureStorageAvailable: this.accounts.secureStorageAvailable() };
  }
  async configure(input: { clientId: string }): Promise<MicrosoftConfiguration> {
    if (active(this.session) || this.refreshing)
      throw new LauncherError('MICROSOFT_BUSY', '请先完成或取消正在进行的微软验证');
    if (process.env.HUNAUMCL_MICROSOFT_CLIENT_ID?.trim())
      throw new LauncherError(
        'MICROSOFT_CONFIG_ENVIRONMENT',
        '当前 Client ID 来自环境变量，请修改环境变量后重启启动器',
      );
    await atomicJSON(this.file, microsoftConfigSchema.parse(input));
    return this.configuration();
  }
  snapshot(): MicrosoftLoginSnapshot | null {
    return this.session ? structuredClone(this.session) : null;
  }
  async start(targetId?: string): Promise<MicrosoftLoginSnapshot> {
    if (this.closed) throw new LauncherError('SHUTTING_DOWN', '启动器正在退出');
    if (active(this.session) || this.refreshing)
      throw new LauncherError('MICROSOFT_BUSY', '已有微软验证正在进行，请先完成或取消');
    const config = await this.configuration();
    if (!config.clientId)
      throw new LauncherError(
        'MICROSOFT_NOT_CONFIGURED',
        '请先在 Microsoft 登录设置中填写 HUNAUMCL 的 Client ID',
      );
    if (!config.secureStorageAvailable)
      throw new LauncherError('SECURE_STORAGE_UNAVAILABLE', '系统凭据加密不可用，请解锁系统密钥环后再登录');
    if (
      targetId &&
      !(await this.accounts.list()).accounts.some((a) => a.id === targetId && a.kind === 'microsoft')
    )
      throw new LauncherError('ACCOUNT_NOT_FOUND', '需要重新登录的微软账号已不存在');
    // Recheck after I/O so concurrent IPC requests cannot start two device-code jobs.
    if (this.closed) throw new LauncherError('SHUTTING_DOWN', '启动器正在退出');
    if (active(this.session) || this.refreshing)
      throw new LauncherError('MICROSOFT_BUSY', '已有微软验证正在进行');
    const session: MicrosoftLoginSnapshot = {
      id: randomUUID(),
      state: 'requesting',
      stage: '正在获取微软登录代码',
      accountId: targetId,
    };
    this.session = session;
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    this.done = (async () => {
      try {
        const device = await this.provider.device(config.clientId, signal);
        Object.assign(session, {
          state: 'awaiting-authorization',
          stage: '请在微软网页输入代码并完成授权',
          userCode: device.userCode,
          verificationUri: device.verificationUri,
          expiresAt: new Date(device.expiresAt).toISOString(),
        });
        const oauth = await this.provider.poll(config.clientId, device, signal);
        session.state = 'authenticating';
        const authentication = await this.provider.complete(oauth, config.clientId, signal, (stage) => {
          session.stage = stage;
        });
        signal.throwIfAborted();
        session.state = 'saving';
        session.stage = '正在加密保存游戏账号';
        const collection = await this.accounts.saveMicrosoft(authentication, targetId, signal);
        session.accountId = collection.accounts.find(
          (a) => a.kind === 'microsoft' && a.uuid === authentication.uuid,
        )?.id;
        session.state = 'succeeded';
        session.stage = `已登录 ${authentication.playerName}`;
      } catch (error) {
        if (signal.aborted) {
          session.state = 'cancelled';
          session.stage = '已取消微软登录';
        } else {
          const failure =
            error instanceof LauncherError
              ? error
              : new LauncherError('MICROSOFT_LOGIN_FAILED', '微软登录未完成，请重试');
          session.state = failure.code === 'MICROSOFT_CODE_EXPIRED' ? 'expired' : 'failed';
          session.stage = failure.message;
          session.error = { code: failure.code, message: failure.message };
        }
      } finally {
        delete session.userCode;
        delete session.verificationUri;
      }
    })();
    return structuredClone(session);
  }
  cancel(id: string): void {
    if (this.session?.id !== id)
      throw new LauncherError('MICROSOFT_LOGIN_STALE', '此登录任务已结束，请重新开始');
    if (this.session.state === 'saving')
      throw new LauncherError('MICROSOFT_SAVING', '登录结果正在保存，请稍候');
    if (active(this.session)) this.controller?.abort();
  }
  authorization(id: string): { uri: string; code: string } {
    const session = this.session;
    if (
      session?.id !== id ||
      session.state !== 'awaiting-authorization' ||
      !session.verificationUri ||
      !session.userCode ||
      Date.parse(session.expiresAt ?? '') <= Date.now()
    )
      throw new LauncherError('MICROSOFT_LOGIN_STALE', '登录代码已不可用，请重新获取');
    return { uri: session.verificationUri, code: session.userCode };
  }
  async resolve(
    id: string,
    signal: AbortSignal,
    report: (progress: RuntimeProgress) => void,
  ): Promise<GameIdentity> {
    if (active(this.session) || this.refreshing)
      throw new LauncherError('MICROSOFT_BUSY', '请先完成正在进行的微软登录，再启动游戏');
    this.refreshing = true;
    try {
      const { account, credentials } = await this.accounts.microsoft(id);
      if (account.needsReauthentication)
        throw new LauncherError('MICROSOFT_REAUTH_REQUIRED', '微软授权已失效，请在账号管理中重新登录');
      const progress = (stage: string) => report({ stage, completed: 0, total: 0 });
      let authentication;
      if (Date.parse(account.expiresAt) > Date.now() + 120000) {
        progress('正在验证 Minecraft 游戏账号');
        try {
          const profile = await this.provider.validate(credentials.accessToken, signal);
          authentication = { ...profile, credentials, expiresAt: account.expiresAt };
        } catch (error) {
          if (!(error instanceof LauncherError) || error.code !== 'MINECRAFT_TOKEN_EXPIRED') throw error;
        }
      }
      if (!authentication) {
        progress('正在刷新微软登录');
        const oauth = await this.provider.refresh(credentials.clientId, credentials.refreshToken, signal);
        // Persist a rotated refresh token before the downstream Xbox/Minecraft requests can fail.
        if (oauth.refresh_token !== credentials.refreshToken)
          await this.accounts.rotateMicrosoft(id, oauth.refresh_token!);
        authentication = await this.provider.complete(oauth, credentials.clientId, signal, progress);
      }
      signal.throwIfAborted();
      await this.accounts.saveMicrosoft(authentication, id, signal);
      return {
        kind: 'microsoft',
        playerName: authentication.playerName,
        uuid: authentication.uuid,
        accessToken: authentication.credentials.accessToken,
        xuid: authentication.credentials.xuid,
        clientId: authentication.credentials.clientId,
      };
    } catch (error) {
      if (error instanceof LauncherError && error.code === 'MICROSOFT_REAUTH_REQUIRED')
        await this.accounts.markMicrosoftExpired(id);
      throw error;
    } finally {
      this.refreshing = false;
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.done;
  }
}
