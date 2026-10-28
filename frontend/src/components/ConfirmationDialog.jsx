import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function ConfirmationDialog({ title, children, error, pending, confirmDisabled, confirmLabel,
  pendingLabel = 'Excluindo…', destructive = true, onClose, onConfirm }) {
  const titleId = useId();
  const dialog = useRef(null);
  const actions = useRef({ pending, onClose });
  actions.current = { pending, onClose };
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector('[data-confirm-cancel]')?.focus();
    const handleKey = (event) => {
      if (event.key === 'Escape' && !actions.current.pending) { event.preventDefault(); actions.current.onClose(); }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog.current?.querySelectorAll('button:not([disabled]),a[href]') || [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div className="modal-backdrop confirmation-backdrop" role="presentation">
    <section ref={dialog} className="edit-modal confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} aria-busy={pending}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><button type="button" className="close-button" disabled={pending} aria-label="Fechar confirmação" onClick={onClose}>×</button></div>
      <div className="confirmation-dialog-body">{children}{error && <p className="error" role="alert">{error}</p>}</div>
      <div className="form-actions"><button data-confirm-cancel type="button" className="secondary-button" disabled={pending} onClick={onClose}>Cancelar</button>
        <button type="button" className={destructive ? 'danger-button' : undefined} disabled={pending || confirmDisabled} onClick={onConfirm}>{pending ? pendingLabel : confirmLabel}</button></div>
    </section>
  </div>, document.body);
}
