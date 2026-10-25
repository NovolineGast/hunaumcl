import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Download, Layers3, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { FormEvent } from 'react';
import { componentCompatibilityError, componentsSchema, vanillaComponents } from '@hunaumcl/contracts';
import type {
  ComponentCatalog,
  ComponentVersion,
  InstanceComponents,
  InstanceSummary,
} from '@hunaumcl/contracts';

function compatible(required: string | null | undefined, forge: string | null): boolean {
  if (required == null || !forge) return false;
  if (!required.trim()) return true;
  return required.includes('.') ? required === forge : forge.split('.').at(-1) === required;
}
export function componentLabel(components: InstanceComponents = vanillaComponents): string {
  return [
    components.loader === 'vanilla'
      ? '原版'
      : `${loaderLabel(components.loader)} ${components.loaderVersion}`,
    components.optifine ? `OptiFine ${components.optifine}` : '',
    components.fabricApi ? 'Fabric API' : '',
    components.optifabric ? 'OptiFabric' : '',
  ]
    .filter(Boolean)
    .join(' + ');
}
function loaderLabel(loader: InstanceComponents['loader']): string {
  return loader === 'fabric'
    ? 'Fabric'
    : loader === 'forge'
      ? 'Forge'
      : loader === 'neoforge'
        ? 'NeoForge'
        : '原版';
}
export function ComponentPicker({
  minecraft,
  value,
  onChange,
  onLoaded,
}: {
  minecraft: string;
  value: InstanceComponents;
  onChange: (value: InstanceComponents) => void;
  onLoaded?: (catalog: ComponentCatalog) => void;
}) {
  const [catalog, setCatalog] = useState<ComponentCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setCatalog(undefined);
    setError('');
    void window.launcher
      .componentCatalog(minecraft)
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setCatalog(result.value);
          onLoaded?.(result.value);
        } else setError(result.error.message);
      })
      .catch(() => {
        if (active) setError('组件列表获取失败，请重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [minecraft, revision]);
  const options = (entries: ComponentVersion[] = []) =>
    entries.map((entry) => (
      <option value={entry.id} key={entry.id}>
        {entry.label}
        {entry.recommended ? '（推荐）' : ''}
        {entry.preview ? '（预览）' : ''}
      </option>
    ));
  const setLoader = (loader: InstanceComponents['loader']) =>
    onChange({ ...vanillaComponents, loader, loaderVersion: loader === 'vanilla' ? null : '' });
  const optical =
    catalog?.optifine.filter(
      (entry) =>
        value.loader !== 'neoforge' &&
        (value.loader !== 'forge' || compatible(entry.requiredForge, value.loaderVersion)),
    ) ?? [];
  const validation = componentsSchema.safeParse(value);
  const compatibilityError = componentCompatibilityError(minecraft, value);
  return (
    <div className="component-picker">
      <div className="component-picker-heading">
        <span>
          <Layers3 size={17} />
          模组加载器与高清修复
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新组件列表"
          onClick={() => setRevision((current) => current + 1)}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <div className="loader-tabs" role="group" aria-label="模组加载器">
        {(['vanilla', 'fabric', 'forge', 'neoforge'] as const).map((loader) => (
          <button
            type="button"
            key={loader}
            aria-pressed={value.loader === loader}
            onClick={() => setLoader(loader)}
          >
            {loaderLabel(loader)}
          </button>
        ))}
      </div>
      {loading && (
        <p className="component-loading">
          <LoaderCircle size={14} className="spin" />
          查询与 Minecraft {minecraft} 对应的组件版本…
        </p>
      )}
      {!loading && catalog && value.loader !== 'vanilla' && catalog[value.loader].length === 0 && (
        <p className="component-warning">
          这个 Minecraft 版本暂时没有可用的 {loaderLabel(value.loader)} 版本，请选择其他游戏版本。
        </p>
      )}
      {!loading && catalog && catalog.optifine.length === 0 && (
        <p className="component-warning">
          这个 Minecraft 版本暂时没有可用的 OptiFine，不能与其他游戏版本混用。
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {value.loader !== 'vanilla' && (
        <label className="field">
          加载器版本
          <select
            aria-label="加载器版本"
            required
            value={value.loaderVersion ?? ''}
            disabled={loading}
            onChange={(event) =>
              onChange({
                ...value,
                loaderVersion: event.target.value || null,
                optifine: null,
                optifabric: null,
              })
            }
          >
            <option value="">{loading ? '正在获取列表…' : '请选择版本'}</option>
            {options(catalog?.[value.loader])}
          </select>
        </label>
      )}
      <label className="field">
        OptiFine 高清修复
        <select
          aria-label="OptiFine 高清修复"
          value={value.optifine ?? ''}
          disabled={loading || value.loader === 'neoforge'}
          onChange={(event) =>
            onChange({
              ...value,
              optifine: event.target.value || null,
              optifabric: event.target.value ? value.optifabric : null,
            })
          }
        >
          <option value="">不安装 OptiFine</option>
          {options(optical)}
        </select>
        <small>
          {value.loader === 'neoforge'
            ? 'NeoForge 与 OptiFine 互斥。'
            : value.loader === 'forge'
              ? '仅列出与当前 Forge 声明兼容的 OptiFine。'
              : value.loader === 'fabric'
                ? '与 Fabric 组合时，需要同时选择匹配的 OptiFabric。'
                : '可直接安装到原版，也可搭配兼容的模组加载器。'}
        </small>
      </label>
      {value.loader === 'fabric' && (
        <>
          <label className="field">
            Fabric API
            <select
              aria-label="Fabric API"
              value={value.fabricApi ?? ''}
              disabled={loading}
              onChange={(event) => onChange({ ...value, fabricApi: event.target.value || null })}
            >
              <option value="">不安装（许多 Fabric 模组需要此组件）</option>
              {options(catalog?.fabricApi)}
            </select>
          </label>
          {value.optifine && (
            <label className="field">
              OptiFabric 兼容组件
              <select
                aria-label="OptiFabric 兼容组件"
                required
                value={value.optifabric ?? ''}
                disabled={loading}
                onChange={(event) => onChange({ ...value, optifabric: event.target.value || null })}
              >
                <option value="">请选择与当前游戏匹配的兼容组件</option>
                {options(catalog?.optifabric)}
              </select>
            </label>
          )}
        </>
      )}
      {catalog?.errors.map((message) => (
        <p className="component-warning" key={message}>
          {message}
        </p>
      ))}
      {compatibilityError && (
        <p className="component-warning" role="alert">
          {compatibilityError}
        </p>
      )}
      {!validation.success && (
        <p className="component-warning" role="alert">
          {validation.error.issues[0]?.message}
        </p>
      )}
    </div>
  );
}
export function ComponentsPage({
  instance,
  onBack,
  onSaved,
}: {
  instance: InstanceSummary;
  onBack: () => void;
  onSaved: (instance: InstanceSummary) => void;
}) {
  const [selection, setSelection] = useState<InstanceComponents>({
    ...(instance.components ?? vanillaComponents),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async (event: FormEvent, install = false) => {
    event.preventDefault();
    const valid = componentsSchema.safeParse(selection);
    if (!valid.success) {
      setError(valid.error.issues[0]?.message ?? '请检查组件组合');
      return;
    }
    const compatibilityError = componentCompatibilityError(instance.versionId, valid.data);
    if (compatibilityError) {
      setError(compatibilityError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await window.launcher.configureComponents({
        instanceId: instance.id,
        components: valid.data,
      });
      if (!result.ok) throw Error(result.error.message);
      onSaved(result.value);
      setSaved(true);
      if (install) {
        const task = await window.launcher.install(instance.id);
        if (!task.ok) throw Error(task.error.message);
        onBack();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '组件配置失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        返回游戏库
      </button>
      <div className="page-heading">
        <div>
          <h1>组件安装</h1>
          <p>
            {instance.name} / Minecraft {instance.versionId}
          </p>
        </div>
      </div>
      <div className="account-note">
        <ShieldCheck size={22} />
        <div>
          <strong>选择组件，安装成功后生效</strong>
          <p>安装失败时继续保留之前的启动配置与用户文件。组件更改保存后，需要安装才能生效。</p>
        </div>
      </div>
      <form onSubmit={(event) => void save(event)}>
        <ComponentPicker
          minecraft={instance.versionId}
          value={selection}
          onChange={(value) => {
            setSelection(value);
            setSaved(false);
          }}
        />
        <div className="component-summary">
          <span>已安装</span>
          <strong>{instance.installed ? componentLabel(instance.installedComponents) : '尚未安装'}</strong>
          <span>本次选择</span>
          <strong>{componentLabel(selection)}</strong>
        </div>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="submit" className="button secondary" disabled={busy}>
            {saved ? <Check size={16} /> : null}
            {saved ? '已保存选择' : '保存选择'}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={
              busy ||
              !componentsSchema.safeParse(selection).success ||
              !!componentCompatibilityError(instance.versionId, selection)
            }
            onClick={(event) => void save(event as unknown as FormEvent, true)}
          >
            <Download size={16} />
            {busy ? '正在准备' : '保存并安装组件'}
          </button>
        </div>
      </form>
    </>
  );
}
