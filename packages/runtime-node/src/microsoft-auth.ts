import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { LauncherError } from '@hunaumcl/application';
import type { MicrosoftAuthentication } from './account-credentials';
import { fetchLoader } from './loader-fetch';

const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const scope = 'XboxLive.signin offline_access';
const tokenSchema = z.object({
  access_token: z.string().min(1).max(32768),
  refresh_token: z.string().min(1).max(32768).optional(),
});
const xboxSchema = z.object({
  Token: z.string().min(1).max(32768),
  DisplayClaims: z.object({
    xui: z
      .array(
        z.object({
          uhs: z.string().min(1).max(100),
          xid: z
            .string()
            .regex(/^\d{1,24}$/)
            .optional(),
        }),
      )
      .min(1),
  }),
});
const profileSchema = z.object({
  id: z.string().regex(/^[a-fA-F0-9]{32}$/),
  name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/),
});
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}
type OAuthToken = z.infer<typeof tokenSchema>;
export type AuthStage = (stage: string) => void;
export class MicrosoftAuthProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetchLoader,
    private readonly now: () => number = Date.now,
    private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = async (
      ms,
      signal,
    ) => {
      await sleep(ms, undefined, { signal });
    },
  ) {}
  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    signal.throwIfAborted();
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.body) throw Error('Empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 1024 * 1024) throw Error('Response too large');
        chunks.push(chunk);
      }
      return {
        status: response.status,
        body: z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
      };
    } catch {
      signal.throwIfAborted();
      throw new LauncherError('MICROSOFT_NETWORK', '登录服务暂时无法连接，请检查网络后重试');
    }
  }
  private form(path: string, data: Record<string, string>, signal: AbortSignal) {
    return this.request(
      `${authority}/${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString(),
      },
      signal,
    );
  }
  private json(url: string, data: unknown, signal: AbortSignal) {
    return this.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      },
      signal,
    );
  }
  private aadstsCode(body: Record<string, unknown>, description: string): number | undefined {
    const codes = Array.isArray(body.error_codes) ? body.error_codes : [];
    const numeric = codes.find(
      (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value < 10_000_000,
    );
    if (typeof numeric === 'number') return numeric;
    const match = /AADSTS(\d{3,7})/.exec(description);
    return match ? Number(match[1]) : undefined;
  }
  private oauthFailure(body: Record<string, unknown>): LauncherError {
    const error = typeof body.error === 'string' ? body.error : '';
    const description = typeof body.error_description === 'string' ? body.error_description : '';
    const code = this.aadstsCode(body, description);
    const failure = (kind: 'reauth' | 'expired' | 'authorization', message: string) =>
      new LauncherError(
        kind === 'reauth'
          ? 'MICROSOFT_REAUTH_REQUIRED'
          : kind === 'expired'
            ? 'MICROSOFT_CODE_EXPIRED'
            : 'MICROSOFT_AUTHORIZATION_FAILED',
        code ? `${message}（AADSTS${code}）` : message,
      );
    if (error === 'invalid_grant') return failure('reauth', '微软授权已失效，请重新登录此账号');
    if (error === 'expired_token') return failure('expired', '登录代码已过期，请重新获取');
    if (error === 'authorization_declined')
      return failure('authorization', '你已拒绝此次授权，可以重新开始登录');
    if (error === 'access_denied')
      return failure('authorization', '此次授权已取消或被拒绝，可以重新开始登录');
    // AADSTS codes identify the registration or tenant setting that needs to change; keep them for
    // support while leaving the raw description, trace ID and credential echoes out of the UI.
    const configuration: Record<number, string> = {
      700016:
        '应用注册中找不到这个 Client ID，或该应用不支持个人 Microsoft 帐户；请确认填写的是「应用程序（客户端）ID」，并把「受支持的帐户类型」设为包含个人 Microsoft 帐户的选项',
      7000215: '应用被当作机密客户端，但登录没有提供密钥；请启用「允许公共客户端流」',
      7000218: '应用注册没有启用「允许公共客户端流」；请在「身份验证 → 高级设置」把它设为「是」并保存',
      50194: '应用仍是单租户配置；请把「受支持的帐户类型」改为包含个人 Microsoft 帐户的选项',
      65001: '此次登录需要先同意应用权限，请重新登录并在浏览器中确认',
      90002: '找不到登录服务所在的租户，请稍后重试',
    };
    if (code !== undefined && configuration[code]) return failure('authorization', configuration[code]);
    if (error === 'invalid_scope')
      return failure('authorization', '应用无法申请 XboxLive.signin 权限，请检查应用注册的 API 配置');
    if (error === 'invalid_client')
      return failure('authorization', '应用注册配置无效，请检查 Client ID 是否正确');
    if (error === 'unauthorized_client')
      return failure(
        'authorization',
        '应用注册拒绝了设备代码登录；请确认 Client ID 正确、「受支持的帐户类型」包含个人 Microsoft 帐户，并启用「允许公共客户端流」',
      );
    return failure('authorization', '微软授权未完成，请检查应用注册配置后重试');
  }
  async device(clientId: string, signal: AbortSignal): Promise<DeviceAuthorization> {
    const response = await this.form('devicecode', { client_id: clientId, scope }, signal);
    if (response.status !== 200) throw this.oauthFailure(response.body);
    const parsed = z
      .object({
        device_code: z.string().min(1).max(32768),
        user_code: z.string().min(1).max(32),
        verification_uri: z.url(),
        expires_in: z.number().int().min(1).max(1800),
        interval: z.number().int().min(1).max(60).default(5),
      })
      .safeParse(response.body);
    if (!parsed.success)
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', '微软返回的设备登录信息不完整');
    const data = parsed.data;
    const url = new URL(data.verification_uri);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(url.hostname)
    )
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', '微软返回了无法识别的验证页面');
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: url.href,
      expiresAt: this.now() + data.expires_in * 1000,
      interval: data.interval * 1000,
    };
  }
  async poll(clientId: string, device: DeviceAuthorization, signal: AbortSignal): Promise<OAuthToken> {
    let interval = device.interval;
    while (this.now() < device.expiresAt) {
      await this.wait(Math.min(interval, device.expiresAt - this.now()), signal);
      signal.throwIfAborted();
      if (this.now() >= device.expiresAt) break;
      const response = await this.form(
        'token',
        {
          client_id: clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.deviceCode,
        },
        signal,
      );
      if (response.status === 200) {
        const token = tokenSchema.safeParse(response.body);
        if (!token.success || !token.data.refresh_token)
          throw new LauncherError('MICROSOFT_RESPONSE_INVALID', '微软未返回可保存的授权，请重新登录');
        return token.data;
      }
      if (response.body.error === 'authorization_pending') continue;
      if (response.body.error === 'slow_down' || response.status === 429) {
        interval += 5000;
        continue;
      }
      throw this.oauthFailure(response.body);
    }
    throw new LauncherError('MICROSOFT_CODE_EXPIRED', '登录代码已过期，请重新获取');
  }
  async refresh(clientId: string, refreshToken: string, signal: AbortSignal): Promise<OAuthToken> {
    const response = await this.form(
      'token',
      { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope },
      signal,
    );
    if (response.status !== 200) throw this.oauthFailure(response.body);
    const token = tokenSchema.safeParse(response.body);
    if (!token.success) throw new LauncherError('MICROSOFT_RESPONSE_INVALID', '微软返回的刷新结果不完整');
    return { ...token.data, refresh_token: token.data.refresh_token ?? refreshToken };
  }
  async validate(accessToken: string, signal: AbortSignal): Promise<{ playerName: string; uuid: string }> {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const license = await this.request(
      'https://api.minecraftservices.com/entitlements/mcstore',
      { headers },
      signal,
    );
    if (license.status === 401)
      throw new LauncherError('MINECRAFT_TOKEN_EXPIRED', 'Minecraft 登录已过期，正在刷新授权');
    this.checkMinecraftStatus(license.status, license.body);
    const items = z.object({ items: z.array(z.object({ name: z.string() })) }).safeParse(license.body);
    if (!items.success)
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', 'Minecraft 返回的许可信息不完整');
    if (!items.data.items.some((item) => ['game_minecraft', 'product_minecraft'].includes(item.name)))
      throw new LauncherError(
        'MINECRAFT_NOT_OWNED',
        '此账号没有可用的 Minecraft Java 版许可，请确认购买账号或订阅状态',
      );
    const response = await this.request(
      'https://api.minecraftservices.com/minecraft/profile',
      { headers },
      signal,
    );
    if (response.status === 401) throw new LauncherError('MINECRAFT_TOKEN_EXPIRED', 'Minecraft 登录已过期');
    if (response.status === 404)
      throw new LauncherError(
        'MINECRAFT_PROFILE_REQUIRED',
        '此账号尚未创建 Java 版游戏档案，请先在 Minecraft 官网设置玩家名称',
      );
    this.checkMinecraftStatus(response.status, response.body);
    const profile = profileSchema.safeParse(response.body);
    if (!profile.success)
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', 'Minecraft 返回的玩家档案不完整');
    return { playerName: profile.data.name, uuid: profile.data.id.toLowerCase() };
  }
  private checkMinecraftStatus(status: number, body?: Record<string, unknown>): void {
    if (status === 403) {
      // The service reports rejected Client IDs as "Invalid app registration" and links the review
      // article; keep that distinction instead of showing one generic denial for every 403.
      const detail = [body?.errorMessage, body?.developerMessage].find(
        (value): value is string => typeof value === 'string',
      );
      if (detail && /invalid app registration|appreginfo/i.test(detail))
        throw new LauncherError(
          'MINECRAFT_API_DENIED',
          'Minecraft 服务拒绝了此应用：这个 Client ID 还没有 Minecraft Java 版 API 准入资格。请在 https://aka.ms/mce-reviewappid 提交申请并等待审核通过，审核通过前无法登录正版账号',
        );
      throw new LauncherError(
        'MINECRAFT_API_DENIED',
        'Minecraft 服务拒绝了此应用，请确认 Client ID 已取得 Minecraft Java API 访问资格',
      );
    }
    if (status < 200 || status >= 300)
      throw new LauncherError('MINECRAFT_SERVICE_HTTP', `Minecraft 登录服务暂时不可用（HTTP ${status}）`);
  }
  async complete(
    oauth: OAuthToken,
    clientId: string,
    signal: AbortSignal,
    report: AuthStage,
  ): Promise<MicrosoftAuthentication> {
    report('正在验证 Xbox Live 账号');
    const xbox = await this.json(
      'https://user.auth.xboxlive.com/user/authenticate',
      {
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${oauth.access_token}`,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      },
      signal,
    );
    if (xbox.status !== 200)
      throw new LauncherError('XBOX_AUTH_FAILED', 'Xbox Live 验证失败，请确认账号可以登录 Xbox');
    const user = xboxSchema.safeParse(xbox.body);
    if (!user.success)
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', 'Xbox Live 返回的账号信息不完整');
    report('正在获取 Xbox 游戏授权');
    const xsts = await this.json(
      'https://xsts.auth.xboxlive.com/xsts/authorize',
      {
        Properties: { SandboxId: 'RETAIL', UserTokens: [user.data.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      },
      signal,
    );
    if (xsts.status !== 200) {
      const reasons: Record<string, string> = {
        '2148916233': '此账号尚未创建 Xbox 档案，请先在 Xbox 官网完成注册',
        '2148916235': '此账号所在地区暂不支持 Xbox Live',
        '2148916236': '此账号需要在 Xbox 官网完成年龄验证',
        '2148916237': '此账号需要在 Xbox 官网完成年龄验证',
        '2148916238': '未成年账号需要先加入 Microsoft 家庭，并由监护人允许 Xbox 在线服务',
      };
      throw new LauncherError(
        'XBOX_XSTS_DENIED',
        reasons[String(xsts.body.XErr)] ?? 'Xbox 游戏授权被拒绝，请检查 Xbox 账号和家庭隐私设置',
      );
    }
    const authorization = xboxSchema.safeParse(xsts.body);
    if (!authorization.success)
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', 'Xbox 游戏授权信息不完整');
    const claim = authorization.data.DisplayClaims.xui[0]!;
    if (claim.uhs !== user.data.DisplayClaims.xui[0]!.uhs)
      throw new LauncherError('XBOX_ACCOUNT_MISMATCH', 'Xbox 授权账号不一致，请重新登录');
    report('正在登录 Minecraft 服务');
    const minecraft = await this.json(
      'https://api.minecraftservices.com/authentication/login_with_xbox',
      { identityToken: `XBL3.0 x=${claim.uhs};${authorization.data.Token}` },
      signal,
    );
    this.checkMinecraftStatus(minecraft.status, minecraft.body);
    const token = z
      .object({
        access_token: z.string().min(1).max(32768),
        expires_in: z
          .number()
          .int()
          .min(1)
          .max(31 * 86400),
      })
      .safeParse(minecraft.body);
    if (!token.success || !oauth.refresh_token)
      throw new LauncherError('MICROSOFT_RESPONSE_INVALID', 'Minecraft 返回的会话信息不完整');
    report('正在检查 Java 版许可与玩家档案');
    const profile = await this.validate(token.data.access_token, signal);
    let xuid = claim.xid ?? '';
    if (!xuid) {
      try {
        const claims = JSON.parse(
          Buffer.from(token.data.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as { xuid?: unknown };
        if (typeof claims.xuid === 'string' && /^\d{1,24}$/.test(claims.xuid)) xuid = claims.xuid;
      } catch {
        /* XUID is optional for historical access tokens; authorization relies on service validation. */
      }
    }
    return {
      ...profile,
      expiresAt: new Date(this.now() + token.data.expires_in * 1000).toISOString(),
      credentials: {
        clientId,
        refreshToken: oauth.refresh_token,
        accessToken: token.data.access_token,
        xuid,
      },
    };
  }
}
