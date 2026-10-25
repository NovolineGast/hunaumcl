import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callback = useRef(onClose);
  callback.current = onClose;
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      clearTimeout(timer.current);
      dialog.current?.close();
    };
  }, []);
  const close = () => {
    if (busy || closing) return;
    setClosing(true);
    timer.current = setTimeout(
      () => callback.current(),
      matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
    );
  };
  return (
    <dialog
      ref={dialog}
      className={`dialog${closing ? ' dialog-closing' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-close-dialog]')) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
