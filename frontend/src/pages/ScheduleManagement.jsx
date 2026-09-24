import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

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
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me').then((response) => response.data.user) });
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((response) => response.data.items) });
  const generatedCompetencies = useMemo(() => competencies.filter((item) => item.generated_at), [competencies]);
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

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['schedule-management', competencyId] });
    queryClient.invalidateQueries({ queryKey: ['slots', competencyId] });
    queryClient.invalidateQueries({ queryKey: ['members', 'schedule-management', competencyId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
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

  const openEditor = (slot, position, assignment = null) => {
    setEditor({ slot, position, assignment });
    setSelectedMemberId(assignment ? String(assignment.memberId) : '');
    setSelectedServiceType(assignment?.serviceType || 'EXTRAORDINARY');
  };
  const submitEditor = () => {
    if (!editor || !selectedMemberId) return;
    savePosition.mutate({ slotId: editor.slot.id, position: editor.position, memberId: Number(selectedMemberId), serviceType: selectedServiceType });
  };
  const removeAssignment = (slot, position, assignment) => {
    if (!window.confirm(`Retirar ${assignment.rank} ${assignment.operationalName} desta vaga?`)) return;
    savePosition.mutate({ slotId: slot.id, position, memberId: null });
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

  return <>
    <header className="page-header"><div><span className="eyebrow">ADMINISTRAÇÃO DA ESCALA</span><h1>Gerenciar escala</h1><p>Edite a planilha mensal: inclua, troque, mova ou retire militares de qualquer vaga aberta.</p></div>
      <button type="button" className="secondary-button" disabled={!competencyId} onClick={downloadPdf}>Baixar PDF da escala</button>
    </header>

    <section className="panel schedule-manager-filter"><div><span className="eyebrow">MÊS DA ESCALA</span><h2>{schedule?.competency?.name || 'Selecione o mês'}</h2><p>Somente meses já gerados aparecem aqui. O PDF usa o mesmo layout encaminhado pelo WhatsApp.</p></div><label>Competência<select disabled={!generatedCompetencies.length} value={competencyId} onChange={(event) => { const id = event.target.value; setCompetencyId(id); setSearchParams({ competency_id: id }, { replace: true }); }}>{!generatedCompetencies.length && <option value="">Nenhum mês gerado</option>}{generatedCompetencies.map((competency) => <option key={competency.id} value={competency.id}>{competency.name}</option>)}</select></label></section>

    {!editable && <p className="error">Seu perfil pode consultar a escala e baixar o PDF, mas as alterações são restritas a administradores e escalantes.</p>}
    {actionError && <p className="error schedule-manager-feedback">{actionError.response?.data?.message || 'Não foi possível atualizar a escala.'}</p>}
    {isLoading && <section className="panel"><p className="modal-copy">Carregando planilha...</p></section>}
    {competencyId && !isLoading && <section className="panel schedule-sheet-wrap"><div className="schedule-sheet-title"><div><span className="eyebrow">PLANILHA EDITÁVEL</span><h2>{schedule?.competency?.name}</h2></div><span>{vacancies.length} vagas livres</span></div>
      <div className="schedule-sheet"><div className="schedule-sheet-head"><span>Data</span><span>Turno</span><span>1ª posição</span><span>2ª posição</span><span>3ª coluna</span><span>4ª coluna</span></div>
        {days.map((day) => <div className="schedule-day-group" key={day.date}>
          <strong className="schedule-day-label">{dateLabel(day.date)}</strong>
          <div className="schedule-day-slots">{['DIURNO', 'NOTURNO'].map((period) => {
            const slot = day[period];
            if (!slot) return null;
            return <div className="schedule-sheet-row" key={slot.id}><span className="schedule-period">{periodLabel(period)}</span>
              {[1, 2, 3, 4].map((position) => {
                const assignment = slot.assignments?.find((item) => item.positionNumber === position);
                const locked = position > Number(slot.current_capacity);
                return <ScheduleCell key={position} slot={slot} position={position} assignment={assignment} locked={locked} editable={editable}
                  onAdd={() => openEditor(slot, position)} onReplace={() => openEditor(slot, position, assignment)}
                  onMove={() => { setMoving({ slot, position, assignment }); setTarget(''); }} onRemove={() => removeAssignment(slot, position, assignment)}
                  onToggleType={() => changeServiceType.mutate({ assignmentId: assignment.id, serviceType: assignment.serviceType === 'ORDINARY' ? 'EXTRAORDINARY' : 'ORDINARY' })} typePending={changeServiceType.isPending} />;
              })}
            </div>;
          })}</div>
        </div>)}</div>
      {!days.length && <p className="empty-table">Não há horários preparados neste mês.</p>}
    </section>}

    {editor && <div className="modal-backdrop" role="presentation"><section className="edit-modal schedule-action-modal" role="dialog" aria-modal="true" aria-label="Definir militar da vaga"><div className="modal-header"><div><span className="eyebrow">{editor.assignment ? 'TROCAR MILITAR' : 'PREENCHER VAGA'}</span><h2>{dateLabel(editor.slot.service_date)} · {periodLabel(editor.slot.period)} · Posição {editor.position}</h2></div><button className="close-button" onClick={() => setEditor(null)} aria-label="Fechar">×</button></div>
      <p className="modal-copy">{editor.assignment ? `Substitui ${editor.assignment.rank} ${editor.assignment.operationalName}.` : 'Escolha um militar ativo e autorizado para confirmar nesta vaga.'}</p>
      <div className="schedule-editor-fields"><label>Militar<select autoFocus value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}><option value="">Selecione um militar</option>{eligibleMembers.map((member) => <option value={member.id} key={member.id}>{fullName(member)} · {member.monthly_hours || 0}h</option>)}</select></label><label>Tipo do serviço<select value={selectedServiceType} onChange={(event) => setSelectedServiceType(event.target.value)}><option value="ORDINARY">Ordinário</option><option value="EXTRAORDINARY">Extra</option></select></label></div>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setEditor(null)}>Cancelar</button><button type="button" disabled={!selectedMemberId || savePosition.isPending} onClick={submitEditor}>{savePosition.isPending ? 'Salvando…' : editor.assignment ? 'Trocar militar' : 'Confirmar militar'}</button></div>
    </section></div>}

    {moving && <div className="modal-backdrop" role="presentation"><section className="edit-modal schedule-action-modal" role="dialog" aria-modal="true" aria-label="Mover ou trocar posição"><div className="modal-header"><div><span className="eyebrow">MOVER OU TROCAR POSIÇÃO</span><h2>{moving.assignment.rank} {moving.assignment.operationalName}</h2></div><button className="close-button" onClick={() => setMoving(null)} aria-label="Fechar">×</button></div>
      <p className="modal-copy">Origem: {dateLabel(moving.slot.service_date)} · {periodLabel(moving.slot.period)} · posição {moving.position}. Se o destino estiver ocupado, os dois militares trocarão de posição.</p>
      <label>Posição de destino<select autoFocus value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Selecione uma posição</option>{destinations.filter(({ slot, position }) => slot.id !== moving.slot.id || position !== moving.position).map(({ slot, position, assignment }) => <option value={`${slot.id}:${position}`} key={`${slot.id}:${position}`}>{dateLabel(slot.service_date)} · {periodLabel(slot.period)} · posição {position} · {assignment ? `trocar com ${assignment.rank} ${assignment.operationalName}` : 'vaga livre'}</option>)}</select></label>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setMoving(null)}>Cancelar</button><button type="button" disabled={!target || moveAssignment.isPending} onClick={() => { const [targetSlotId, targetPosition] = target.split(':').map(Number); moveAssignment.mutate({ assignmentId: moving.assignment.id, targetSlotId, targetPosition }); }}>{moveAssignment.isPending ? 'Salvando…' : selectedDestination?.assignment ? 'Trocar posições' : 'Mover para vaga'}</button></div>
    </section></div>}
  </>;
}

function ScheduleCell({ slot, position, assignment, locked, editable, onAdd, onReplace, onMove, onRemove, onToggleType, typePending }) {
  if (locked) return <div className="schedule-cell locked">Trancada</div>;
  if (!assignment) return <div className="schedule-cell vacancy"><span>Vaga</span>{editable && <button type="button" className="table-button" onClick={onAdd}>Adicionar</button>}</div>;
  const extraAssignment = assignment.serviceType === 'EXTRAORDINARY';
  return <div className={`schedule-cell occupied ${extraAssignment ? 'extra-assignment' : ''}`}><div className="schedule-assignment-title"><strong>{assignment.rank} {assignment.operationalName}{assignment.displayPrefix ? ` (${assignment.displayPrefix})` : ''}</strong><span className={`service-type-badge ${extraAssignment ? 'extra' : 'ordinary'}`}>{extraAssignment ? 'Extra' : 'Ordinário'}</span></div>{editable && <div><button type="button" className="small-action" onClick={onReplace}>Trocar militar</button><button type="button" className="small-action" onClick={onMove}>Posição</button><button type="button" className="small-action" disabled={typePending} onClick={onToggleType}>Mudar tipo</button><button type="button" className="small-action danger" onClick={onRemove}>Retirar</button></div>}</div>;
}
