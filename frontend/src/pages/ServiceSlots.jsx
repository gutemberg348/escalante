import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useMonthRollover } from '../hooks/useMonthRollover.js';
import DeleteMonthButton from '../components/DeleteMonthButton.jsx';
import ScheduleChangeNotice from '../components/ScheduleChangeNotice.jsx';
import { writtenDate } from '../utils/schedule-context.js';

const dateLabel = writtenDate;
const periodLabel = (period) => period === 'DIURNO' ? 'Dia · 07h às 19h' : 'Noite · 19h às 07h';
const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function savePdfFile(response, competency) {
  const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `escala-${competency.year}-${String(competency.month).padStart(2, '0')}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ServiceSlots() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [competencyId, setCompetencyId] = useState('');
  const [dayColumns, setDayColumns] = useState({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scope, setScope] = useState('MONTH');
  const [selectedDates, setSelectedDates] = useState([]);
  const [targetColumn, setTargetColumn] = useState(3);
  const [columnAction, setColumnAction] = useState('OPEN');
  const [columnConflict, setColumnConflict] = useState(null);
  const [confirmationDate, setConfirmationDate] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [monthAction, setMonthAction] = useState(null);
  const [deletingMonth, setDeletingMonth] = useState(false);
  const [monthFeedback, setMonthFeedback] = useState('');
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me').then((response) => response.data.user) });
  const editable = ['ADMIN', 'SCHEDULER'].includes(me?.role);
  const [targetMonth, setTargetMonth] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  const [destructiveAcknowledged, setDestructiveAcknowledged] = useState(false);
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((response) => response.data.items) });
  const generatedCompetencies = useMemo(() => competencies.filter((item) => item.generated_at), [competencies]);
  useMonthRollover(competencies, competencyId, setCompetencyId, Boolean(settingsOpen || monthAction || deletingMonth));
  const { data: slots = [] } = useQuery({ queryKey: ['slots', competencyId], queryFn: () => api.get('/service-slots', { params: { competency_id: competencyId } }).then((response) => response.data.items), enabled: Boolean(competencyId) });
  const { data: pdfColumns } = useQuery({ queryKey: ['pdf-columns', competencyId], queryFn: () => api.get('/service-slots/pdf-columns', { params: { competency_id: competencyId } }).then((response) => response.data.item), enabled: Boolean(competencyId) });
  const { data: confirmations, isLoading: confirmationsLoading } = useQuery({ queryKey: ['slot-confirmations', competencyId, confirmationDate], queryFn: () => api.get('/service-slots/confirmations', { params: { competency_id: competencyId, service_date: confirmationDate } }).then((response) => response.data), enabled: Boolean(competencyId && confirmationDate) });
  const validTargetMonth = Number.isInteger(Number(targetMonth.year)) && Number(targetMonth.year) >= 2020 && Number(targetMonth.year) <= 2100;
  const generationPreview = useQuery({ queryKey: ['month-generation-preview', targetMonth.year, targetMonth.month],
    queryFn: () => api.get('/competencies/generation-preview', { params: targetMonth }).then((response) => response.data.item),
    enabled: Boolean(monthAction) && validTargetMonth });
  const dates = useMemo(() => [...new Set(slots.map((slot) => slot.service_date))], [slots]);
  const days = useMemo(() => Object.values(slots.reduce((result, slot) => {
    if (!result[slot.service_date]) result[slot.service_date] = { date: slot.service_date };
    result[slot.service_date][slot.period] = slot;
    return result;
  }, {})), [slots]);
  const selectedCompetency = generatedCompetencies.find((item) => String(item.id) === String(competencyId));
  const highestColumn = Math.max(2, ...Object.values(dayColumns).flat());
  const availablePositions = slots.reduce((total, slot) => total + Number(slot.available_positions || 0), 0);
  const nextMonth = useMemo(() => {
    const next = new Date(); next.setDate(1); next.setMonth(next.getMonth() + 1);
    return { year: next.getFullYear(), month: next.getMonth() + 1 };
  }, [generatedCompetencies]);

  useEffect(() => {
    if (!generatedCompetencies.length || generatedCompetencies.some((item) => String(item.id) === String(competencyId))) return;
    const today = new Date();
    const current = generatedCompetencies.find((item) => item.year === today.getFullYear() && item.month === today.getMonth() + 1);
    setCompetencyId(String((current || generatedCompetencies[0]).id));
  }, [generatedCompetencies, competencyId]);
  useEffect(() => {
    if (pdfColumns) setDayColumns(Object.fromEntries(pdfColumns.items.map((item) => [item.serviceDate, item.openColumns])));
  }, [pdfColumns]);

  const saveColumns = useMutation({
    mutationFn: ({ items, deleteOccupied = false }) => api.put('/service-slots/pdf-columns', { competencyId: Number(competencyId), items, deleteOccupied }),
    onSuccess: (response) => {
      setDayColumns(Object.fromEntries(response.data.item.items.map((item) => [item.serviceDate, item.openColumns])));
      queryClient.invalidateQueries({ queryKey: ['pdf-columns', competencyId] });
      queryClient.invalidateQueries({ queryKey: ['slots', competencyId] });
      queryClient.invalidateQueries({ queryKey: ['seniority'] });
      setColumnConflict(null);
      setSettingsOpen(false);
      setMonthFeedback(`${selectedCompetency?.name}: colunas atualizadas em ${scope === 'MONTH' ? 'todos os dias do mês' : selectedDates.map(writtenDate).join(', ')}.`);
    },
    onError: (error, variables) => {
      if (error.response?.data?.code === 'COLUMN_POSITIONS_OCCUPIED') {
        setColumnConflict({ ...error.response.data, items: variables.items });
      }
    }
  });
  const downloadPdf = async (competency = selectedCompetency) => {
    if (!competency?.id) return;
    setDownloadError('');
    setIsDownloading(true);
    try {
      const response = await api.get('/service-slots/pdf', { params: { competency_id: competency.id }, responseType: 'blob' });
      savePdfFile(response, competency);
    } catch (error) {
      setDownloadError(error.response?.data?.message || 'O mês foi gerado, mas não foi possível baixar o PDF.');
    } finally {
      setIsDownloading(false);
    }
  };
  const generationSuccess = async (data) => {
      const generatedId = data.item?.id;
      queryClient.setQueryData(['competencies'], (current = []) => [...current.filter((item) => item.id !== generatedId), data.item]
        .sort((left, right) => right.year - left.year || right.month - left.month));
      if (generatedId) setCompetencyId(String(generatedId));
      setMonthAction(null);
      await Promise.all(['competencies', 'slots', 'pdf-columns', 'schedule-management', 'members', 'wings', 'dashboard', 'month-generation-preview']
        .map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      await downloadPdf(data.item);
  };
  const generateSelected = useMutation({
    mutationFn: (input) => api.post('/competencies/generate-month', input).then((response) => response.data),
    onSuccess: generationSuccess,
    onError: () => queryClient.invalidateQueries({ queryKey: ['month-generation-preview'] })
  });
  const generated = generateSelected.data;
  const preview = generationPreview.data;
  const isRegeneration = preview?.action === 'REGENERATE';
  const openMonthDialog = (action) => {
    setTargetMonth(action === 'REGENERATE' && selectedCompetency ? { year: selectedCompetency.year, month: selectedCompetency.month } : nextMonth);
    setDestructiveAcknowledged(false);
    generateSelected.reset();
    setMonthAction(action);
  };
  const selectTargetMonth = (field, value) => {
    setTargetMonth((current) => ({ ...current, [field]: value }));
    setDestructiveAcknowledged(false);
    generateSelected.reset();
  };
  const openSettings = () => {
    setScope('MONTH');
    setSelectedDates([]);
    setTargetColumn(3);
    setColumnAction('OPEN');
    setColumnConflict(null);
    setSettingsOpen(true);
  };
  const applySettings = (deleteOccupied = false) => {
    const targets = scope === 'MONTH' ? dates : selectedDates;
    const next = { ...dayColumns };
    targets.forEach((date) => {
      const openColumns = new Set(next[date] || [1, 2]);
      if (columnAction === 'OPEN') {
        openColumns.add(targetColumn);
        if (targetColumn === 4) openColumns.add(3);
      } else {
        openColumns.delete(targetColumn);
        if (targetColumn === 3) openColumns.delete(4);
      }
      next[date] = [1, 2, 3, 4].filter((column) => openColumns.has(column));
    });
    const items = dates.map((date) => ({ serviceDate: date, openColumns: next[date] || [1, 2] }));
    setColumnConflict(null);
    saveColumns.mutate({ items, deleteOccupied });
  };
  const toggleDate = (date) => setSelectedDates((current) => current.includes(date) ? current.filter((item) => item !== date) : [...current, date]);
  const coverage = (slot) => slot ? `${slot.confirmed_count}/${slot.current_capacity} confirmados` : '—';

  return <>
    <header className="page-header month-management-header"><div><span className="eyebrow">GESTÃO DO MÊS</span><h1>{selectedCompetency?.name || 'Escala mensal'}</h1><p>Escolha o mês para gerar ou regerar com as regras das alas, baixe o PDF e ajuste a escala.</p></div><button type="button" onClick={() => openMonthDialog('GENERATE')} disabled={generateSelected.isPending}>{generateSelected.isPending ? 'Gerando e baixando…' : 'Gerar / regerar mês'}</button></header>
    <section className="panel month-toolbar">
      <label>Mês exibido<select disabled={!generatedCompetencies.length} value={competencyId} onChange={(event) => setCompetencyId(event.target.value)}>{!generatedCompetencies.length && <option value="">Nenhum mês gerado</option>}{generatedCompetencies.map((competency) => <option value={competency.id} key={competency.id}>{competency.name}</option>)}</select></label>
      <div className="month-toolbar-stats"><span><strong>{days.length}</strong> dias</span><span><strong>{availablePositions}</strong> vagas livres</span><span><strong>{highestColumn}</strong> posições</span></div>
      <div className="month-toolbar-actions"><button type="button" className="secondary-button" onClick={() => downloadPdf()} disabled={!competencyId || isDownloading}>{isDownloading ? 'Baixando…' : 'Baixar PDF'}</button><button type="button" className="secondary-button" onClick={() => openMonthDialog('REGENERATE')} disabled={!competencyId || generateSelected.isPending}>Regerar / escolher mês</button><button type="button" className="secondary-button" onClick={openSettings} disabled={!dates.length}>Colunas</button><button type="button" onClick={() => navigate(`/gerenciar-escala?competency_id=${competencyId}`)} disabled={!competencyId}>Ajustar escala</button>{editable && <DeleteMonthButton competencyId={competencyId} onOpenChange={setDeletingMonth} onDeleted={(id, message) => { setCompetencyId(id); setMonthFeedback(message); generateSelected.reset(); }} />}</div>
    </section>
    {generateSelected.isSuccess && <div className="success month-generation-feedback"><strong>{generated.item.name}</strong> {generated.generation.action === 'REGENERATE' ? 'regerado' : 'gerado'} com {generated.generation.ordinaryDutyDays} serviços ordinários. Regra: {generated.generation.rule.label}. O download do PDF foi iniciado e o mês já está aberto abaixo.{generated.generation.conflictDays.length > 0 && <> Revise {generated.generation.conflictDays.length} dia(s) com conflito.</>}</div>}
    {generateSelected.isError && !monthAction && <div className="error month-generation-feedback">{generateSelected.error?.response?.data?.message || 'Não foi possível gerar a escala do mês.'}</div>}
    {downloadError && <div className="error month-generation-feedback">{downloadError}</div>}
    {monthFeedback && <p className="success" role="status">{monthFeedback}</p>}
    {!generatedCompetencies.length
      ? <section className="panel empty-month"><h2>Nenhum mês gerado</h2><p>Use “Gerar / regerar mês” e escolha o mês e o ano. A escala será preparada e o PDF será baixado automaticamente.</p></section>
      : <section className="panel table-wrap"><div className="table-title"><div><h2>Horários de {selectedCompetency?.name}</h2><span>{days.length} dias neste mês</span></div></div>
        <table className="mobile-record-table month-days-table"><thead><tr><th>Data</th><th>Turno do dia</th><th>Turno da noite</th><th>Posições livres</th><th /></tr></thead><tbody>{days.map((day) => {
          const daySlot = day.DIURNO; const nightSlot = day.NOTURNO;
          const available = (daySlot?.available_positions || 0) + (nightSlot?.available_positions || 0);
          const total = (daySlot?.current_capacity || 0) + (nightSlot?.current_capacity || 0);
          return <tr key={day.date}><td className="record-title"><strong>{dateLabel(day.date)}</strong></td><td data-label="Dia · 07h às 19h">{coverage(daySlot)}</td><td data-label="Noite · 19h às 07h">{coverage(nightSlot)}</td><td data-label="Posições livres">{available} de {total}</td><td className="record-actions"><button className="table-button" onClick={() => setConfirmationDate(day.date)}>Ver militares</button></td></tr>;
        })}</tbody></table>{!slots.length && <p className="empty-table">Este mês ainda não possui horários.</p>}</section>}

    {monthAction && <div className="modal-backdrop" role="presentation"><section className={`edit-modal month-confirmation-modal ${isRegeneration ? 'destructive' : ''}`} role="dialog" aria-modal="true" aria-label="Escolher mês para gerar ou regerar">
      <div className="modal-header"><div><span className="eyebrow">PLANEJAMENTO MENSAL</span><h2>Gerar ou regerar escala</h2></div><button className="close-button" disabled={generateSelected.isPending} onClick={() => setMonthAction(null)} aria-label="Fechar">×</button></div>
      <div className="month-target-picker"><label>Mês<select value={targetMonth.month} disabled={generateSelected.isPending} onChange={(event) => selectTargetMonth('month', Number(event.target.value))}>{monthNames.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label>
        <label>Ano<input type="number" min="2020" max="2100" value={targetMonth.year} disabled={generateSelected.isPending} onChange={(event) => selectTargetMonth('year', event.target.value)} /></label>
        <button type="button" className="secondary-button" disabled={generateSelected.isPending} onClick={() => { setTargetMonth(nextMonth); setDestructiveAcknowledged(false); generateSelected.reset(); }}>Próximo mês</button></div>
      {!validTargetMonth ? <p className="error">Informe um ano entre 2020 e 2100.</p> : generationPreview.isFetching ? <p className="modal-copy" role="status">Conferindo as regras e os serviços do mês escolhido…</p>
        : generationPreview.isError ? <p className="error">{generationPreview.error.response?.data?.message || 'Não foi possível conferir o mês escolhido.'}</p> : preview && <>
          <div className="month-target-summary"><span>{isRegeneration ? 'REGERAÇÃO' : 'NOVA ESCALA'}</span><strong>{preview.competency.name}</strong><small>{preview.expectedDays} dias · Dia e noite · {preview.rule.label}</small></div>
          <div className="generation-notice"><strong>Regras aplicadas neste mês</strong><ul><li>Alas e posições programadas para {preview.competency.name}.</li><li>Férias, licença, afastamento, autorização e participação na ordinária.</li><li>{preview.temporaryChanges ? `${preview.temporaryChanges} militar(es) com remanejamento temporário, respeitando as datas de início.` : 'Mudanças permanentes válidas para esse mês.'}</li><li>Extras, tipos de serviço e colunas abertas ou fechadas serão preservados.</li></ul>
            {!preview.wings.length && <p>As alas ainda não estão cadastradas para esse período. Será usado o ciclo ordinário anterior.</p>}</div>
          {preview.wings.length > 0 && <div className="month-rule-wings">{preview.wings.map((wing) => <div key={wing.number}><strong>{wing.name}</strong><span>Dias {wing.days.join(', ')}</span><small>{wing.members} militar(es) cadastrado(s)</small></div>)}</div>}
          {isRegeneration && <div className="destructive-notice"><strong>Recalcular os ordinários deste mês</strong><p><b>{preview.ordinaryAssignments}</b> marcações ordinárias ({preview.ordinaryDutyDays} serviços) serão refeitas pelas regras acima.</p><p>Ajustes manuais e observações desses ordinários serão substituídos. As <b>{preview.extraordinaryAssignments}</b> marcações extras serão preservadas.</p></div>}
          {!isRegeneration && <p className="modal-copy">A escala será criada para o mês escolhido, aberta na tela e baixada em PDF.</p>}
          {!preview.canGenerate && <p className="error month-generation-feedback">Há {preview.lockedOrdinaryAssignments} ordinário(s) em horários fechados ou homologados. Revise esses serviços antes de regerar.</p>}
          {isRegeneration && preview.canGenerate && <label className="destructive-acknowledgement"><input type="checkbox" disabled={generateSelected.isPending} checked={destructiveAcknowledged} onChange={(event) => setDestructiveAcknowledged(event.target.checked)} /><span>Confirmo que os ordinários de <b>{preview.competency.name}</b> serão refeitos pelas regras exibidas.</span></label>}
          <p className="month-whatsapp-note">O mês ativo do WhatsApp continua sendo o escolhido nas configurações do bot.</p>
        </>}
      {generateSelected.isError && <p className="error" role="alert">{generateSelected.error.response?.data?.message || 'Não foi possível gerar o mês escolhido.'}</p>}
      <div className="form-actions month-confirmation-actions"><button type="button" className="secondary-button" disabled={generateSelected.isPending} onClick={() => setMonthAction(null)}>Cancelar</button>
        <button type="button" className={isRegeneration ? 'danger-button' : ''} disabled={!validTargetMonth || !preview || generationPreview.isFetching || generationPreview.isError || !preview.canGenerate || generateSelected.isPending || (isRegeneration && !destructiveAcknowledged)}
          onClick={() => generateSelected.mutate({ year: Number(targetMonth.year), month: Number(targetMonth.month), confirmOrdinaryReset: isRegeneration && destructiveAcknowledged })}>
          {generateSelected.isPending ? 'Gerando e baixando…' : `${isRegeneration ? 'Regerar' : 'Gerar'} ${preview?.competency.name || 'mês escolhido'}`}</button></div>
    </section></div>}

    {settingsOpen && <div className="modal-backdrop" role="presentation"><section className="edit-modal month-settings-modal" role="dialog" aria-modal="true" aria-label="Configurações das colunas">
      <div className="modal-header"><div><span className="eyebrow">COLUNAS DA ESCALA</span><h2>{selectedCompetency?.name}</h2></div><button className="close-button" onClick={() => setSettingsOpen(false)} aria-label="Fechar">×</button></div>
      <ScheduleChangeNotice month={selectedCompetency?.name}><p>{scope === 'MONTH' ? 'A alteração será aplicada em todos os dias deste mês, nos turnos de dia e noite.' : selectedDates.length ? `Datas: ${selectedDates.map(writtenDate).join('; ')}. Turnos de dia e noite.` : 'Selecione as datas deste mês que serão alteradas.'}</p></ScheduleChangeNotice>
      <p className="modal-copy">A 1ª e a 2ª posições permanecem abertas. Liberar a 3ª ou a 4ª apenas disponibiliza a coluna; a fila só começa quando o cronograma for iniciado com data e coluna.</p>
      <div className="column-setting-step"><strong>1. Onde alterar?</strong><div className="settings-choice"><button type="button" className={scope === 'MONTH' ? 'selected' : 'secondary-button'} onClick={() => { setScope('MONTH'); setSelectedDates([]); setColumnConflict(null); }}>Mês inteiro</button><button type="button" className={scope === 'DATES' ? 'selected' : 'secondary-button'} onClick={() => { setScope('DATES'); setSelectedDates([]); setColumnConflict(null); }}>Dias específicos</button></div></div>
      <div className="column-setting-step"><strong>2. Qual coluna?</strong><div className="settings-choice"><button type="button" className={targetColumn === 3 ? 'selected' : 'secondary-button'} onClick={() => { setTargetColumn(3); setColumnConflict(null); }}>3ª coluna</button><button type="button" className={targetColumn === 4 ? 'selected' : 'secondary-button'} onClick={() => { setTargetColumn(4); setColumnConflict(null); }}>4ª coluna</button></div></div>
      <div className="column-setting-step"><strong>3. O que fazer?</strong><div className="settings-choice"><button type="button" className={columnAction === 'OPEN' ? 'selected' : 'secondary-button'} onClick={() => { setColumnAction('OPEN'); setColumnConflict(null); }}>Abrir coluna</button><button type="button" className={columnAction === 'CLOSE' ? 'selected close-selection' : 'secondary-button'} onClick={() => { setColumnAction('CLOSE'); setColumnConflict(null); }}>Fechar coluna</button></div></div>
      {scope === 'DATES' && <div className="specific-days"><div className="specific-days-heading"><strong>4. Marque somente os dias desejados</strong><div className="specific-days-tools"><span>{selectedDates.length} selecionado(s)</span><button type="button" className="table-button" onClick={() => setSelectedDates(dates)}>Marcar todos</button><button type="button" className="table-button" disabled={!selectedDates.length} onClick={() => setSelectedDates([])}>Desmarcar todos</button></div></div><div className="date-picker-grid">{dates.map((date) => <label key={date} className={selectedDates.includes(date) ? 'chosen' : ''}><input type="checkbox" checked={selectedDates.includes(date)} onChange={() => { setColumnConflict(null); toggleDate(date); }} /> <span>{dateLabel(date)}</span><small>{dayColumns[date]?.includes(targetColumn) ? 'aberta' : 'fechada'}</small></label>)}</div></div>}
      <div className={`column-action-summary ${columnAction === 'CLOSE' ? 'closing' : ''}`}><strong>{columnAction === 'OPEN' ? 'Abrir' : 'Fechar'} a {targetColumn}ª coluna</strong><span>{scope === 'MONTH' ? `em todos os ${dates.length} dias do mês` : selectedDates.length ? `em ${selectedDates.length} dia(s) selecionado(s)` : 'selecione ao menos um dia acima'}</span>{targetColumn === 4 && columnAction === 'OPEN' && <small>Abrir a 4ª também mantém a 3ª aberta.</small>}{targetColumn === 3 && columnAction === 'CLOSE' && <small>Fechar a 3ª também fecha a 4ª nesses dias.</small>}</div>
      {columnConflict && <div className="column-conflict-warning"><strong>A coluna não foi fechada.</strong><p>{columnConflict.message}</p><ul>{columnConflict.occupiedAssignments.slice(0, 8).map((item) => <li key={item.id}>{dateLabel(item.serviceDate)} · {item.period === 'DIURNO' ? 'dia' : 'noite'} · {item.positionNumber}ª: {item.member}</li>)}</ul>{columnConflict.occupiedAssignments.length > 8 && <small>e mais {columnConflict.occupiedAssignments.length - 8} marcação(ões).</small>}<button type="button" className="danger-button" disabled={saveColumns.isPending} onClick={() => saveColumns.mutate({ items: columnConflict.items, deleteOccupied: true })}>Excluir marcações e fechar</button></div>}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setSettingsOpen(false)}>Cancelar</button><button type="button" disabled={saveColumns.isPending || (scope === 'DATES' && !selectedDates.length)} onClick={() => applySettings(false)}>{saveColumns.isPending ? 'Aplicando…' : `${columnAction === 'OPEN' ? 'Abrir' : 'Fechar'} ${targetColumn}ª coluna`}</button></div>
      {saveColumns.isError && !columnConflict && <p className="error">{saveColumns.error.response?.data?.message || 'Não foi possível atualizar as colunas.'}</p>}
    </section></div>}

    {confirmationDate && <div className="modal-backdrop" role="presentation"><section className="edit-modal confirmations-modal" role="dialog" aria-modal="true" aria-label="Confirmados do dia">
      <div className="modal-header"><div><span className="eyebrow">ESCALA CONFIRMADA</span><h2>{dateLabel(confirmationDate)}</h2></div><button className="close-button" onClick={() => setConfirmationDate(null)} aria-label="Fechar">×</button></div>
      {confirmationsLoading ? <p className="modal-copy">Carregando confirmados...</p> : <><p className="modal-copy">Militares confirmados em cada posição dos turnos.</p><div className="confirmation-list">{confirmations?.items?.map((item) => <div className="confirmation-row" key={item.assignmentId}><span>{periodLabel(item.period)}</span><strong>{item.rank} {item.operationalName}{item.displayPrefix ? ` (${item.displayPrefix})` : ''}</strong><small>Posição {item.positionNumber}</small></div>)}</div>{!confirmations?.items?.length && <p className="empty-table">Ainda não há militar confirmado nesta data.</p>}</>}
    </section></div>}
  </>;
}
