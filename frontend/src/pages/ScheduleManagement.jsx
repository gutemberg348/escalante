import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useMonthRollover } from '../hooks/useMonthRollover.js';
import DeleteMonthButton from '../components/DeleteMonthButton.jsx';
import ConfirmationDialog from '../components/ConfirmationDialog.jsx';

const dateLabel = (date) => new Date(`${date}T00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', weekday: 'short' });
const periodLabel = (period) => period === 'DIURNO' ? 'Dia · 07h às 19h' : 'Noite · 19h às 07h';
const fullName = (member) => `${member.rank} ${member.operational_name}`;

export default function ScheduleManagement() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [competencyId, setCompetencyId] = useState(searchParams.get('competency_id') || '');
  const [editor, setEditor] = useState(null);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedServiceType, setSelectedServiceType] = useState('EXTRAORDINARY');
  const [moving, setMoving] = useState(null);
  const [target, setTarget] = useState('');
  const [deletingMonth, setDeletingMonth] = useState(false);
  const [monthFeedback, setMonthFeedback] = useState('');
  const [removing, setRemoving] = useState(null);
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me').then((response) => response.data.user) });
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((response) => response.data.items) });
  const generatedCompetencies = useMemo(() => competencies.filter((item) => item.generated_at), [competencies]);
  useMonthRollover(competencies, competencyId, (id) => {
    setCompetencyId(id);
    setSearchParams({ competency_id: id }, { replace: true });
  }, Boolean(editor || moving || deletingMonth || removing));
  const { data: schedule, isLoading } = useQuery({
    queryKey: ['schedule-management', competencyId],
    queryFn: () => api.get('/service-slots/manage', { params: { competency_id: competencyId } }).then((response) => response.data),
    enabled: Boolean(competencyId)
  });
  const { data: members = [] } = useQuery({
    queryKey: ['members', 'schedule-management', competencyId],
    queryFn: () => api.get('/members', { params: { competency_id: competencyId } }).then((response) => response.data.items),
    enabled: Boolean(competencyId)
  });
  const editable = ['ADMIN', 'SCHEDULER'].includes(me?.role);
  const eligibleMembers = useMemo(() => members.filter((member) => member.active
    && (member.operational_status === 'ACTIVE' || (selectedServiceType === 'EXTRAORDINARY' && member.operational_status === 'VACATION'))
    && member.authorization_status === 'AUTHORIZED'), [members, selectedServiceType]);
  const slots = schedule?.items || [];
  const days = useMemo(() => {
    const grouped = new Map();
    slots.forEach((slot) => {
      if (!grouped.has(slot.service_date)) grouped.set(slot.service_date, { date: slot.service_date });
      grouped.get(slot.service_date)[slot.period] = slot;
    });
    return [...grouped.values()];
  }, [slots]);
  const vacancies = useMemo(() => slots.flatMap((slot) => Array.from({ length: Number(slot.current_capacity) }, (_, index) => {
    const position = index + 1;
    return slot.assignments?.some((assignment) => assignment.positionNumber === position) ? [] : [{ slot, position }];
  })).flat(), [slots]);
  const destinations = useMemo(() => slots.flatMap((slot) => Array.from({ length: Number(slot.current_capacity) }, (_, index) => {
    const position = index + 1;
    return { slot, position, assignment: slot.assignments?.find((item) => item.positionNumber === position) || null };
  })), [slots]);
  const selectedDestination = destinations.find(({ slot, position }) => `${slot.id}:${position}` === target);

  useEffect(() => {
    if (!generatedCompetencies.length || generatedCompetencies.some((item) => String(item.id) === competencyId)) return;
    const today = new Date();
    const current = generatedCompetencies.find((item) => item.year === today.getFullYear() && item.month === today.getMonth() + 1);
    const nextId = String((current || generatedCompetencies[0]).id);
    setCompetencyId(nextId);
    setSearchParams({ competency_id: nextId }, { replace: true });
  }, [generatedCompetencies, competencyId, setSearchParams]);

  const refresh = () => Promise.all(['schedule-management', 'slots', 'members', 'dashboard'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const savePosition = useMutation({
    mutationFn: ({ slotId, position, memberId, serviceType }) => api.put(`/service-slots/${slotId}/positions/${position}`, { memberId, serviceType }),
    onSuccess: () => { refresh(); setEditor(null); setSelectedMemberId(''); }
  });
  const moveAssignment = useMutation({
    mutationFn: ({ assignmentId, targetSlotId, targetPosition }) => api.post(`/service-slots/assignments/${assignmentId}/move`, { targetSlotId, targetPosition }),
    onSuccess: () => { refresh(); setMoving(null); setTarget(''); }
  });
  const changeServiceType = useMutation({
    mutationFn: ({ assignmentId, serviceType }) => api.patch(`/service-slots/assignments/${assignmentId}/type`, { serviceType }),
    onSuccess: refresh
  });
  const removePosition = useMutation({
    mutationFn: ({ slot, position }) => api.put(`/service-slots/${slot.id}/positions/${position}`, { memberId: null }),
    onSuccess: async (_response, { slot, position }) => {
      // Reflect the empty position immediately, keeping every other position intact.
      queryClient.setQueryData(['schedule-management', competencyId], (current) => current ? { ...current,
        items: current.items.map((item) => item.id === slot.id ? { ...item, assignments: item.assignments.filter((assignment) => assignment.positionNumber !== position) } : item)
      } : current);
      setRemoving(null);
      setMonthFeedback(`${dateLabel(slot.service_date)} · ${periodLabel(slot.period)} · ${position}ª coluna: militar retirado. A vaga ficou aberta.`);
      await refresh();
    }
  });

  const openEditor = (slot, position, assignment = null) => {
    savePosition.reset();
    setEditor({ slot, position, assignment });
    setSelectedMemberId(assignment ? String(assignment.memberId) : '');
    setSelectedServiceType(assignment?.serviceType || 'EXTRAORDINARY');
  };
  const submitEditor = () => {
    if (!editor || !selectedMemberId) return;
    savePosition.mutate({ slotId: editor.slot.id, position: editor.position, memberId: Number(selectedMemberId), serviceType: selectedServiceType });
  };
  const removeAssignment = (slot, position, assignment) => {
    removePosition.reset();
    setRemoving({ slot, position, assignment });
  };
  const downloadPdf = async () => {
    const response = await api.get('/service-slots/pdf', { params: { competency_id: competencyId }, responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `escala-${schedule?.competency?.year}-${String(schedule?.competency?.month).padStart(2, '0')}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const actionError = savePosition.error || moveAssignment.error || changeServiceType.error;
  const actionPending = savePosition.isPending || moveAssignment.isPending || changeServiceType.isPending || removePosition.isPending;

  return <>
    <header className="page-header"><div><span className="eyebrow">ADMINISTRAÇÃO DA ESCALA</span><h1>Gerenciar escala</h1><p>Edite a planilha mensal: inclua, troque, mova ou retire militares de qualquer vaga aberta.</p></div>
      <div className="month-toolbar-actions"><button type="button" className="secondary-button" disabled={!competencyId} onClick={downloadPdf}>Baixar PDF da escala</button>
        {editable && <DeleteMonthButton competencyId={competencyId} onOpenChange={setDeletingMonth} onDeleted={(id, message) => {
          setCompetencyId(id); setSearchParams(id ? { competency_id: id } : {}, { replace: true }); setMonthFeedback(message);
        }} />}</div>
    </header>

    <section className="panel schedule-manager-filter"><div><span className="eyebrow">MÊS DA ESCALA</span><h2>{schedule?.competency?.name || 'Selecione o mês'}</h2><p>Somente meses já gerados aparecem aqui. O PDF usa o mesmo layout encaminhado pelo WhatsApp.</p></div><label>Competência<select disabled={!generatedCompetencies.length || actionPending || Boolean(removing || editor || moving || deletingMonth)} value={competencyId} onChange={(event) => { const id = event.target.value; setCompetencyId(id); setSearchParams({ competency_id: id }, { replace: true }); }}>{!generatedCompetencies.length && <option value="">Nenhum mês gerado</option>}{generatedCompetencies.map((competency) => <option key={competency.id} value={competency.id}>{competency.name}</option>)}</select></label></section>

    {!editable && <p className="error">Seu perfil pode consultar a escala e baixar o PDF, mas as alterações são restritas a administradores e escalantes.</p>}
    {monthFeedback && <p className="success" role="status">{monthFeedback}</p>}
    {!generatedCompetencies.length && <section className="panel"><p>Nenhum mês gerado. Use Gestão do mês para gerar a escala desejada.</p></section>}
    {actionError && <p className="error schedule-manager-feedback">{actionError.response?.data?.message || 'Não foi possível atualizar a escala.'}</p>}
    {isLoading && <section className="panel"><p className="modal-copy">Carregando planilha...</p></section>}
    {competencyId && !isLoading && <section className="roster-calendar" aria-label="Calendário da escala">
      <div className="roster-toolbar"><div><span className="eyebrow">CALENDÁRIO DA ESCALA</span><h2>{schedule?.competency?.name}</h2><p>{vacancies.length} vagas livres · Confira a data e o turno antes de alterar.</p></div>
        <label>Ir para o dia<select value="" disabled={!days.length} onChange={(event) => {
          const dayHeading = document.getElementById(`roster-day-${event.target.value}`);
          dayHeading?.scrollIntoView({ block: 'start' });
          dayHeading?.focus({ preventScroll: true });
        }}><option value="">Escolha uma data</option>{days.map((day) => <option value={day.date} key={day.date}>{dateLabel(day.date)}</option>)}</select></label>
      </div>
      <div className="roster-days">
        {days.map((day) => <section className="roster-day" key={day.date} aria-labelledby={`roster-day-${day.date}`}>
          <h3 className="roster-date" id={`roster-day-${day.date}`} tabIndex={-1}>
            <time dateTime={day.date}>{day.date.slice(8, 10)}<span>/{day.date.slice(5, 7)}</span></time>
            <span className="roster-date-detail"><strong>{new Date(`${day.date}T00:00`).toLocaleDateString('pt-BR', { weekday: 'long' })}</strong><span>{new Date(`${day.date}T00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</span></span>
          </h3>
          <div className="roster-columns">{[1, 2, 3, 4].map((position) => <section className="roster-column" key={position} aria-label={`${position}ª coluna de ${dateLabel(day.date)}`}>
            <h4 className="roster-column-title">{position}ª coluna</h4>
            <div className="roster-column-shifts">{['DIURNO', 'NOTURNO'].map((period) => {
            const slot = day[period];
            if (!slot) return null;
            const isDay = period === 'DIURNO';
            const assignment = slot.assignments?.find((item) => item.positionNumber === position);
            const locked = position > Number(slot.current_capacity);
            return <section className={`roster-shift ${isDay ? 'roster-shift-day' : 'roster-shift-night'}`} key={slot.id} aria-label={`${dateLabel(day.date)} · ${periodLabel(period)}`}>
              <div className="roster-shift-heading"><span className="roster-shift-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{isDay ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.8 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.8 13.2Z" />}</svg></span><h5>{isDay ? 'Dia' : 'Noite'}<span>{isDay ? '07h às 19h' : '19h às 07h'}{!isDay && <small>do dia seguinte</small>}</span></h5></div>
              <ScheduleCell slot={slot} position={position} assignment={assignment} locked={locked} editable={editable} actionPending={actionPending}
                  onAdd={() => openEditor(slot, position)} onReplace={() => openEditor(slot, position, assignment)}
                  onMove={() => { setMoving({ slot, position, assignment }); setTarget(''); }} onRemove={() => removeAssignment(slot, position, assignment)}
                  onToggleType={() => changeServiceType.mutate({ assignmentId: assignment.id, serviceType: assignment.serviceType === 'ORDINARY' ? 'EXTRAORDINARY' : 'ORDINARY' })} typePending={changeServiceType.isPending} />
            </section>;
            })}</div>
          </section>)}</div>
        </section>)}</div>
      {!days.length && <p className="empty-table">Não há horários preparados neste mês.</p>}
    </section>}

    {removing && <ConfirmationDialog title={`Retirar ${removing.assignment.rank} ${removing.assignment.operationalName}?`}
      pending={removePosition.isPending} pendingLabel="Retirando…" confirmLabel="Retirar desta vaga" onClose={() => setRemoving(null)}
      onConfirm={() => removePosition.mutate(removing)} error={removePosition.error ? removePosition.error.response?.data?.message || 'Não foi possível retirar o militar. Tente novamente.' : ''}>
      <p className="confirmation-context">{schedule?.competency?.name}<br />{dateLabel(removing.slot.service_date)} · {periodLabel(removing.slot.period)}<br /><strong>{removing.position}ª coluna · {removing.assignment.serviceType === 'ORDINARY' ? 'Ordinário' : 'Extra'}</strong></p>
      <p>Somente esta marcação será retirada. A coluna ficará vaga e os outros militares continuarão nas mesmas colunas.</p>
    </ConfirmationDialog>}

    {editor && <div className="modal-backdrop" role="presentation"><section className="edit-modal schedule-action-modal" role="dialog" aria-modal="true" aria-label="Definir militar da vaga"><div className="modal-header"><div><span className="eyebrow">{editor.assignment ? 'TROCAR MILITAR' : 'PREENCHER VAGA'}</span><h2>{dateLabel(editor.slot.service_date)} · {periodLabel(editor.slot.period)} · Coluna {editor.position}</h2></div><button className="close-button" onClick={() => setEditor(null)} aria-label="Fechar">×</button></div>
      <p className="modal-copy">{editor.assignment ? `Substitui ${editor.assignment.rank} ${editor.assignment.operationalName}.` : 'Escolha um militar ativo e autorizado para confirmar nesta vaga.'}</p>
      <div className="schedule-editor-fields"><label>Militar<select autoFocus value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}><option value="">Selecione um militar</option>{eligibleMembers.map((member) => <option value={member.id} key={member.id}>{fullName(member)} · {member.monthly_hours || 0}h</option>)}</select></label><label>Tipo do serviço<select value={selectedServiceType} onChange={(event) => setSelectedServiceType(event.target.value)}><option value="ORDINARY">Ordinário</option><option value="EXTRAORDINARY">Extra</option></select></label></div>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setEditor(null)}>Cancelar</button><button type="button" disabled={!selectedMemberId || savePosition.isPending} onClick={submitEditor}>{savePosition.isPending ? 'Salvando…' : editor.assignment ? 'Trocar militar' : 'Confirmar militar'}</button></div>
    </section></div>}

    {moving && <div className="modal-backdrop" role="presentation"><section className="edit-modal schedule-action-modal" role="dialog" aria-modal="true" aria-label="Mover ou trocar coluna"><div className="modal-header"><div><span className="eyebrow">MOVER OU TROCAR POSIÇÃO</span><h2>{moving.assignment.rank} {moving.assignment.operationalName}</h2></div><button className="close-button" onClick={() => setMoving(null)} aria-label="Fechar">×</button></div>
      <p className="modal-copy">Origem: {dateLabel(moving.slot.service_date)} · {periodLabel(moving.slot.period)} · coluna {moving.position}. Se o destino estiver ocupado, os dois militares trocarão de coluna.</p>
      <label>Coluna de destino<select autoFocus value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Selecione uma coluna</option>{destinations.filter(({ slot, position }) => slot.id !== moving.slot.id || position !== moving.position).map(({ slot, position, assignment }) => <option value={`${slot.id}:${position}`} key={`${slot.id}:${position}`}>{dateLabel(slot.service_date)} · {periodLabel(slot.period)} · coluna {position} · {assignment ? `trocar com ${assignment.rank} ${assignment.operationalName}` : 'vaga livre'}</option>)}</select></label>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setMoving(null)}>Cancelar</button><button type="button" disabled={!target || moveAssignment.isPending} onClick={() => { const [targetSlotId, targetPosition] = target.split(':').map(Number); moveAssignment.mutate({ assignmentId: moving.assignment.id, targetSlotId, targetPosition }); }}>{moveAssignment.isPending ? 'Salvando…' : selectedDestination?.assignment ? 'Trocar colunas' : 'Mover para vaga'}</button></div>
    </section></div>}
  </>;
}

function ScheduleCell({ slot, position, assignment, locked, editable, onAdd, onReplace, onMove, onRemove, onToggleType, typePending, actionPending }) {
  if (locked) return <div className="roster-position is-locked"><strong>Trancada</strong></div>;
  if (!assignment) return <div className="roster-position is-vacant"><strong>Vaga livre</strong>{editable && <button type="button" className="roster-action roster-add" disabled={actionPending} onClick={onAdd}>+ Adicionar</button>}</div>;
  const extraAssignment = assignment.serviceType === 'EXTRAORDINARY';
  return <div className={`roster-position is-occupied ${extraAssignment ? 'is-extra' : ''}`}>
    <div className="roster-position-heading"><span className={`roster-service-type ${extraAssignment ? 'is-extra' : ''}`}>{extraAssignment ? 'Extra' : 'Ordinário'}</span></div>
    <strong className="roster-member-name">{assignment.rank} {assignment.operationalName}{assignment.displayPrefix ? ` (${assignment.displayPrefix})` : ''}</strong>
    {editable && <div className="roster-actions">
      <button type="button" className="roster-action roster-replace" disabled={actionPending} aria-label={`Trocar militar da ${position}ª coluna, ${periodLabel(slot.period)}, ${dateLabel(slot.service_date)}`} onClick={onReplace}>Trocar</button>
      <button type="button" className="roster-action" disabled={actionPending} onClick={onMove}>Mover</button>
      <button type="button" className="roster-action" disabled={typePending || actionPending} onClick={onToggleType}>Mudar tipo</button>
      <button type="button" className="roster-action roster-remove" disabled={actionPending} aria-label={`Retirar ${assignment.rank} ${assignment.operationalName} da ${position}ª coluna de ${dateLabel(slot.service_date)}, ${slot.period === 'DIURNO' ? 'dia' : 'noite'}`} onClick={onRemove}>Retirar</button>
    </div>}
  </div>;
}
