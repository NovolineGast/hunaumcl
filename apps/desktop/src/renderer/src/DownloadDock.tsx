import { Download, LoaderCircle, X } from 'lucide-react';
import type { TaskSnapshot, DownloadProgress } from '@hunaumcl/contracts';
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
export function formatTransfer(download: Pick<DownloadProgress, 'completedBytes' | 'totalBytes'>): string {
  return download.totalBytes > 0
    ? `${formatBytes(download.completedBytes)} / ${formatBytes(download.totalBytes)}`
    : `${formatBytes(download.completedBytes)}（总大小未知）`;
}
function duration(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
export function DownloadDock({
  task,
  name,
  onCancel,
}: {
  task: TaskSnapshot;
  name: string;
  onCancel: () => void;
}) {
  const download = task.download;
  const percent = Math.min(99, Math.floor((task.progress ?? 0) * 100));
  return (
    <section className="download-dock" aria-label="下载进度">
      <div className="download-topline">
        <span className="download-symbol">
          <Download size={22} />
        </span>
        <div>
          <h2>
            {name}
            <span>{task.stage}</span>
          </h2>
          <p>
            {download?.currentFile ??
              (task.state === 'cancelling' ? '正在取消任务…' : '正在准备安装…')}
          </p>
        </div>
        <strong className="download-percent" aria-live="off">
          {percent}
          <small>%</small>
        </strong>
        <button
          className="icon-button"
          disabled={task.state === 'cancelling'}
          onClick={onCancel}
          aria-label="取消下载"
        >
          <X size={18} />
        </button>
      </div>
      <progress aria-label="总体安装进度" max={100} value={percent} />
      <div className="download-statline">
        <span>{download ? formatTransfer(download) : '正在准备文件'}</span>
        <span className="download-speed">
          {download?.bytesPerSecond ? (
            `${formatBytes(download.bytesPerSecond)}/s`
          ) : (
            <>
              <LoaderCircle className="spin" size={12} />
              {download?.cachedBytes ? '正在检查已有文件' : '等待下载数据'}
            </>
          )}
        </span>
        <span>{download?.etaSeconds ? `预计剩余 ${duration(download.etaSeconds)}` : '正在计算剩余时间'}</span>
        <span>
          {task.completed} / {task.total || '—'} 个文件
        </span>
      </div>
    </section>
  );
}
