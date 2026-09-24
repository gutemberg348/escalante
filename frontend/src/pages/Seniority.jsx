import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const parts = (value) => {
  if (!value) return { date: '', time: '' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
};
const deadline = (value) => value?.date && value?.time ? `${value.date}T${value.time}` : null;
const isEligible = (member) => Boolean(member.active) && member.operational_status === 'ACTIVE' && member.authorization_status === 'AUTHORIZED';
const memberName = (member) => `${member.rank} ${member.operational_name}`;
const displayDeadline = (value) => `${value.date.split('-').reverse().join('/')} às ${value.time}`;
const formatDateTime = (value) => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'não informado';

function validateSchedule(items, schedule) {
  const issues = new Map();
  const eligible = items.filter(isEligible);
  eligible.forEach((member) => {
    const value = schedule[member.id] || { date: '', time: '' };
    if (value.date && !value.time) issues.set(member.id, `Informe a hora limite de ${memberName(member)}.`);
    if (!value.date && value.time) issues.set(member.id, `Informe a data limite de ${memberName(member)}.`);
  });
  const scheduled = eligible.filter((member) => deadline(schedule[member.id]));
  for (let index = 1; index < scheduled.length; index += 1) {
    const previous = scheduled[index - 1];
    const current = scheduled[index];
    const previousValue = schedule[previous.id];
    const currentValue = schedule[current.id];
    if (new Date(deadline(currentValue)) <= new Date(deadline(previousValue))) {
      issues.set(current.id, `O prazo de ${memberName(current)} (${displayDeadline(currentValue)}) precisa ser depois de ${memberName(previous)} (${displayDeadline(previousValue)}).`);
    }
  }
  return issues;
}

const schedulePayload = (items, schedule) => items.map((item) => ({ memberId: item.id, deadlineAt: deadline(schedule[item.id]) }));

export default function Seniority() {
  const queryClient = useQueryClient();
  const { data = { items: [], turn: null, markingMode: 'OPEN', markingScheduled: false, markingStartsAt: null, activeMarkingColumn: 2 } } = useQuery({
    queryKey: ['seniority'],
    queryFn: () => api.get('/seniority').then((response) => response.data),
    refetchInterval: 30_000
  });
  const [items, setItems] = useState([]);
  const [schedule, setSchedule] = useState({});
  const [resetFromMemberId, setResetFromMemberId] = useState(null);
  useEffect(() => {
    setItems(data.items);
    setSchedule(Object.fromEntries(data.items.map((item) => [item.id, parts(item.marking_deadline)])));
  }, [data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['seniority'] });
  const moveOrder = useMutation({
    mutationFn: ({ nextItems, nextSchedule }) => api.put('/seniority', { memberIds: nextItems.map((item) => item.id), reason: 'Ajuste rápido de antiguidade pelo painel', deadlines: schedulePayload(nextItems, nextSchedule) }),
    onSuccess: (response) => queryClient.setQueryData(['seniority'], response.data),
    onError: () => { setItems(data.items); setSchedule(Object.fromEntries(data.items.map((item) => [item.id, parts(item.marking_deadline)]))); }
  });
  const saveSchedule = useMutation({ mutationFn: () => api.put('/seniority/deadlines', { items: schedulePayload(items, schedule) }), onSuccess: refresh });
  const start = useMutation({ mutationFn: () => api.post('/seniority/turn/start'), onSuccess: refresh });
  const notify = useMutation({ mutationFn: () => api.post('/seniority/turn/notify') });
  const close = useMutation({ mutationFn: () => api.delete('/seniority/turn'), onSuccess: refresh });
  const reset = useMutation({ mutationFn: (startMemberId) => api.post('/seniority/turn/reset', { startMemberId }), onSuccess: refresh });
  const move = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= items.length || moveOrder.isPending) return;
    const nextItems = [...items];
    [nextItems[index], nextItems[target]] = [nextItems[target], nextItems[index]];
    const nextSchedule = {
      ...schedule,
      [nextItems[index].id]: { ...(schedule[items[index].id] || { date: '', time: '' }) },
      [nextItems[target].id]: { ...(schedule[items[target].id] || { date: '', time: '' }) }
    };
    setItems(nextItems);
    setSchedule(nextSchedule);
    moveOrder.mutate({ nextItems, nextSchedule });
  };
  const setPart = (id, key, value) => {
    saveSchedule.reset();
    setSchedule((current) => ({ ...current, [id]: { ...(current[id] || { date: '', time: '' }), [key]: value } }));
  };
  const resetFrom = resetFromMemberId ? items.find((member) => member.id === resetFromMemberId) : null;
  const resetTurn = () => {
    const target = resetFrom ? `a partir de ${resetFrom.rank} ${resetFrom.operational_name}` : 'pelo primeiro prazo ainda válido';
    if (window.confirm(`Reiniciar a fila ${target}? Prazos vencidos serão ignorados e as marcações já feitas não serão apagadas.`)) reset.mutate(resetFromMemberId);
  };
  const scheduleIssues = validateSchedule(items, schedule);
  const error = moveOrder.error || saveSchedule.error || start.error || notify.error || close.error || reset.error;
  const scheduled = Boolean(data.turn && data.markingScheduled);
  const columnLabel = `${data.activeMarkingColumn || 2}ª coluna`;

  return <>
    <header className="page-header"><div><span className="eyebrow">ORDEM E PRAZOS</span><h1>Antiguidade</h1><p>Defina até qual data e hora cada militar pode marcar, na ordem de antiguidade.</p></div><span className="order-counter">{items.length} militares</span></header>
    <section className={`panel marking-sequence-card ${data.turn ? scheduled ? 'scheduled-marking-mode' : '' : 'open-marking-mode'}`}>
      <div className="sequence-copy">
        <span className="eyebrow">{scheduled ? 'FILA PROGRAMADA' : data.turn ? 'VEZ ATUAL' : 'MODO DE MARCAÇÃO'}</span>
        <h2>{scheduled ? `Começa em ${formatDateTime(data.markingStartsAt)}` : data.turn ? `${data.turn.rank} ${data.turn.operational_name}` : 'Marcação livre'}</h2>
        <p>{scheduled
          ? `${columnLabel}. Primeiro militar: ${data.turn.rank} ${data.turn.operational_name}. Ninguém pode marcar antes do início.`
          : data.turn
            ? `${columnLabel}. Pode marcar até ${formatDateTime(data.turn.deadline_at)}.`
            : 'A fila está encerrada. Qualquer militar ativo e autorizado pode marcar as vagas disponíveis, sem ordem de antiguidade.'}</p>
        {scheduled && <div className="sequence-details"><span><b>Início</b>{formatDateTime(data.markingStartsAt)}</span><span><b>Coluna</b>{columnLabel}</span><span><b>Primeiro prazo</b>{formatDateTime(data.turn.deadline_at)}</span></div>}
      </div>
      <div className="connection-actions">{data.turn ? <><button type="button" className="secondary-button" onClick={() => notify.mutate()} disabled={scheduled || notify.isPending}>{scheduled ? 'Aguardando início' : 'Enviar vagas agora'}</button><button type="button" className="secondary-button" onClick={() => close.mutate()} disabled={close.isPending}>Encerrar e liberar para todos</button></> : <button type="button" onClick={() => start.mutate()} disabled={start.isPending}>Iniciar pelo horário atual</button>}<button type="button" className="secondary-button reset-turn-button" onClick={resetTurn} disabled={reset.isPending}>↺ Reiniciar fila</button></div>
      {error && <p className="error sequence-error">{error.response?.data?.message || 'Não foi possível atualizar a sequência.'}</p>}{start.isSuccess && <p className="success sequence-error">{start.data?.data?.message || 'Fila iniciada pelo primeiro prazo ainda válido.'}</p>}{close.isSuccess && !data.turn && <p className="success sequence-error">Fila encerrada. A marcação está liberada para todos os militares ativos e autorizados.</p>}{reset.isSuccess && <p className="success sequence-error">{reset.data?.data?.message || 'Fila reiniciada pelo primeiro prazo ainda válido.'} As marcações anteriores foram preservadas.</p>}
    </section>
    <section className="panel seniority-panel"><div className="seniority-guide seniority-schedule-guide"><span>Posição</span><span>Militar</span><span>Data limite</span><span>Hora limite</span><span>Ordem</span><span>Reinício</span></div><ol className="seniority seniority-schedule">{items.map((member, index) => { const issue = scheduleIssues.get(member.id); return <li key={member.id} className={issue ? 'deadline-row-invalid' : ''}><span className="position-number">{String(index + 1).padStart(2, '0')}</span><span className="member-name"><strong>{member.rank} {member.operational_name}</strong><small>{issue || (index === 0 ? 'Primeiro prazo' : 'Prazo posterior ao militar acima')}</small></span><label className="deadline-control"><span>Data</span><input type="date" aria-invalid={Boolean(issue)} value={schedule[member.id]?.date || ''} onChange={(event) => setPart(member.id, 'date', event.target.value)} /></label><label className="deadline-control"><span>Hora</span><input type="time" aria-invalid={Boolean(issue)} value={schedule[member.id]?.time || ''} onChange={(event) => setPart(member.id, 'time', event.target.value)} /></label><span className="direction-controls"><button type="button" className="move-button" disabled={index === 0 || moveOrder.isPending} onClick={() => move(index, -1)}>↑ Subir</button><button type="button" className="move-button" disabled={index === items.length - 1 || moveOrder.isPending} onClick={() => move(index, 1)}>Descer ↓</button></span><label className="reset-start-option"><input type="checkbox" checked={resetFromMemberId === member.id} onChange={(event) => setResetFromMemberId(event.target.checked ? member.id : null)} /><span>Começar por aqui</span></label></li>; })}</ol>{scheduleIssues.size > 0 && <div className="deadline-live-errors" role="alert"><strong>Corrija {scheduleIssues.size === 1 ? 'este horário' : 'estes horários'}:</strong><ul>{[...scheduleIssues.entries()].map(([memberId, message]) => <li key={memberId}>{message}</li>)}</ul></div>}<div className="seniority-schedule-actions"><div><strong>Prazo individual</strong><p>{moveOrder.isPending ? 'Atualizando a ordem…' : 'Subir e Descer salvam automaticamente. Os horários precisam crescer de cima para baixo.'}</p></div><button type="button" onClick={() => saveSchedule.mutate()} disabled={saveSchedule.isPending || moveOrder.isPending || scheduleIssues.size > 0}>Salvar datas e horas</button></div>{moveOrder.isSuccess && !moveOrder.isPending && <p className="success schedule-feedback">Ordem atualizada automaticamente.</p>}{saveSchedule.isSuccess && <p className="success schedule-feedback">Datas e horários salvos.</p>}</section>
  </>;
}
