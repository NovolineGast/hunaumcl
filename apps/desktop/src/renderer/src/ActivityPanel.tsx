import { useEffect, useRef } from 'react';
import { Download, LoaderCircle, Square, Terminal, X } from 'lucide-react';
import type { ActivitySnapshot, InstanceSummary } from '@hunaumcl/contracts';
import { formatBytes, formatTransfer } from './DownloadDock';

export function ActivityPanel({
  activity,
  instances,
  onCancel,
  onStop,
}: {
  activity: ActivitySnapshot;
  instances: InstanceSummary[];
  onCancel: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const logArea = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const current = activity.sessions.at(-1);
  const lastSequence = current?.logs.at(-1)?.sequence;
  useEffect(() => {
    if (following.current && logArea.current) logArea.current.scrollTop = logArea.current.scrollHeight;
  }, [lastSequence]);
  if (!activity.tasks.length && !activity.sessions.length) return null;
  const title = (id: string) => instances.find((instance) => instance.id === id)?.name ?? '游戏实例';
  return (
    <section className="activity-panel" aria-label="后台任务与游戏日志">
      <div className="section-heading">
        <h2>任务与日志</h2>
      </div>
      {activity.tasks
        .slice(-3)
        .reverse()
        .map((task) => (
          <div className="task-row" key={task.id}>
            {['running', 'cancelling'].includes(task.state) ? (
              <LoaderCircle size={19} className="spin" />
            ) : (
              <Download size={19} />
            )}
            <div className="task-details">
              <strong>
                {title(task.instanceId)} · {task.kind === 'install' ? '安装' : '启动游戏'}
              </strong>
              <p>{task.error?.message ?? task.stage}</p>
              {task.download && (
                <div className="task-transfer-detail">
                  <span>{formatTransfer(task.download)}</span>
                  <span>{formatBytes(task.download.bytesPerSecond)}/s</span>
                </div>
              )}
              {task.state === 'running' && task.total > 0 && (
                <progress
                  max={1}
                  value={task.progress ?? task.completed / task.total}
                  aria-label="文件进度"
                />
              )}
            </div>
            {task.state === 'running' && (
              <button className="button quiet" onClick={() => onCancel(task.id)}>
                <X size={15} />
                取消
              </button>
            )}
            {task.state === 'failed' && <span className="task-failed">未完成</span>}
          </div>
        ))}
      {activity.sessions
        .slice(-3)
        .reverse()
        .map((session) => (
          <div className="session-header" key={session.id}>
            <Terminal size={17} />
            <span>
              {title(session.instanceId)} / {session.identity === 'microsoft' ? 'Microsoft' : '离线'}：
              {session.playerName}
            </span>
            <span className="session-state">
              {session.state === 'running'
                ? '游戏运行中'
                : session.state === 'stopping'
                  ? '正在结束'
                  : session.state === 'failed'
                    ? '异常退出'
                    : '已结束'}
            </span>
            {session.state === 'running' && (
              <button className="button quiet" onClick={() => onStop(session.id)}>
                <Square size={13} />
                结束游戏
              </button>
            )}
          </div>
        ))}
      {current && (
        <div
          className="log-console"
          role="log"
          aria-label="游戏日志"
          ref={logArea}
          onScroll={() => {
            const area = logArea.current;
            if (area) following.current = area.scrollHeight - area.scrollTop - area.clientHeight < 50;
          }}
        >
          {current.logs.length === 0 ? (
            <p>等待游戏输出…</p>
          ) : (
            current.logs.map((line) => (
              <div key={line.sequence} className={line.stream === 'stderr' ? 'log-stderr' : ''}>
                {line.text}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
