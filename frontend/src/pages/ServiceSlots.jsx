import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const dateLabel = (date) => new Date(`${date}T00:00`).toLocaleDateString('pt-BR');
const periodLabel = (period) => period === 'DIURNO' ? 'Dia · 07h às 19h' : 'Noite · 19h às 07h';

export default function ServiceSlots() {
  const queryClient = useQueryClient();
  const [competencyId, setCompetencyId] = useState('');
  const [dayColumns, setDayColumns] = useState({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scope, setScope] = useState('MONTH');
  const [selectedDates, setSelectedDates] = useState([]);
  const [columns, setColumns] = useState({ third: false, fourth: false });
  const [confirmationDate, setConfirmationDate] = useState(null);
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((response) => response.data.items) });
  const { data: slots = [] } = useQuery({ queryKey: ['slots', competencyId], queryFn: () => api.get('/service-slots', { params: { competency_id: competencyId } }).then((response) => response.data.items), enabled: Boolean(competencyId) });
  const { data: pdfColumns } = useQuery({ queryKey: ['pdf-columns', competencyId], queryFn: () => api.get('/service-slots/pdf-columns', { params: { competency_id: competencyId } }).then((response) => response.data.item), enabled: Boolean(competencyId) });
  const { data: confirmations, isLoading: confirmationsLoading } = useQuery({ queryKey: ['slot-confirmations', competencyId, confirmationDate], queryFn: () => api.get('/service-slots/confirmations', { params: { competency_id: competencyId, service_date: confirmationDate } }).then((response) => response.data), enabled: Boolean(competencyId && confirmationDate) });
  const dates = useMemo(() => [...new Set(slots.map((slot) => slot.service_date))], [slots]);
  const days = useMemo(() => Object.values(slots.reduce((result, slot) => {
    if (!result[slot.service_date]) result[slot.service_date] = { date: slot.service_date };
    result[slot.service_date][slot.period] = slot;
    return result;
  }, {})), [slots]);
  const selectedCompetency = competencies.find((item) => String(item.id) === String(competencyId));
  const highestColumn = Math.max(2, ...Object.values(dayColumns).flat());

  useEffect(() => {
    if (!competencies.length || competencies.some((item) => String(item.id) === String(competencyId))) return;
    const today = new Date();
    const current = competencies.find((item) => item.year === today.getFullYear() && item.month === today.getMonth() + 1);
    setCompetencyId(String((current || competencies[0]).id));
  }, [competencies, competencyId]);
  useEffect(() => {
    if (pdfColumns) setDayColumns(Object.fromEntries(pdfColumns.items.map((item) => [item.serviceDate, item.openColumns])));
  }, [pdfColumns]);

  const saveColumns = useMutation({
    mutationFn: (items) => api.put('/service-slots/pdf-columns', { competencyId: Number(competencyId), items }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pdf-columns', competencyId] });
      queryClient.invalidateQueries({ queryKey: ['slots', competencyId] });
      queryClient.invalidateQueries({ queryKey: ['seniority'] });
      setSettingsOpen(false);
    }
  });
  const openSettings = () => {
    const allThird = dates.length > 0 && dates.every((date) => dayColumns[date]?.includes(3));
    const allFourth = dates.length > 0 && dates.every((date) => dayColumns[date]?.includes(4));
    setScope('MONTH'); setSelectedDates(dates); setColumns({ third: allThird, fourth: allFourth }); setSettingsOpen(true);
  };
  const applySettings = () => {
    const targets = scope === 'MONTH' ? dates : selectedDates;
    const next = { ...dayColumns };
    targets.forEach((date) => {
      const fourth = columns.fourth;
      const third = columns.third || fourth;
      next[date] = [1, 2, ...(third ? [3] : []), ...(fourth ? [4] : [])];
    });
    setDayColumns(next);
    saveColumns.mutate(dates.map((date) => ({ serviceDate: date, openColumns: next[date] || [1, 2] })));
  };
  const toggleDate = (date) => setSelectedDates((current) => current.includes(date) ? current.filter((item) => item !== date) : [...current, date]);
  const coverage = (slot) => slot ? `${slot.confirmed_count}/${slot.current_capacity} confirmados` : '—';

  return <>
    <header className="page-header"><div><span className="eyebrow">COBERTURA OPERACIONAL</span><h1>Horários</h1><p>As duas primeiras posições ficam abertas; a 3ª e a 4ª são liberadas por rodada.</p></div></header>
    <section className="panel month-filter"><div><span className="eyebrow">CONSULTAR MÊS</span><h2>Escala mensal</h2><p>Confira a ocupação de Dia e Noite e controle as colunas extras.</p></div><label>Mês da escala<select value={competencyId} onChange={(event) => setCompetencyId(event.target.value)}>{competencies.map((competency) => <option value={competency.id} key={competency.id}>{competency.name}</option>)}</select></label></section>
    {competencyId && <section className="panel month-summary"><div><span className="eyebrow">RODADA DO MÊS</span><h2>{selectedCompetency?.name}</h2><p>{days.length} dias cadastrados · até {highestColumn} posições por turno. A 3ª coluna abre automaticamente quando a 2ª estiver totalmente preenchida.</p></div><button type="button" className="secondary-button" onClick={openSettings} disabled={!dates.length}>Configurar colunas</button></section>}
    {!competencies.length
      ? <section className="panel empty-month"><h2>Nenhum mês preparado</h2><p>Prepare o mês que deseja consultar.</p><Link className="table-button month-link" to="/competencias">Preparar mês</Link></section>
      : <section className="panel table-wrap"><div className="table-title"><div><h2>Horários de {selectedCompetency?.name}</h2><span>{days.length} dias neste mês</span></div></div>
        <table><thead><tr><th>Data</th><th>Turno do dia</th><th>Turno da noite</th><th>Posições livres</th><th /></tr></thead><tbody>{days.map((day) => {
          const daySlot = day.DIURNO; const nightSlot = day.NOTURNO;
          const available = (daySlot?.available_positions || 0) + (nightSlot?.available_positions || 0);
          const total = (daySlot?.current_capacity || 0) + (nightSlot?.current_capacity || 0);
          return <tr key={day.date}><td><strong>{dateLabel(day.date)}</strong></td><td>{coverage(daySlot)}</td><td>{coverage(nightSlot)}</td><td>{available} de {total}</td><td><button className="table-button" onClick={() => setConfirmationDate(day.date)}>Ver militares</button></td></tr>;
        })}</tbody></table>{!slots.length && <p className="empty-table">Este mês ainda não possui horários.</p>}</section>}

    {settingsOpen && <div className="modal-backdrop" role="presentation"><section className="edit-modal month-settings-modal" role="dialog" aria-modal="true" aria-label="Configurações das colunas">
      <div className="modal-header"><div><span className="eyebrow">COLUNAS DA ESCALA</span><h2>{selectedCompetency?.name}</h2></div><button className="close-button" onClick={() => setSettingsOpen(false)} aria-label="Fechar">×</button></div>
      <p className="modal-copy">A 1ª e a 2ª posições permanecem abertas. Liberar a 3ª ou a 4ª inicia uma nova fila, envia o cronograma e publica as vagas no grupo.</p>
      <div className="settings-choice"><button type="button" className={scope === 'MONTH' ? 'selected' : 'secondary-button'} onClick={() => { setScope('MONTH'); setSelectedDates(dates); }}>Mês inteiro</button><button type="button" className={scope === 'DATES' ? 'selected' : 'secondary-button'} onClick={() => setScope('DATES')}>Dias específicos</button></div>
      <div className="column-toggles"><label><input type="checkbox" checked={columns.third} onChange={(event) => setColumns((current) => ({ ...current, third: event.target.checked, fourth: event.target.checked ? current.fourth : false }))} /> Liberar 3ª coluna</label><label><input type="checkbox" checked={columns.fourth} onChange={(event) => setColumns((current) => ({ ...current, fourth: event.target.checked, third: event.target.checked || current.third }))} /> Liberar 4ª coluna</label></div>
      {scope === 'DATES' && <div className="date-picker-grid">{dates.map((date) => <label key={date} className={selectedDates.includes(date) ? 'chosen' : ''}><input type="checkbox" checked={selectedDates.includes(date)} onChange={() => toggleDate(date)} /> {dateLabel(date)}</label>)}</div>}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setSettingsOpen(false)}>Cancelar</button><button type="button" disabled={saveColumns.isPending || (scope === 'DATES' && !selectedDates.length)} onClick={applySettings}>Salvar e aplicar</button></div>
      {saveColumns.isError && <p className="error">{saveColumns.error.response?.data?.message || 'Não foi possível atualizar as colunas.'}</p>}
    </section></div>}

    {confirmationDate && <div className="modal-backdrop" role="presentation"><section className="edit-modal confirmations-modal" role="dialog" aria-modal="true" aria-label="Confirmados do dia">
      <div className="modal-header"><div><span className="eyebrow">ESCALA CONFIRMADA</span><h2>{dateLabel(confirmationDate)}</h2></div><button className="close-button" onClick={() => setConfirmationDate(null)} aria-label="Fechar">×</button></div>
      {confirmationsLoading ? <p className="modal-copy">Carregando confirmados...</p> : <><p className="modal-copy">Militares confirmados em cada posição dos turnos.</p><div className="confirmation-list">{confirmations?.items?.map((item) => <div className="confirmation-row" key={item.assignmentId}><span>{periodLabel(item.period)}</span><strong>{item.rank} {item.operationalName}</strong><small>Posição {item.positionNumber}</small></div>)}</div>{!confirmations?.items?.length && <p className="empty-table">Ainda não há militar confirmado nesta data.</p>}</>}
    </section></div>}
  </>;
}
