import { useState } from 'react';
import { Check, CheckCircle2, Pencil, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import type { FormEvent } from 'react';
import type { AccountCollection, OfflineAccount, SavedAccount, Result } from '@hunaumcl/contracts';
import { Modal } from './Modal';
import { MicrosoftLoginPanel, MicrosoftMark } from './MicrosoftLoginPanel';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export function AccountsPage({
  collection,
  onChange,
}: {
  collection: AccountCollection;
  onChange: (next: AccountCollection) => void;
}) {
  const [editing, setEditing] = useState<OfflineAccount | 'new'>();
  const [removing, setRemoving] = useState<SavedAccount>();
  const [microsoftRequest, setMicrosoftRequest] = useState<{ accountId: string; revision: number }>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edit = (account: OfflineAccount | 'new') => {
    setError('');
    setName(account === 'new' ? '' : account.playerName);
    setEditing(account);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result =
        editing === 'new'
          ? await window.launcher.createAccount({ playerName: name })
          : await window.launcher.updateAccount({ id: editing!.id, playerName: name });
      onChange(unwrap(result));
      setEditing(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '账号保存失败');
    } finally {
      setBusy(false);
    }
  };
  const select = async (id: string) => {
    setError('');
    setBusy(true);
    try {
      onChange(unwrap(await window.launcher.selectAccount(id)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法切换账号');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setError('');
    setBusy(true);
    try {
      onChange(unwrap(await window.launcher.deleteAccount(removing.id)));
      setRemoving(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法删除账号');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>账号管理</h1>
          <p>保存你的游戏身份，为不同实例选择账号。</p>
        </div>
        <button className="button primary" onClick={() => edit('new')}>
          <Plus size={18} />
          添加离线账号
        </button>
      </div>
      {error && !editing && !removing && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <MicrosoftLoginPanel onChange={onChange} request={microsoftRequest} />
      {collection.accounts.length === 0 ? (
        <div className="empty-state">
          <UserRound size={32} />
          <h3>还没有保存的账号</h3>
          <p>登录 Microsoft 账号，或添加本地离线身份。</p>
          <button className="button secondary" onClick={() => edit('new')}>
            添加第一个账号
          </button>
        </div>
      ) : (
        <div className="account-list">
          {collection.accounts.map((account) => (
            <article
              className={`account-row${collection.selectedId === account.id ? ' account-selected' : ''}`}
              key={account.id}
            >
              <div className="player-avatar" aria-hidden="true">
                {account.kind === 'microsoft' ? <MicrosoftMark /> : account.playerName.slice(0, 2)}
              </div>
              <div className="account-info">
                <h2>
                  {account.playerName}
                  {collection.selectedId === account.id && (
                    <span className="selected-tag">
                      <Check size={12} />
                      当前账号
                    </span>
                  )}
                </h2>
                <p>
                  {account.kind === 'microsoft' ? (
                    <>
                      <span className="microsoft-account-badge">Microsoft</span>
                      {account.needsReauthentication
                        ? '需要重新登录'
                        : Date.parse(account.expiresAt) <= Date.now()
                          ? '启动时自动刷新'
                          : 'Java 版账号'}
                    </>
                  ) : (
                    '离线账号'
                  )}
                </p>
              </div>
              <div className="account-actions">
                {collection.selectedId !== account.id && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void select(account.id)}
                  >
                    <CheckCircle2 size={15} />
                    使用此账号
                  </button>
                )}
                {account.kind === 'offline' ? (
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`编辑账号 ${account.playerName}`}
                    onClick={() => edit(account)}
                  >
                    <Pencil size={17} />
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`重新登录 ${account.playerName}`}
                    onClick={() => setMicrosoftRequest({ accountId: account.id, revision: Date.now() })}
                  >
                    <RefreshCw size={17} />
                  </button>
                )}
                <button
                  className="icon-button danger-text"
                  disabled={busy}
                  aria-label={`删除账号 ${account.playerName}`}
                  onClick={() => {
                    setError('');
                    setRemoving(account);
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="settings-footnote">当前账号供所有未绑定账号的实例使用。每个实例也可以单独固定账号。</p>
      {editing && (
        <Modal
          title={editing === 'new' ? '添加离线账号' : '编辑离线账号'}
          busy={busy}
          onClose={() => setEditing(undefined)}
        >
          <form onSubmit={(event) => void save(event)}>
            <label className="field">
              玩家名称
              <input
                autoFocus
                required
                minLength={3}
                maxLength={16}
                pattern="[A-Za-z0-9_]+"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：Steve"
              />
            </label>
            <p className="form-note">
              名称需为 3–16 位字母、数字或下划线。
              {editing !== 'new'
                ? '修改名称会改变游戏内的玩家身份，已有存档可能受到影响。'
                : '首次添加的账号会自动成为当前账号。'}
            </p>
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="button quiet" disabled={busy} data-close-dialog>
                取消
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? '正在保存' : '保存账号'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          title={removing.kind === 'offline' ? '删除离线账号' : '移除 Microsoft 账号'}
          busy={busy}
          onClose={() => setRemoving(undefined)}
        >
          <p className="dialog-description">
            删除「{removing.playerName}
            」的本机账号记录。游戏文件与存档会保留，绑定此账号的实例需重新选择账号。
          </p>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="button quiet" disabled={busy} data-close-dialog>
              保留账号
            </button>
            <button className="button danger" disabled={busy} onClick={() => void remove()}>
              删除账号
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
