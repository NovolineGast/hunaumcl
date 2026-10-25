import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Settings2,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import type { FormEvent } from 'react';
import type {
  AccountCollection,
  MicrosoftConfiguration,
  MicrosoftLoginSnapshot,
  Result,
} from '@hunaumcl/contracts';
import { Modal } from './Modal';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export function MicrosoftMark() {
  return (
    <span className="microsoft-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
const active = (login?: MicrosoftLoginSnapshot | null) =>
  login && ['requesting', 'awaiting-authorization', 'authenticating', 'saving'].includes(login.state);
// Remember which failed login already opened the settings dialog so a remount does not reopen it.
let registrationHinted = '';
export function MicrosoftLoginPanel({
  onChange,
  request,
}: {
  onChange: (accounts: AccountCollection) => void;
  request?: { accountId: string; revision: number };
}) {
  const [configuration, setConfiguration] = useState<MicrosoftConfiguration>();
  const [clientId, setClientId] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [method, setMethod] = useState<'microsoft' | 'offline'>('microsoft');
  const [login, setLogin] = useState<MicrosoftLoginSnapshot | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const target = useRef<string | undefined>(undefined);
  const handled = useRef('');
  const dismissed = useRef('');
  const begin = async (accountId?: string) => {
    setError('');
    setCopied(false);
    setBusy(true);
    target.current = accountId;
    dismissed.current = '';
    try {
      const config = unwrap(await window.launcher.microsoftConfiguration());
      setConfiguration(config);
      setClientId(config.clientId);
      if (!config.clientId) {
        setConfigOpen(true);
        return;
      }
      setLogin(unwrap(await window.launcher.startMicrosoftLogin(accountId ? { accountId } : {})));
      setDialogOpen(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法开始微软登录');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (request) void begin(request.accountId);
  }, [request]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    void window.launcher.microsoftConfiguration().then((result) => {
      if (disposed) return;
      if (result.ok) {
        setConfiguration(result.value);
        setClientId(result.value.clientId);
      } else setError(result.error.message);
    });
    const poll = async () => {
      try {
        const status = unwrap(await window.launcher.microsoftLoginStatus());
        if (disposed) return;
        setLogin(status);
        if (active(status)) target.current = status?.accountId;
        if (active(status) && status?.id !== dismissed.current) setDialogOpen(true);
        if (status?.state === 'succeeded' && handled.current !== status.id) {
          const accounts = unwrap(await window.launcher.accounts());
          if (disposed) return;
          handled.current = status.id;
          onChange(accounts);
        }
        if (
          status?.state === 'failed' &&
          status.error?.code === 'MICROSOFT_AUTHORIZATION_FAILED' &&
          registrationHinted !== status.id
        ) {
          // Registration problems are fixed in the settings dialog; keep the reason next to the field.
          registrationHinted = status.id;
          setDialogOpen(false);
          setError(status.error.message);
          setConfigOpen(true);
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : '无法读取登录状态');
      }
      if (!disposed) timer = setTimeout(() => void poll(), 800);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [onChange]);
  const close = async () => {
    try {
      if (active(login)) unwrap(await window.launcher.cancelMicrosoftLogin(login!.id));
      dismissed.current = login?.id ?? '';
      setDialogOpen(false);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法取消登录');
    }
  };
  const action = async (kind: 'open' | 'copy') => {
    if (!login) return;
    try {
      unwrap(
        await (kind === 'open'
          ? window.launcher.openMicrosoftLogin(login.id)
          : window.launcher.copyMicrosoftCode(login.id)),
      );
      if (kind === 'copy') setCopied(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未完成');
    }
  };
  const help = async (kind: 'registration' | 'api-access') => {
    try {
      unwrap(await window.launcher.openMicrosoftHelp(kind));
    } catch {
      setError('无法打开说明页面，请检查默认浏览器');
    }
  };
  const saveConfiguration = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setConfiguration(unwrap(await window.launcher.configureMicrosoft({ clientId: clientId.trim() })));
      setConfigOpen(false);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法保存登录设置');
    } finally {
      setBusy(false);
    }
  };
  const remaining = Math.max(0, Math.ceil((Date.parse(login?.expiresAt ?? '') - Date.now()) / 1000) || 0);
  const step =
    login?.state === 'succeeded'
      ? 4
      : login?.state === 'saving'
        ? 3
        : login?.stage.includes('Minecraft') || login?.stage.includes('Java 版')
          ? 2
          : login?.stage.includes('Xbox')
            ? 1
            : 0;
  return (
    <>
      <section className="signin-panel" aria-label="添加游戏账号">
        <div
          className="signin-methods"
          role="tablist"
          aria-label="登录方式"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const next = method === 'microsoft' ? 'offline' : 'microsoft';
              setMethod(next);
              event.currentTarget.querySelectorAll('button')[next === 'microsoft' ? 0 : 1]?.focus();
            }
          }}
        >
          <button
            id="signin-microsoft-tab"
            role="tab"
            aria-selected={method === 'microsoft'}
            aria-controls="signin-method-panel"
            tabIndex={method === 'microsoft' ? 0 : -1}
            onClick={() => setMethod('microsoft')}
          >
            <MicrosoftMark />
            Microsoft
          </button>
          <button
            id="signin-offline-tab"
            role="tab"
            aria-selected={method === 'offline'}
            aria-controls="signin-method-panel"
            tabIndex={method === 'offline' ? 0 : -1}
            onClick={() => setMethod('offline')}
          >
            <UserRound size={17} />
            离线账号
          </button>
        </div>
        <div
          id="signin-method-panel"
          className="signin-content"
          role="tabpanel"
          aria-labelledby={method === 'microsoft' ? 'signin-microsoft-tab' : 'signin-offline-tab'}
        >
          <div className="signin-copy">
            <h2>{method === 'microsoft' ? '登录你的 Minecraft 正版账号' : '使用本地离线身份'}</h2>
            <p>
              {method === 'microsoft'
                ? '在浏览器完成微软授权，自动读取 Java 版许可和玩家档案。'
                : '点击右上角「添加离线账号」保存玩家名称，用于本地游戏。离线身份不支持正版服务器认证。'}
            </p>
            {method === 'microsoft' && (
              <small>
                <ShieldCheck size={14} />
                {configuration?.clientId
                  ? '凭据由系统加密保存，启动时自动验证与刷新'
                  : '首次使用需先完成 Microsoft 登录设置'}
              </small>
            )}
          </div>
          {method === 'microsoft' && (
            <div className="signin-actions">
              <button
                className="button primary"
                disabled={busy || !!active(login) || !configuration}
                onClick={() => void begin()}
              >
                <MicrosoftMark />
                登录 Microsoft
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setError('');
                  setConfigOpen(true);
                }}
              >
                <Settings2 size={14} />
                Microsoft 登录设置
              </button>
            </div>
          )}
        </div>
      </section>
      {error && !dialogOpen && !configOpen && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {configOpen && (
        <Modal
          title="Microsoft 登录设置"
          busy={busy}
          onClose={() => {
            setConfigOpen(false);
            setError('');
          }}
        >
          <form onSubmit={(event) => void saveConfiguration(event)}>
            <p className="ms-config-intro">填写用于 Microsoft 登录的应用 ID，只需设置一次。</p>
            <label className="field">
              应用程序（客户端）ID
              <input
                autoFocus
                required
                value={clientId}
                disabled={configuration?.source === 'environment'}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                maxLength={36}
              />
            </label>
            <details className="ms-setup-details">
              <summary>如何获取应用 ID？</summary>
              <ol className="ms-setup-steps">
                <li>
                  在 Microsoft Entra 的「应用注册」中新建应用，「受支持的帐户类型」选择包含个人 Microsoft
                  帐户的选项。
                </li>
                <li>
                  在「身份验证 →
                  高级设置」把「允许公共客户端流」设为「是」并保存；设备代码登录不需要客户端密钥。
                </li>
                <li>
                  确认应用已取得 Minecraft Java API 的访问资格；审核通过前，登录可能被 Minecraft 服务拒绝。
                </li>
              </ol>
              <p className="ms-setup-note">修改应用注册后通常几分钟内生效。</p>
              <div className="ms-config-links">
                <button type="button" className="text-button" onClick={() => void help('registration')}>
                  打开应用注册
                  <ExternalLink size={13} />
                </button>
                <button type="button" className="text-button" onClick={() => void help('api-access')}>
                  Minecraft API 准入
                  <ExternalLink size={13} />
                </button>
              </div>
            </details>
            {configuration?.source === 'environment' && (
              <p className="form-note">当前由启动参数设置，无法在这里修改。</p>
            )}
            {configuration && !configuration.secureStorageAvailable && (
              <div className="alert error">系统安全存储暂不可用，请解锁系统钥匙串后再登录。</div>
            )}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="button quiet" data-close-dialog>
                关闭
              </button>
              {configuration?.source !== 'environment' && (
                <button type="submit" className="button primary" disabled={busy}>
                  保存设置
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
      {dialogOpen && login && (
        <Modal title="Microsoft 登录" busy={login.state === 'saving'} onClose={() => void close()}>
          <div className="ms-login-heading">
            <span className="ms-login-emblem">
              <MicrosoftMark />
            </span>
            <div>
              <strong>连接你的 Minecraft 账号</strong>
              <p>在微软网页完成授权后，回到这里继续。</p>
            </div>
          </div>
          {login.state === 'awaiting-authorization' && (
            <div className="device-authorization">
              <span>在微软验证页输入以下代码</span>
              <strong className="device-code">{login.userCode}</strong>
              <small>
                {login.verificationUri}
                <br />
                代码剩余 {Math.floor(remaining / 60)} 分 {remaining % 60} 秒
              </small>
              <div>
                <button className="button primary" onClick={() => void action('open')}>
                  <ExternalLink size={16} />
                  打开浏览器
                </button>
                <button className="button secondary" onClick={() => void action('copy')}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? '已复制' : '复制代码'}
                </button>
              </div>
            </div>
          )}
          <ol className="ms-login-steps" aria-label="登录阶段">
            {['Microsoft 授权', 'Xbox Live 验证', 'Minecraft 许可与档案', '保存游戏账号'].map(
              (label, index) => (
                <li key={label} data-done={step > index} data-active={step === index && !!active(login)}>
                  <span>{step > index ? <Check size={12} /> : index + 1}</span>
                  {label}
                </li>
              ),
            )}
          </ol>
          <div
            className={`ms-login-status ${login.state === 'succeeded' ? 'ms-login-success' : ''}`}
            role="status"
          >
            {active(login) ? (
              <LoaderCircle className="spin" size={17} />
            ) : login.state === 'succeeded' ? (
              <CheckCircle2 size={19} />
            ) : (
              <KeyRound size={17} />
            )}
            <span>{login.stage}</span>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            {login.error?.code === 'MINECRAFT_API_DENIED' && (
              <button className="button secondary" disabled={busy} onClick={() => void help('api-access')}>
                <ExternalLink size={15} />
                申请 API 准入
              </button>
            )}
            {['failed', 'expired', 'cancelled'].includes(login.state) && (
              <button className="button secondary" disabled={busy} onClick={() => void begin(target.current)}>
                重新登录
              </button>
            )}
            <button className="button quiet" disabled={login.state === 'saving'} onClick={() => void close()}>
              {active(login) ? '取消登录' : '完成'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
