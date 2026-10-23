import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function ObservationDialog({ assignment, contextLabel, members, pending, error, onClose, onSave }) {
  const id = useId();
  const dialog = useRef(null);
  const input = useRef(null);
  const current = useRef({ pending, onClose });
  current.current = { pending, onClose };
  const [text, setText] = useState(assignment.displayPrefix || '');
  const value = text.trim();
  const invalid = /[()\x00-\x1f\x7f]/.test(value);
  const unchanged = value === (assignment.displayPrefix || '');
  useEffect(() => {
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape' && !current.current.pending) { event.preventDefault(); current.current.onClose(); }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.current.querySelectorAll('button:not([disabled]),input:not([disabled])')];
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); dialog.current.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keydown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div className="modal-backdrop observation-backdrop" role="presentation">
    <section className="edit-modal observation-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={pending}>
      <div className="modal-header"><div><span className="eyebrow">ANOTAÇÃO DO SERVIÇO</span><h2 id={`${id}-title`}>Observação</h2></div><button type="button" className="close-button" aria-label="Fechar observação" disabled={pending} onClick={onClose}>×</button></div>
      <p className="observation-context">{contextLabel}</p>
      <form onSubmit={(event) => { event.preventDefault(); if (!invalid && !unchanged && !pending) onSave(value || null); }}>
        <label htmlFor={`${id}-text`}>Texto da observação<input id={`${id}-text`} ref={input} list={`${id}-suggestions`} value={text} maxLength={160} disabled={pending} onChange={(event) => setText(event.target.value)} placeholder="Ex.: Sgt Jansen, ATESTADO, DISPENSADO" autoComplete="off" aria-describedby={`${id}-help`} aria-invalid={invalid} /></label>
        <datalist id={`${id}-suggestions`}><option value="ATESTADO" /><option value="DISPENSADO" /><option value="LICENÇA" />{members.filter((member) => member.id !== assignment.memberId).map((member) => <option key={member.id} value={`${member.rank} ${member.operational_name}`} />)}</datalist>
        <div className="observation-input-meta"><small id={`${id}-help`}>Escreva sem parênteses. Eles são colocados automaticamente.</small><small>{text.length}/160</small></div>
        <div className="observation-preview"><span>Como aparecerá na escala</span><strong>{assignment.rank} {assignment.operationalName}{value ? ` (${value})` : ''}</strong></div>
        <p className="observation-help">A anotação vale somente para este dia e turno. Ela aparece depois do nome no painel e no PDF, mantendo o militar, a coluna, o tipo de serviço e as horas.</p>
        {text && <button type="button" className="secondary-button observation-clear" disabled={pending} onClick={() => setText('')}>Limpar texto</button>}
        {(invalid || error) && <p className="error" role="alert">{invalid ? 'Use uma única linha, sem parênteses.' : error}</p>}
        <div className="form-actions"><button type="button" className="secondary-button" disabled={pending} onClick={onClose}>Cancelar</button><button type="submit" disabled={pending || invalid || unchanged}>{pending ? 'Salvando…' : value ? 'Salvar observação' : 'Remover observação'}</button></div>
      </form>
    </section>
  </div>, document.body);
}
