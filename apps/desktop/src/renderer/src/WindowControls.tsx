import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    void window.launcher.windowState().then((result) => {
      if (!disposed && result.ok) setMaximized(result.value.maximized);
    });
    const unsubscribe = window.launcher.onWindowStateChange((state) => {
      if (!disposed) setMaximized(state.maximized);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const toggleMaximize = async () => {
    const result = await window.launcher.windowToggleMaximize();
    if (result.ok) setMaximized(result.value.maximized);
  };
  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="window-control"
        aria-label="最小化"
        title="最小化"
        onClick={() => void window.launcher.windowMinimize()}
      >
        <Minus size={16} />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void toggleMaximize()}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="window-control window-close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void window.launcher.windowClose()}
      >
        <X size={16} />
      </button>
    </div>
  );
}
