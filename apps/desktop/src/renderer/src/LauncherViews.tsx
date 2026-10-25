import {
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Coffee,
  Download,
  FolderLock,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  Search,
  Settings2,
  UserRound,
} from 'lucide-react';
import type { AccountCollection, InstanceSummary } from '@hunaumcl/contracts';
import { vanillaComponents } from '@hunaumcl/contracts';
import { componentLabel } from './ComponentsPage';
import { MicrosoftMark } from './MicrosoftLoginPanel';

export function Landscape() {
  return (
    <svg className="landscape" viewBox="0 0 720 300" preserveAspectRatio="none" aria-hidden="true">
      <path fill="#dfedf4" d="M0 0h720v300H0z" />
      <path fill="#f6fbfd" d="M515 39h54v12h31v15h-85zm-401 34h33V59h57v14h31v15H114z" />
      <path
        fill="#bad3e1"
        d="M0 212h45v-32h49v-33h40v-27h43v34h50v32h50v-45h42v-35h40V76h45v39h40v33h48v38h66v-24h54v-34h45v37h53v39h40v96H0z"
      />
      <path
        fill="#8eb6c7"
        d="M219 300v-63h55v-35h43v-24h42v-33h42v-29h37v35h43v29h47v41h63v-22h49v-34h40v44h40v91z"
      />
      <path fill="#51899c" d="M373 300v-34h50v-31h44v-35h43v-34h38v37h41v27h48v-22h38v-29h45v121z" />
      <path fill="#2b607a" d="M521 300v-34h45v-27h48v-25h37v29h32v-11h37v68z" />
      <path fill="#356b7c" d="M295 223h10v77h-10z" />
      <path fill="#6d9b9a" d="M275 187h51v40h-51z" />
      <path fill="#85acab" d="M282 173h37v24h-37z" />
      <path fill="#44798b" d="M673 146h9v68h-9z" />
      <path fill="#6b969a" d="M656 121h43v34h-43z" />
    </svg>
  );
}

export function LaunchPanel({
  accounts,
  instance,
  loading,
  busy,
  running,
  onAccount,
  onAccounts,
  onVersions,
  onSettings,
  onPrimary,
  onTasks,
  installing,
}: {
  accounts: AccountCollection;
  instance?: InstanceSummary;
  loading: boolean;
  busy: boolean;
  running: boolean;
  installing: boolean;
  onAccount: (id: string) => void;
  onAccounts: () => void;
  onVersions: () => void;
  onSettings: () => void;
  onPrimary: () => void;
  onTasks: () => void;
}) {
  const current = accounts.accounts.find((account) => account.id === accounts.selectedId);
  const bound = accounts.accounts.find((account) => account.id === instance?.settings?.accountId);
  return (
    <div className="launch-panel">
      <div className="launch-panel-label">
        <span className="status-dot" />
        本地游戏
      </div>
      <div className="launch-identity">
        <div className="identity-avatar" aria-hidden="true">
          {current?.kind === 'microsoft' ? <MicrosoftMark /> : <UserRound size={35} strokeWidth={1.4} />}
        </div>
        <strong>{current?.playerName ?? '添加你的游戏身份'}</strong>
        <span>
          {current?.kind === 'microsoft' ? 'Microsoft 正版账号' : current ? '离线账号' : '选择账号，开始冒险'}
        </span>
        {accounts.accounts.length > 0 && (
          <label className="identity-select">
            <span className="sr-only">当前启动账号</span>
            <select value={accounts.selectedId ?? ''} onChange={(event) => onAccount(event.target.value)}>
              {accounts.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.playerName}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="text-button" onClick={onAccounts}>
          {current ? '管理账号' : '登录 / 添加账号'}
          <ChevronRight size={13} />
        </button>
        {instance?.settings?.accountId && (
          <p className="bound-account">此版本使用：{bound?.playerName ?? '绑定账号已删除'}</p>
        )}
      </div>
      <div className="launch-controls">
        <button className="selected-version" onClick={onVersions} aria-label="选择游戏版本">
          <Box size={22} />
          <span>
            <small>当前版本</small>
            <strong>{loading ? '正在读取…' : (instance?.name ?? '尚未选择版本')}</strong>
            <em>
              {instance
                ? `${instance.versionId} / ${instance.loader === 'vanilla' ? (instance.components?.optifine ? 'OptiFine' : '原版') : instance.loader}`
                : '前往创建第一个游戏实例'}
            </em>
          </span>
          <ChevronRight size={16} />
        </button>
        <button
          className="launch-primary"
          disabled={loading || (instance !== undefined && (busy || running))}
          onClick={onPrimary}
        >
          {installing ? (
            <LoaderCircle className="spin" size={24} />
          ) : instance?.installed ? (
            <Play size={24} fill="currentColor" />
          ) : (
            <Download size={23} />
          )}
          <span>
            <strong>
              {installing
                ? '正在安装'
                : running
                  ? '游戏运行中'
                  : instance?.installed
                    ? '启动游戏'
                    : instance
                      ? '安装游戏'
                      : '下载游戏'}
            </strong>
            <small>
              {installing
                ? '可在右侧查看进度'
                : running
                  ? '可在任务与日志中结束进程'
                  : instance?.installed
                    ? (bound ?? current)?.kind === 'microsoft'
                      ? '验证正版账号并进入 Minecraft'
                      : '使用离线账号进入 Minecraft'
                    : '选择版本与模组加载器'}
            </small>
          </span>
        </button>
        <div className="launch-secondary">
          <button onClick={onVersions}>
            <Layers3 size={15} />
            版本选择
          </button>
          <button disabled={!instance} onClick={onSettings}>
            <Settings2 size={15} />
            版本设置
          </button>
        </div>
        <button className="launch-task-link" onClick={onTasks}>
          任务与日志
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}

export function LauncherHome({
  instances,
  selected,
  onSelect,
  onVersions,
  onDownload,
  onComponents,
  onSettings,
  onDirectory,
  onEnvironment,
}: {
  instances: InstanceSummary[];
  selected?: InstanceSummary;
  onSelect: (instance: InstanceSummary) => void;
  onVersions: () => void;
  onDownload: () => void;
  onComponents: () => void;
  onSettings: () => void;
  onDirectory: () => void;
  onEnvironment: () => void;
}) {
  const isolation = selected?.settings?.isolation ?? 'isolated';
  return (
    <div className="launcher-home">
      <section className="home-landscape">
        <Landscape />
        <div className="home-welcome">
          <span>HUNAUMCL</span>
          <h1>下一段冒险，从这里开始。</h1>
          <p>选好版本，回到你的方块世界。</p>
        </div>
      </section>
      <section className="home-section current-game">
        <div className="section-heading">
          <h2>准备启动</h2>
          <button className="text-button" onClick={onVersions}>
            切换版本
            <ChevronRight size={14} />
          </button>
        </div>
        {selected ? (
          <>
            <div className="current-game-heading">
              <span className="game-block">
                <Box size={30} strokeWidth={1.4} />
              </span>
              <div>
                <h2>{selected.name}</h2>
                <p>
                  Minecraft {selected.versionId}
                  <span className="inline-separator">/</span>
                  {componentLabel(selected.components ?? vanillaComponents)}
                </p>
              </div>
              <span className={`game-status${selected.installed ? ' ready' : ''}`}>
                {selected.installed ? <Check size={13} /> : <Download size={13} />}
                {selected.installed ? '已安装' : '等待安装'}
              </span>
            </div>
            <div className="game-properties">
              <span>
                <FolderLock size={15} />
                {isolation === 'shared'
                  ? '共享游戏目录'
                  : isolation === 'auto'
                    ? '自动版本隔离'
                    : '独立游戏目录'}
              </span>
              <button onClick={onSettings}>
                <Settings2 size={15} />
                版本设置
              </button>
              <button onClick={onDirectory}>
                <FolderOpen size={15} />
                打开游戏目录
              </button>
            </div>
          </>
        ) : (
          <div className="home-empty">
            <Box size={30} strokeWidth={1.4} />
            <div>
              <h2>还没有游戏版本</h2>
              <p>选择 Minecraft 版本，也可以同时安装加载器与 OptiFine。</p>
            </div>
            <button className="button primary" onClick={onDownload}>
              <Plus size={16} />
              下载游戏
            </button>
          </div>
        )}
      </section>
      <div className="home-bottom-grid">
        <section className="home-section home-versions">
          <div className="section-heading">
            <h2>我的版本</h2>
            <button className="text-button" onClick={onVersions}>
              全部 {instances.length} 个<ChevronRight size={13} />
            </button>
          </div>
          {instances.length ? (
            instances
              .slice(-3)
              .reverse()
              .map((instance) => (
                <button
                  key={instance.id}
                  className="recent-version"
                  onClick={() => onSelect(instance)}
                  aria-label={`在首页选择 ${instance.name}`}
                >
                  <Box size={19} />
                  <span>
                    <strong>{instance.name}</strong>
                    <small>
                      {instance.versionId} / {instance.loader === 'vanilla' ? '原版' : instance.loader}
                    </small>
                  </span>
                  {selected?.id === instance.id ? <Check size={16} /> : <ChevronRight size={14} />}
                </button>
              ))
          ) : (
            <p className="home-placeholder">创建后，游戏版本会显示在这里。</p>
          )}
        </section>
        <section className="home-section home-shortcuts">
          <div className="section-heading">
            <h2>游戏管理</h2>
          </div>
          <button onClick={onDownload}>
            <Download size={19} />
            <span>
              <strong>下载新版本</strong>
              <small>原版与模组加载器自动安装</small>
            </span>
            <ChevronRight size={14} />
          </button>
          <button onClick={selected ? onComponents : onDownload}>
            <Layers3 size={19} />
            <span>
              <strong>加载器与高清修复</strong>
              <small>Forge / NeoForge / Fabric / OptiFine</small>
            </span>
            <ChevronRight size={14} />
          </button>
          <button onClick={onEnvironment}>
            <Coffee size={19} />
            <span>
              <strong>Java 运行环境</strong>
              <small>检测本机安装与版本兼容性</small>
            </span>
            <ChevronRight size={14} />
          </button>
        </section>
      </div>
    </div>
  );
}

export function VersionLibrary({
  instances,
  filtered,
  selectedId,
  loading,
  query,
  onQuery,
  onCreate,
  onSelect,
  onSettings,
  onComponents,
  onDirectory,
  onCheck,
  checking,
  onInstall,
  onLaunch,
  isBusy,
}: {
  instances: InstanceSummary[];
  filtered: InstanceSummary[];
  selectedId: string;
  loading: boolean;
  query: string;
  onQuery: (value: string) => void;
  onCreate: () => void;
  onSelect: (instance: InstanceSummary) => void;
  onSettings: (instance: InstanceSummary) => void;
  onComponents: (instance: InstanceSummary) => void;
  onDirectory: (instance: InstanceSummary) => void;
  onCheck: (instance: InstanceSummary) => void;
  checking?: string;
  onInstall: (instance: InstanceSummary) => void;
  onLaunch: (instance: InstanceSummary) => void;
  isBusy: (instance: InstanceSummary) => boolean;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>版本选择</h1>
          <p>选择要启动的实例，或单独管理它的组件与游戏设置。</p>
        </div>
        <button className="button primary" onClick={onCreate}>
          <Plus size={17} />
          创建实例
        </button>
      </div>
      <div className="library-toolbar">
        <div>
          <h2>游戏库</h2>
          <span>{instances.length} 个实例</span>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="搜索实例"
            placeholder="搜索名称或版本"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>
      {loading ? (
        <div className="empty-state">
          <LoaderCircle className="spin" size={28} />
          <p>正在读取游戏库</p>
        </div>
      ) : instances.length === 0 ? (
        <div className="empty-state">
          <FolderOpen size={32} />
          <h3>这里还没有游戏实例</h3>
          <p>选择 Minecraft 版本，创建你的第一个实例。</p>
          <button className="button secondary" onClick={onCreate}>
            <Plus size={17} />
            创建第一个实例
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Search size={28} />
          <h3>没有找到匹配的实例</h3>
          <p>试试其他名称或版本。</p>
        </div>
      ) : (
        <div className="version-list">
          {filtered.map((instance) => (
            <article
              key={instance.id}
              className={`version-row${selectedId === instance.id ? ' version-selected' : ''}`}
            >
              <div className="version-row-main">
                <span className="game-block">
                  <Box size={28} />
                </span>
                <button
                  className="version-title"
                  onClick={() => onSelect(instance)}
                  aria-label={`选择实例 ${instance.name}`}
                >
                  <h3>{instance.name}</h3>
                  <p>
                    Minecraft {instance.versionId} /{' '}
                    {componentLabel(instance.components ?? vanillaComponents)}
                  </p>
                </button>
                <span className="tag">{instance.installed ? '已安装' : '未安装'}</span>
                <button
                  className="icon-button"
                  aria-label={`设置 ${instance.name}`}
                  onClick={() => onSettings(instance)}
                >
                  <Settings2 size={18} />
                </button>
              </div>
              {instance.installedComponents &&
                JSON.stringify(instance.installedComponents) !==
                  JSON.stringify(instance.components ?? vanillaComponents) && (
                  <p className="component-warning">组件选择尚未安装，启动仍使用上次成功的配置。</p>
                )}
              <div className="version-row-tools">
                <button onClick={() => onComponents(instance)}>
                  <Layers3 size={14} />
                  组件安装
                </button>
                <button onClick={() => onDirectory(instance)}>
                  <FolderOpen size={14} />
                  游戏目录
                </button>
                <button
                  aria-label={`检查 ${instance.name} 的启动条件`}
                  disabled={checking !== undefined}
                  onClick={() => onCheck(instance)}
                >
                  {checking === instance.id ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Coffee size={14} />
                  )}
                  启动检查
                </button>
                <span className="version-tool-spacer" />
                <button
                  disabled={isBusy(instance)}
                  aria-label={`${instance.installed ? '校验' : '安装'} ${instance.name}`}
                  onClick={() => onInstall(instance)}
                >
                  <Download size={14} />
                  {instance.installed ? '校验文件' : '安装游戏'}
                </button>
                {instance.installed && (
                  <button
                    className="version-launch"
                    disabled={isBusy(instance)}
                    onClick={() => onLaunch(instance)}
                  >
                    <Play size={14} />
                    启动游戏
                  </button>
                )}
              </div>
              <button
                className="version-select-action"
                aria-pressed={selectedId === instance.id}
                onClick={() => onSelect(instance)}
              >
                {selectedId === instance.id ? <Check size={14} /> : <ArrowRight size={14} />}
                {selectedId === instance.id ? '当前选择，返回启动' : '选择并返回启动'}
              </button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
