import { useEffect, useRef, type ReactNode } from 'react';

/** Native modality keeps background tools inert and returns focus to the opener. */
export default function Modal(props: { title: string; className?: string; closeKey?: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={`dialog ${props.className ?? ''}`}
      aria-label={props.title}
      onCancel={(event) => { event.preventDefault(); props.onClose(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (props.closeKey && event.key === props.closeKey) {
          event.preventDefault();
          props.onClose();
        }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, [tabindex="0"]')]
            .filter((element) => element.getClientRects().length > 0 && !element.hidden);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose();
      }}
    >
      {props.children}
    </dialog>
  );
}
