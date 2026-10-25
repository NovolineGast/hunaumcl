import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  Activity,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Coffee,
  FolderOpen,
  HardDrive,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
  Download,
  Play,
  Settings2,
  UserRound,
  ArrowLeft,
  Terminal,
} from 'lucide-react';
import type {
  EnvironmentSummary,
  InstanceSummary,
  LaunchCheck,
  Result,
  VersionCatalog,
  ActivitySnapshot,
  AccountCollection,
  InstanceComponents,
} from '@hunaumcl/contracts';
import { componentCompatibilityError, componentsSchema, vanillaComponents } from '@hunaumcl/contracts';
import { ComponentPicker, ComponentsPage, componentLabel } from './ComponentsPage';
import { ActivityPanel } from './ActivityPanel';
import { AccountsPage } from './AccountsPage';
import { InstanceSettingsPage } from './InstanceSettingsPage';
import { Modal } from './Modal';
import { DownloadDock } from './DownloadDock';
import { LaunchPanel, LauncherHome, VersionLibrary } from './LauncherViews';
import { WindowControls } from './WindowControls';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const osNames = { windows: 'Windows', osx: 'macOS', linux: 'Linux' };
const selectionKey = 'hunaumcl.selected-instance';
function readSelection() {
  try {
    return localStorage.getItem(selectionKey) ?? '';
  } catch {
    return '';
  }
}

export function App() {
  const [page, setPage] = useState<
    'home' | 'library' | 'downloads' | 'tasks' | 'environment' | 'accounts' | 'settings' | 'components'
  >('home');
  const [components, setComponents] = useState<InstanceComponents>({ ...vanillaComponents });
  const [createExpanded, setCreateExpanded] = useState(false);
  const navigate = (next: typeof page) => {
    if (next === page) return;
    const change = () => {
      setPage(next);
      document.querySelector('.workspace')?.scrollTo(0, 0);
    };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      document.startViewTransition(() => flushSync(change));
    else change();
  };
  const [accounts, setAccounts] = useState<AccountCollection>({ accounts: [], selectedId: null });
  const [settingsInstance, setSettingsInstance] = useState<InstanceSummary>();
  const [launchAccountId, setLaunchAccountId] = useState('');
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentSummary>();
  const [selectedId, setSelectedId] = useState(readSelection);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [catalog, setCatalog] = useState<VersionCatalog>();
  const [catalogError, setCatalogError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [name, setName] = useState('');
  const [versionId, setVersionId] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [check, setCheck] = useState<LaunchCheck>();
  const [notice, setNotice] = useState('');
  const [activity, setActivity] = useState<ActivitySnapshot>({ tasks: [], sessions: [] });
  const [launchInstance, setLaunchInstance] = useState<InstanceSummary>();
  const [starting, setStarting] = useState(false);
  const lastState = useRef('');
  const busy = activity.tasks.some((task) => ['running', 'cancelling'].includes(task.state));
  const activeDownload = activity.tasks.find(
    (task) => task.kind === 'install' && ['running', 'cancelling'].includes(task.state),
  );
  const selectedInstance = instances.find((instance) => instance.id === selectedId);
  const contextInstance = ['settings', 'components'].includes(page) ? settingsInstance : selectedInstance;
  useEffect(() => {
    if (loading) return;
    if (!instances.some((instance) => instance.id === selectedId)) {
      setSelectedId(instances[0]?.id ?? '');
      return;
    }
    try {
      localStorage.setItem(selectionKey, selectedId);
    } catch {
      /* Selection remains usable for this session. */
    }
  }, [instances, loading, selectedId]);
  const selectInstance = (instance: InstanceSummary) => {
    setSelectedId(instance.id);
    navigate('home');
  };
  const selectAccount = async (id: string) => {
    try {
      setAccounts(unwrap(await window.launcher.selectAccount(id)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法切换账号');
    }
  };
  const openComponents = (instance: InstanceSummary) => {
    setSettingsInstance(instance);
    navigate('components');
  };
  const openDirectory = async (instance: InstanceSummary) => {
    try {
      unwrap(await window.launcher.openGameDirectory(instance.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法打开游戏目录');
    }
  };
  const instanceRunning = (instance: InstanceSummary) =>
    activity.sessions.some(
      (session) => session.instanceId === instance.id && ['running', 'stopping'].includes(session.state),
    );
  const section = ['home', 'library'].includes(page)
    ? 'launch'
    : ['downloads', 'components', 'tasks'].includes(page)
      ? 'download'
      : 'settings';
  const openSettings = (instance: InstanceSummary) => {
    setSettingsInstance(instance);
    navigate('settings');
  };
  const openLaunch = (instance: InstanceSummary) => {
    const id = instance.settings?.accountId ?? accounts.selectedId;
    if (!accounts.accounts.length) {
      setNotice('请先登录 Microsoft 或添加离线账号');
      navigate('accounts');
      return;
    }
    if (!accounts.accounts.some((account) => account.id === id)) {
      setNotice('实例绑定的账号已删除，请重新选择');
      openSettings(instance);
      return;
    }
    setLaunchAccountId(id!);
    setLaunchInstance(instance);
  };
  useEffect(() => {
    void window.launcher.accounts().then((result) => {
      if (result.ok) setAccounts(result.value);
      else setError(result.error.message);
    });
  }, []);

  const loadInstances = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      setInstances(unwrap(await window.launcher.listInstances()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法读取游戏库');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = unwrap(await window.launcher.activity());
        if (!active) return;
        setActivity(next);
        const state = next.tasks.map((task) => `${task.id}:${task.state}`).join(',');
        if (lastState.current !== state) {
          lastState.current = state;
          void loadInstances(true);
          void window.launcher.accounts().then((result) => {
            if (active && result.ok) setAccounts(result.value);
          });
        }
      } catch {
        /* Operations show their own errors; retry activity reads after a reload. */
      }
      if (active) timer = setTimeout(() => void poll(), 250);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [loadInstances]);
  const install = async (instance: InstanceSummary) => {
    setError('');
    try {
      unwrap(await window.launcher.install(instance.id));
      setActivity(unwrap(await window.launcher.activity()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法开始安装');
    }
  };
  const launch = async (event: FormEvent) => {
    event.preventDefault();
    if (!launchInstance) return;
    setStarting(true);
    setError('');
    try {
      unwrap(
        await window.launcher.launchAccount({ instanceId: launchInstance.id, accountId: launchAccountId }),
      );
      setLaunchInstance(undefined);
      setActivity(unwrap(await window.launcher.activity()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法启动');
    } finally {
      setStarting(false);
    }
  };
  const manage = async (kind: 'cancel' | 'stop', id: string) => {
    try {
      unwrap(await (kind === 'cancel' ? window.launcher.cancelTask(id) : window.launcher.stopSession(id)));
      setActivity(unwrap(await window.launcher.activity()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未完成');
    }
  };
  const scan = useCallback(async () => {
    setScanning(true);
    setError('');
    try {
      setEnvironment(unwrap(await window.launcher.environment()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法检测运行环境');
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => {
    void loadInstances();
    void scan();
  }, [loadInstances, scan]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const next = unwrap(await window.launcher.catalog());
      setCatalog(next);
      setVersionId((current) => current || next.latestRelease);
    } catch (failure) {
      setCatalogError(failure instanceof Error ? failure.message : '无法获取版本列表');
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  useEffect(() => {
    if (page === 'downloads') void loadCatalog();
  }, [page, loadCatalog]);
  const openCreate = () => {
    setName('');
    setComponents({ ...vanillaComponents });
    setCreateExpanded(false);
    setCreateOpen(true);
    setCatalogError('');
    if (!catalog) void loadCatalog();
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setCatalogError('');
    try {
      const instance = unwrap(
        await window.launcher.createInstance({ name: name.trim(), versionId, components }),
      );
      setInstances((current) => [...current, instance]);
      setSelectedId(instance.id);
      setCreateOpen(false);
      if (page === 'downloads') {
        await install(instance);
        navigate('home');
      }
      setNotice(`已创建「${instance.name}」`);
    } catch (failure) {
      setCatalogError(failure instanceof Error ? failure.message : '无法创建实例');
    } finally {
      setSaving(false);
    }
  };
  const checkInstance = async (instance: InstanceSummary) => {
    setChecking(instance.id);
    setError('');
    try {
      setCheck(unwrap(await window.launcher.checkLaunch(instance.id)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法检查启动条件');
    } finally {
      setChecking(undefined);
    }
  };
  const filtered = instances.filter((instance) =>
    `${instance.name} ${instance.versionId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  const createForm = (
    <>
      <p className="dialog-description">选择 Minecraft 版本，按需搭配加载器与高清修复。</p>
      <form onSubmit={(event) => void create(event)}>
        <label className="field">
          实例名称
          <input
            autoFocus={createOpen}
            maxLength={60}
            required
            placeholder="例如：我的生存世界"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
          />
        </label>
        <label className="field">
          Minecraft 版本
          <select
            aria-label="Minecraft 版本"
            value={versionId}
            onChange={(event) => {
              setVersionId(event.target.value);
              setComponents({ ...vanillaComponents });
            }}
            disabled={catalogLoading || saving || !catalog}
            required
          >
            {!catalog && (
              <option value="">{catalogLoading ? '正在获取游戏版本列表…' : '版本列表尚未加载'}</option>
            )}
            {catalog?.releases.map((version) => (
              <option value={version.id} key={version.id}>
                {version.id}
                {version.id === catalog.latestRelease ? '（最新正式版）' : ''}
              </option>
            ))}
          </select>
        </label>
        {page !== 'downloads' && (
          <button
            type="button"
            className="component-expand"
            onClick={() => setCreateExpanded((current) => !current)}
          >
            <Layers3 size={16} />
            {createExpanded ? '收起组件选择' : '选择加载器 / OptiFine（可选）'}
          </button>
        )}
        {(createExpanded || page === 'downloads') && versionId && (
          <ComponentPicker minecraft={versionId} value={components} onChange={setComponents} />
        )}
        <div className="form-note">
          <FolderOpen size={17} />
          <span>新实例默认使用独立的游戏目录，可在版本设置中修改。</span>
        </div>
        {catalogError && (
          <div className="alert error" role="alert">
            <TriangleAlert size={18} />
            <span>{catalogError}</span>
            {!catalog && (
              <button type="button" onClick={() => void loadCatalog()} disabled={catalogLoading}>
                重试
              </button>
            )}
          </div>
        )}
        <div className="dialog-actions">
          {createOpen && (
            <button type="button" className="button quiet" disabled={saving} data-close-dialog>
              取消
            </button>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={
              saving ||
              (page === 'downloads' && busy) ||
              catalogLoading ||
              !catalog ||
              !name.trim() ||
              !componentsSchema.safeParse(components).success ||
              !!componentCompatibilityError(versionId, components)
            }
          >
            {saving ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
            {saving ? '正在创建' : page === 'downloads' ? '创建并安装' : '创建实例'}
          </button>
        </div>
      </form>
    </>
  );

  return (
    <div className="app-shell">
      <header
        className="launcher-header"
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
          void window.launcher.windowToggleMaximize();
        }}
      >
        <button className="launcher-brand" onClick={() => navigate('home')} aria-label="HUNAUMCL 首页">
          <Box size={24} strokeWidth={1.6} />
          <strong>HUNAUMCL</strong>
        </button>
        <nav className="primary-nav" aria-label="主导航">
          <button aria-current={section === 'launch' ? 'page' : undefined} onClick={() => navigate('home')}>
            <Play size={17} />
            启动
          </button>
          <button
            aria-current={section === 'download' ? 'page' : undefined}
            onClick={() => navigate('downloads')}
          >
            <Download size={17} />
            下载
          </button>
          <button
            aria-current={section === 'settings' ? 'page' : undefined}
            onClick={() => navigate('accounts')}
          >
            <Settings2 size={17} />
            设置
          </button>
        </nav>
        <div className="header-actions">
          <button className="header-tasks" onClick={() => navigate('tasks')} aria-label="查看任务与日志">
            <Activity size={17} />
            <span>{busy ? '有任务进行中' : '任务'}</span>
            {busy && <i className="status-dot" />}
          </button>
          <WindowControls />
        </div>
      </header>
      <aside className="context-sidebar" aria-label={section === 'launch' ? '启动操作' : '功能导航'}>
        {section === 'launch' ? (
          <LaunchPanel
            accounts={accounts}
            instance={selectedInstance}
            loading={loading}
            busy={busy}
            running={!!selectedInstance && instanceRunning(selectedInstance)}
            installing={activeDownload?.instanceId === selectedId}
            onAccount={(id) => void selectAccount(id)}
            onAccounts={() => navigate('accounts')}
            onVersions={() => navigate('library')}
            onSettings={() => selectedInstance && openSettings(selectedInstance)}
            onPrimary={() =>
              selectedInstance
                ? selectedInstance.installed
                  ? openLaunch(selectedInstance)
                  : void install(selectedInstance)
                : navigate('downloads')
            }
            onTasks={() => navigate('tasks')}
          />
        ) : (
          <>
            <div className="context-heading">
              <span>{section === 'download' ? '游戏下载' : '启动器设置'}</span>
              <small>{section === 'download' ? '安装与管理你的游戏' : '账号、版本与运行环境'}</small>
            </div>
            <nav className="context-nav" aria-label="功能导航">
              {section === 'download' ? (
                <>
                  <button
                    className={page === 'downloads' ? 'selected' : ''}
                    onClick={() => navigate('downloads')}
                  >
                    <Download size={18} />
                    自动安装
                  </button>
                  <button
                    className={page === 'components' ? 'selected' : ''}
                    disabled={!contextInstance}
                    onClick={() => contextInstance && openComponents(contextInstance)}
                  >
                    <Layers3 size={18} />
                    组件管理
                  </button>
                  <button className={page === 'tasks' ? 'selected' : ''} onClick={() => navigate('tasks')}>
                    <Terminal size={18} />
                    任务与日志
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={page === 'accounts' ? 'selected' : ''}
                    onClick={() => navigate('accounts')}
                  >
                    <UserRound size={18} />
                    账号管理<span>{accounts.accounts.length}</span>
                  </button>
                  <button
                    className={page === 'environment' ? 'selected' : ''}
                    onClick={() => navigate('environment')}
                  >
                    <Coffee size={18} />
                    运行环境
                  </button>
                  <button
                    className={page === 'settings' ? 'selected' : ''}
                    disabled={!contextInstance}
                    onClick={() => contextInstance && openSettings(contextInstance)}
                  >
                    <Settings2 size={18} />
                    版本设置
                  </button>
                </>
              )}
            </nav>
            <div className="context-current">
              <small>当前游戏实例</small>
              <strong>{contextInstance?.name ?? '尚未选择'}</strong>
              <span>{contextInstance ? `Minecraft ${contextInstance.versionId}` : '先创建一个游戏实例'}</span>
              <button className="text-button" onClick={() => navigate('library')}>
                游戏库 / 切换版本
                <ChevronRight size={13} />
              </button>
            </div>
            <button className="context-back" onClick={() => navigate('home')}>
              <ArrowLeft size={15} />
              返回启动
            </button>
          </>
        )}
      </aside>
      <main className="workspace" id="main-content">
        {activeDownload && (
          <div className="download-sticky">
            <DownloadDock
              task={activeDownload}
              name={
                instances.find((instance) => instance.id === activeDownload.instanceId)?.name ?? '游戏实例'
              }
              onCancel={() => void manage('cancel', activeDownload.id)}
            />
          </div>
        )}
        <div className="content" key={page}>
          {error && (
            <div className="alert error" role="alert">
              <TriangleAlert size={19} />
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="关闭错误">
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'components' && settingsInstance ? (
            <ComponentsPage
              key={settingsInstance.id}
              instance={settingsInstance}
              onBack={() => {
                void loadInstances(true);
                navigate('library');
              }}
              onSaved={(updated) => {
                setInstances((current) =>
                  current.map((instance) =>
                    instance.id === updated.id ? { ...instance, ...updated } : instance,
                  ),
                );
                setSettingsInstance(updated);
              }}
            />
          ) : page === 'accounts' ? (
            <AccountsPage collection={accounts} onChange={setAccounts} />
          ) : page === 'settings' && settingsInstance ? (
            <InstanceSettingsPage
              key={settingsInstance.id}
              instance={settingsInstance}
              environment={environment}
              accounts={accounts}
              onBack={() => navigate('library')}
              onSaved={(updated) => {
                setInstances((current) =>
                  current.map((instance) =>
                    instance.id === updated.id ? { ...instance, ...updated } : instance,
                  ),
                );
                setSettingsInstance(updated);
              }}
            />
          ) : page === 'home' ? (
            <>
              <LauncherHome
                instances={instances}
                selected={selectedInstance}
                onSelect={selectInstance}
                onVersions={() => navigate('library')}
                onDownload={() => navigate('downloads')}
                onComponents={() => selectedInstance && openComponents(selectedInstance)}
                onSettings={() => selectedInstance && openSettings(selectedInstance)}
                onDirectory={() => selectedInstance && void openDirectory(selectedInstance)}
                onEnvironment={() => navigate('environment')}
              />
              <ActivityPanel
                activity={activity}
                instances={instances}
                onCancel={(id) => void manage('cancel', id)}
                onStop={(id) => void manage('stop', id)}
              />
            </>
          ) : page === 'library' ? (
            <VersionLibrary
              instances={instances}
              filtered={filtered}
              selectedId={selectedId}
              loading={loading}
              query={query}
              onQuery={setQuery}
              onCreate={openCreate}
              onSelect={selectInstance}
              onSettings={openSettings}
              onComponents={openComponents}
              onDirectory={(instance) => void openDirectory(instance)}
              onCheck={(instance) => void checkInstance(instance)}
              checking={checking}
              onInstall={(instance) => void install(instance)}
              onLaunch={openLaunch}
              isBusy={(instance) => busy || instanceRunning(instance)}
            />
          ) : page === 'downloads' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>下载游戏</h1>
                  <p>选择游戏版本，一次完成原版与组件安装。</p>
                </div>
                <button
                  className="button secondary"
                  disabled={catalogLoading || saving}
                  onClick={() => void loadCatalog()}
                >
                  <RefreshCw size={16} className={catalogLoading ? 'spin' : ''} />
                  刷新版本
                </button>
              </div>
              <div className="install-workspace">
                <section className="install-builder">{createForm}</section>
                <aside className="install-overview">
                  <span className="overview-icon">
                    <Box size={27} />
                  </span>
                  <h2>{versionId ? `Minecraft ${versionId}` : '选择游戏版本'}</h2>
                  <p>{componentLabel(components)}</p>
                  <dl>
                    <div>
                      <dt>游戏目录</dt>
                      <dd>每个实例独立</dd>
                    </div>
                  </dl>
                  <div className="install-hint">
                    <ShieldCheck size={18} />
                    <p>安装前会检查组件兼容性，下载时校验文件完整性。可随时查看进度或取消任务。</p>
                  </div>
                  <button className="text-button" onClick={() => navigate('library')}>
                    查看本机版本
                    <ChevronRight size={14} />
                  </button>
                </aside>
              </div>
            </>
          ) : page === 'tasks' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>任务与日志</h1>
                  <p>查看安装进度、游戏进程和运行日志。</p>
                </div>
              </div>
              {activity.tasks.length || activity.sessions.length ? (
                <ActivityPanel
                  activity={activity}
                  instances={instances}
                  onCancel={(id) => void manage('cancel', id)}
                  onStop={(id) => void manage('stop', id)}
                />
              ) : (
                <div className="empty-state">
                  <Terminal size={30} />
                  <h3>当前没有任务</h3>
                  <p>安装游戏或启动实例后，进度与日志会显示在这里。</p>
                  <button className="button secondary" onClick={() => navigate('downloads')}>
                    下载游戏
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>运行环境</h1>
                  <p>找到适合游戏版本的 Java。</p>
                </div>
                <button className="button secondary" disabled={scanning} onClick={() => void scan()}>
                  <RefreshCw className={scanning ? 'spin' : ''} size={17} />
                  {scanning ? '正在检测' : '重新检测'}
                </button>
              </div>
              <div className="environment-summary">
                <div>
                  <HardDrive size={22} />
                  <span>操作系统</span>
                  <strong>{environment ? osNames[environment.os] : '正在读取'}</strong>
                </div>
                <div>
                  <Coffee size={22} />
                  <span>可用 Java</span>
                  <strong>
                    {environment?.java.length ?? '—'} <small>个</small>
                  </strong>
                </div>
              </div>
              <section className="runtime-panel">
                <div className="section-heading">
                  <h2>本机 Java</h2>
                  <span>启动游戏时会自动选择合适的版本</span>
                </div>
                {scanning ? (
                  <div className="empty-state compact">
                    <LoaderCircle className="spin" size={24} />
                    <p>正在检测 Java 安装</p>
                  </div>
                ) : environment?.java.length ? (
                  environment.java.map((java) => (
                    <div className="java-row" key={java.id}>
                      <span className="java-icon">
                        <Coffee size={23} />
                      </span>
                      <div>
                        <strong>Java {java.major}</strong>
                        <p>{java.vendor}</p>
                      </div>
                      <CheckCircle2 className="success-icon" size={19} />
                    </div>
                  ))
                ) : (
                  <div className="empty-state compact">
                    <Coffee size={28} />
                    <h3>尚未找到可用 Java</h3>
                    <p>安装与游戏版本匹配的 Java 后，点击「重新检测」。</p>
                  </div>
                )}
              </section>
              <div className="environment-note">
                <ShieldCheck size={19} />
                <div>
                  <strong>按游戏版本匹配 Java</strong>
                  <p>例如，Minecraft 1.20.1 使用 Java 17，1.21.1 使用 Java 21。创建实例后可检查对应需求。</p>
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      {createOpen && (
        <Modal
          title="创建游戏实例"
          busy={saving}
          onClose={() => {
            if (!saving) setCreateOpen(false);
          }}
        >
          {createForm}
        </Modal>
      )}
      {check && (
        <Modal title="启动条件检查" onClose={() => setCheck(undefined)}>
          <div className={`check-status ${check.status === 'compatible-java-found' ? 'check-ready' : ''}`}>
            {check.status === 'compatible-java-found' ? (
              <CheckCircle2 size={28} />
            ) : (
              <TriangleAlert size={28} />
            )}
            <div>
              <h3>
                {check.status === 'compatible-java-found'
                  ? '已找到匹配的 Java'
                  : check.status === 'java-required'
                    ? `需要 Java ${check.recommendedJavaMajor}`
                    : '暂不支持启动检查'}
              </h3>
              <p>Minecraft {check.versionId}</p>
            </div>
          </div>
          <dl className="check-details">
            <div>
              <dt>推荐 Java</dt>
              <dd>{check.recommendedJavaMajor ? `Java ${check.recommendedJavaMajor}` : '尚未确定'}</dd>
            </div>
            <div>
              <dt>本机已安装</dt>
              <dd>
                {check.selectedJava
                  ? `${check.selectedJava.vendor} Java ${check.selectedJava.major}`
                  : '尚未找到'}
              </dd>
            </div>
          </dl>
          <div className="check-notices">
            {check.notices.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => {
                setCheck(undefined);
                navigate('environment');
              }}
            >
              查看运行环境
            </button>
            <button className="button primary" onClick={() => setCheck(undefined)}>
              <Check size={17} />
              完成
            </button>
          </div>
        </Modal>
      )}
      {launchInstance && (
        <Modal
          title={
            accounts.accounts.find((account) => account.id === launchAccountId)?.kind === 'microsoft'
              ? '正版启动'
              : '离线启动'
          }
          busy={starting}
          onClose={() => {
            if (!starting) setLaunchInstance(undefined);
          }}
        >
          <p className="dialog-description">
            {launchInstance.name} · Minecraft {launchInstance.versionId}
          </p>
          <form onSubmit={(event) => void launch(event)}>
            <label className="field">
              启动账号
              <select
                autoFocus
                required
                value={launchAccountId}
                onChange={(event) => setLaunchAccountId(event.target.value)}
              >
                {accounts.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.playerName}（{account.kind === 'microsoft' ? 'Microsoft' : '离线'}）
                  </option>
                ))}
              </select>
            </label>
            <div className="form-note">
              <ShieldCheck size={18} />
              <span>
                {accounts.accounts.find((account) => account.id === launchAccountId)?.kind === 'microsoft'
                  ? '启动前会验证账号许可，必要时自动刷新微软授权。'
                  : '离线身份用于本地游戏，不具备正版服务器认证能力。'}
              </span>
            </div>
            <div className="dialog-actions">
              <button type="button" className="button quiet" disabled={starting} data-close-dialog>
                取消
              </button>
              <button type="submit" className="button primary" disabled={starting}>
                <Play size={16} />
                {accounts.accounts.find((account) => account.id === launchAccountId)?.kind === 'microsoft'
                  ? '启动正版游戏'
                  : '启动离线游戏'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {notice}
        </div>
      )}
    </div>
  );
}
