import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { writtenDate } from '../utils/schedule-context.js';

const dateLabel = writtenDate;
const memberName = (member) => `${member.rank} ${member.operational_name}`;

export default function MemberWingSelect({ member, competencyId, data, editable, onFeedback, onOpenChange }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(null);
  const current = data?.memberships.find((row) => row.member_id === member.id);
  const next = data?.nextMemberships.find((row) => row.member_id === member.id);
  const today = new Date().toLocaleDateString('en-CA');
  const start = data ? `${data.competency.year}-${String(data.competency.month).padStart(2, '0')}-01` : '';
  const end = data ? `${start.slice(0, 8)}${new Date(data.competency.year, data.competency.month, 0).getDate()}` : '';
  const minDate = [start, today].sort().at(-1);
  const close = () => { setEditing(null); onOpenChange(false); };
  const move = useMutation({ mutationFn: () => {
    const entries = [{ memberId: member.id, wingId: editing.wingId, positionNumber: editing.positionNumber }];
    if (editing.partnerId) entries.push({ memberId: Number(editing.partnerId), wingId: next.wing_id, positionNumber: next.position_number });
    return api.post('/wings/move', { competencyId: Number(competencyId), scope: 'NEXT_MONTH', entries,
      applyToCurrentMonth: editing.applyCurrent, fromDate: editing.applyCurrent ? editing.fromDate : undefined });
  }, onSuccess: async (response) => {
    close(); onFeedback(response.data.message);
    await Promise.all(['wings', 'members', 'schedule-management', 'slots', 'dashboard'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  } });
  const open = (wingId) => {
    move.reset(); onOpenChange(true);
    setEditing({ wingId: Number(wingId), positionNumber: next?.position_number || current?.position_number || 1,
      applyCurrent: false, fromDate: minDate, partnerId: '' });
  };
  const futureLabel = next && (!current || next.wing_id !== current.wing_id || next.position_number !== current.position_number)
    ? `${data.wings.find((wing) => wing.id === next.wing_id)?.name} · ${next.position_number}ª em ${dateLabel(data.nextMonth.startsAt)}` : '';
  return <>
    <select className="status-select wing-select" aria-label={`Ala de ${memberName(member)}`} disabled={!editable || !data}
      value={(next || current)?.wing_id || ''} onChange={(event) => open(event.target.value)}>
      <option value="" disabled>Sem ala</option>{data?.wings.map((wing) => <option key={wing.id} value={wing.id}>{wing.name}</option>)}
    </select>
    {futureLabel && <small className="wing-table-note">Programado: {futureLabel}</small>}
    {editing && createPortal(<div className="modal-backdrop"><section className="edit-modal wings-modal" role="dialog" aria-modal="true" aria-label="Escolher ala do militar">
      <div className="modal-header"><div><span className="eyebrow">ALTERAR ALA</span><h2>{memberName(member)}</h2></div><button type="button" className="close-button" aria-label="Fechar" disabled={move.isPending} onClick={close}>×</button></div>
      {!data.configured ? <><p>Primeiro, cadastre as alas usando a escala de referência. Você poderá conferir e escolher a ala de cada militar antes de confirmar.</p><Link className="wings-link secondary-button" to="/alas">Cadastrar militares nas alas</Link><button className="secondary-button" onClick={close}>Cancelar</button></> : <form onSubmit={(event) => { event.preventDefault(); move.mutate(); }}>
        <div className="wings-import-notice"><strong>As mudanças valerão para o próximo mês, a partir de {dateLabel(data.nextMonth.startsAt)}.</strong><p>Se esse mês já foi gerado, use Regerar nele para aplicar a mudança.</p></div>
        <fieldset disabled={move.isPending} className="wing-edit-fields">
          <div className="form-grid"><label>Ala<select value={editing.wingId} onChange={(event) => setEditing({ ...editing, wingId: Number(event.target.value), partnerId: '' })}>{data.wings.map((wing) => <option key={wing.id} value={wing.id}>{wing.name}</option>)}</select></label>
            <label>Posição<select value={editing.positionNumber} onChange={(event) => setEditing({ ...editing, positionNumber: Number(event.target.value), partnerId: '' })}><option value={1}>1ª posição</option><option value={2}>2ª posição</option></select></label></div>
          {next && <label>Trocar com outro militar? (opcional)<select value={editing.partnerId} onChange={(event) => {
            const partner = data.nextMemberships.find((row) => row.member_id === Number(event.target.value));
            setEditing({ ...editing, partnerId: event.target.value, ...(partner ? { wingId: partner.wing_id, positionNumber: partner.position_number } : {}) });
          }}><option value="">Somente mudar para uma posição livre</option>{data.nextMemberships.filter((row) => row.member_id !== member.id).map((row) => <option key={row.member_id} value={row.member_id}>{memberName(data.members.find((item) => item.id === row.member_id))} · {data.wings.find((wing) => wing.id === row.wing_id)?.name} · {row.position_number}ª</option>)}</select></label>}
          <div className="wings-import-application"><label className="wings-import-toggle"><input type="checkbox" checked={editing.applyCurrent} disabled={minDate > end} onChange={(event) => setEditing({ ...editing, applyCurrent: event.target.checked })} /><span>Aplicar também nesta escala, nas datas que ainda não passaram</span></label>
            {editing.applyCurrent && <label>A partir de<input type="date" min={minDate} max={end} required value={editing.fromDate} onChange={(event) => setEditing({ ...editing, fromDate: event.target.value })} /></label>}
            <p>{minDate > end ? 'Esta escala já terminou. Somente a mudança futura está disponível.' : 'Extras e datas anteriores serão preservados. Somente os ordinários dos militares envolvidos serão recalculados.'}</p></div>
        </fieldset>
        {move.isError && <p className="error" role="alert">{move.error.response?.data?.message || 'Não foi possível alterar a ala.'}</p>}
        <div className="form-actions"><button disabled={move.isPending}>{move.isPending ? 'Salvando…' : 'Confirmar mudança'}</button><button type="button" className="secondary-button" disabled={move.isPending} onClick={close}>Cancelar</button></div>
      </form>}
    </section></div>, document.body)}
  </>;
}
