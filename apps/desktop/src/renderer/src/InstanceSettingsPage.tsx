import { useState } from 'react';
import {
  ArrowLeft,
  Check,
  Coffee,
  FolderLock,
  FolderOpen,
  Monitor,
  RotateCcw,
  Save,
  UserRound,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { defaultLaunchSettings, updateInstanceSchema } from '@hunaumcl/contracts';
import type { AccountCollection, EnvironmentSummary, InstanceSummary } from '@hunaumcl/contracts';

export function InstanceSettingsPage({
  instance,
  environment,
  accounts,
  onBack,
  onSaved,
}: {
  instance: InstanceSummary;
  environment?: EnvironmentSummary;
  accounts: AccountCollection;
  onBack: () => void;
  onSaved: (instance: InstanceSummary) => void;
}) {
  const [name, setName] = useState(instance.name);
  const [settings, setSettings] = useState({ ...(instance.settings ?? defaultLaunchSettings) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const update = (patch: Partial<typeof settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const valid = updateInstanceSchema.safeParse({ instanceId: instance.id, name, settings });
    if (!valid.success) {
      setError(valid.error.issues[0]?.message ?? '请检查设置');
      return;
    }
    setBusy(true);
    try {
      const result = await window.launcher.updateInstance(valid.data);
      if (!result.ok) throw new Error(result.error.message);
      onSaved(result.value);
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  const accountMissing =
    settings.accountId && !accounts.accounts.some((account) => account.id === settings.accountId);
  const javaMissing = settings.javaId && !environment?.java.some((java) => java.id === settings.javaId);
  return (
    <form onSubmit={(event) => void save(event)} className="instance-settings-form">
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        返回游戏库
      </button>
      <div className="page-heading">
        <div>
          <h1>实例设置</h1>
          <p>
            {instance.name} / Minecraft {instance.versionId} · 仅影响这个实例的后续启动
          </p>
        </div>
        <button className="button primary" type="submit" disabled={busy}>
          {saved ? <Check size={17} /> : <Save size={17} />}
          {busy ? '正在保存' : saved ? '已保存' : '保存设置'}
        </button>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-section">
        <div className="settings-section-title">
          <FolderLock size={21} />
          <div>
            <h2>实例信息</h2>
            <p>显示名称与独立游戏目录</p>
          </div>
        </div>
        <div className="settings-fields">
          <label className="field">
            实例名称
            <input
              maxLength={60}
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <label className="field">
            版本隔离
            <select
              aria-label="版本隔离"
              value={settings.isolation}
              onChange={(event) => update({ isolation: event.target.value as typeof settings.isolation })}
            >
              <option value="isolated">独立：每个实例使用独立游戏目录</option>
              <option value="auto">自动：有加载器或存档的实例使用独立目录</option>
              <option value="shared">共享：与其他版本共用同一个游戏目录</option>
            </select>
            <small>
              {settings.isolation === 'shared'
                ? '共享目录中的模组、配置和存档会与其他版本共用，可能产生冲突。切换只影响之后的启动，不会移动已有文件。'
                : '切换只改变之后使用的游戏目录，不会删除或移动已有存档。'}
            </small>
            <button
              type="button"
              className="button quiet"
              onClick={() =>
                void window.launcher.openGameDirectory(instance.id).then((result) => {
                  if (!result.ok) setError(result.error.message);
                })
              }
            >
              <FolderOpen size={14} />
              打开当前游戏目录
            </button>
          </label>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-title">
          <Coffee size={21} />
          <div>
            <h2>Java 与内存</h2>
            <p>优先自动匹配，也可为此实例单独指定</p>
          </div>
        </div>
        <div className="settings-fields">
          <label className="field">
            Java 运行时
            <select
              value={settings.javaId ?? ''}
              onChange={(event) => update({ javaId: event.target.value || null })}
            >
              <option value="">自动匹配游戏要求</option>
              {javaMissing && <option value={settings.javaId!}>已保存的 Java 不可用，请重新选择</option>}
              {environment?.java.map((java) => (
                <option value={java.id} key={java.id}>
                  Java {java.major} · {java.vendor}
                </option>
              ))}
            </select>
            <small>启动时会再次确认它与游戏版本匹配。</small>
          </label>
          <div className="field">
            <span>内存分配</span>
            <div className="segmented-control" role="group" aria-label="内存分配">
              <button
                type="button"
                aria-pressed={settings.memoryMode === 'auto'}
                onClick={() => update({ memoryMode: 'auto' })}
              >
                自动分配
              </button>
              <button
                type="button"
                aria-pressed={settings.memoryMode === 'custom'}
                onClick={() => update({ memoryMode: 'custom' })}
              >
                手动分配
              </button>
            </div>
            {settings.memoryMode === 'custom' ? (
              <label className="memory-input">
                最大内存（MiB）
                <input
                  type="number"
                  aria-label="最大内存（MiB）"
                  required
                  min={512}
                  max={65536}
                  step={128}
                  value={settings.memoryMiB}
                  onChange={(event) => update({ memoryMiB: Number(event.target.value) })}
                />
                <small>{(settings.memoryMiB / 1024).toFixed(1)} GiB · 请为操作系统保留可用内存</small>
              </label>
            ) : (
              <small>根据本机内存自动分配，当前自动上限为 2 GiB。</small>
            )}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-title">
          <Monitor size={21} />
          <div>
            <h2>游戏窗口</h2>
            <p>设置初始窗口大小和全屏模式</p>
          </div>
        </div>
        <div className="settings-fields">
          <label className="toggle-row">
            <span>
              全屏启动<small>游戏启动后仍可在游戏内切换</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.fullscreen}
              onChange={(event) => update({ fullscreen: event.target.checked })}
            />
          </label>
          <div className="resolution-fields">
            <label className="field">
              窗口宽度
              <input
                aria-label="窗口宽度"
                type="number"
                min={320}
                max={7680}
                required
                disabled={settings.fullscreen}
                value={settings.width}
                onChange={(event) => update({ width: Number(event.target.value) })}
              />
            </label>
            <span>×</span>
            <label className="field">
              窗口高度
              <input
                aria-label="窗口高度"
                type="number"
                min={240}
                max={4320}
                required
                disabled={settings.fullscreen}
                value={settings.height}
                onChange={(event) => update({ height: Number(event.target.value) })}
              />
            </label>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-title">
          <UserRound size={21} />
          <div>
            <h2>启动账号</h2>
            <p>跟随当前账号，或为此实例固定身份</p>
          </div>
        </div>
        <div className="settings-fields">
          <label className="field">
            此实例使用的账号
            <select
              value={settings.accountId ?? ''}
              onChange={(event) => update({ accountId: event.target.value || null })}
            >
              <option value="">跟随启动器当前账号</option>
              {accountMissing && <option value={settings.accountId!}>绑定的账号已删除，请重新选择</option>}
              {accounts.accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {account.playerName}（{account.kind === 'microsoft' ? 'Microsoft' : '离线'}）
                </option>
              ))}
            </select>
            <small>账号在「账号管理」中保存。离线账号不具备正版服务器认证能力。</small>
          </label>
        </div>
      </section>
      <div className="settings-footer">
        <button
          className="button quiet"
          type="button"
          onClick={() => {
            setSettings({ ...defaultLaunchSettings });
            setSaved(false);
          }}
        >
          <RotateCcw size={15} />
          恢复默认设置
        </button>
        <span>设置保存后，在下一次启动生效。</span>
      </div>
    </form>
  );
}
