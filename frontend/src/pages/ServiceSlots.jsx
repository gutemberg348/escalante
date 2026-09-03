import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const dateLabel = (date) => new Date(`${date}T00:00`).toLocaleDateString('pt-BR');
const periodLabel = (period) => period === 'DIURNO' ? 'Dia · 07h às 19h' : 'Noite · 19h às 07h';

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
  const [columns, setColumns] = useState({ third: false, fourth: false });
  const [confirmationDate, setConfirmationDate] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [monthAction, setMonthAction] = useState(null);
  const [destructiveAcknowledged, setDestructiveAcknowledged] = useState(false);
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((response) => response.data.items) });
  const generatedCompetencies = useMemo(() => competencies.filter((item) => item.generated_at), [competencies]);
  const { data: slots = [] } = useQuery({ queryKey: ['slots', competencyId], queryFn: () => api.get('/service-slots', { params: { competency_id: competencyId } }).then((response) => response.data.items), enabled: Boolean(competencyId) });
  const { data: pdfColumns } = useQuery({ queryKey: ['pdf-columns', competencyId], queryFn: () => api.get('/service-slots/pdf-columns', { params: { competency_id: competencyId } }).then((response) => response.data.item), enabled: Boolean(competencyId) });
  const { data: confirmations, isLoading: confirmationsLoading } = useQuery({ queryKey: ['slot-confirmations', competencyId, confirmationDate], queryFn: () => api.get('/service-slots/confirmations', { params: { competency_id: competencyId, service_date: confirmationDate } }).then((response) => response.data), enabled: Boolean(competencyId && confirmationDate) });
  const regenerationImpact = useQuery({ queryKey: ['regeneration-impact', competencyId], queryFn: () => api.get(`/competencies/${competencyId}/regeneration-impact`).then((response) => response.data.item), enabled: monthAction === 'REGENERATE' && Boolean(competencyId) });
  const dates = useMemo(() => [...new Set(slots.map((slot) => slot.service_date))], [slots]);
  const days = useMemo(() => Object.values(slots.reduce((result, slot) => {
    if (!result[slot.service_date]) result[slot.service_date] = { date: slot.service_date };
    result[slot.service_date][slot.period] = slot;
    return result;
  }, {})), [slots]);
  const selectedCompetency = generatedCompetencies.find((item) => String(item.id) === String(competencyId));
  const highestColumn = Math.max(2, ...Object.values(dayColumns).flat());
  const availablePositions = slots.reduce((total, slot) => total + Number(slot.available_positions || 0), 0);
  const nextMonthName = useMemo(() => {
    const today = new Date();
    const currentIndex = today.getFullYear() * 12 + today.getMonth() + 1;
    const latestIndex = generatedCompetencies.reduce((latest, item) => Math.max(latest, item.year * 12 + item.month), 0);
    const nextIndex = Math.max(currentIndex, latestIndex) + 1;
    const year = Math.floor((nextIndex - 1) / 12);
    const month = ((nextIndex - 1) % 12) + 1;
    return new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
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
    mutationFn: (items) => api.put('/service-slots/pdf-columns', { competencyId: Number(competencyId), items }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pdf-columns', competencyId] });
      queryClient.invalidateQueries({ queryKey: ['slots', competencyId] });
      queryClient.invalidateQueries({ queryKey: ['seniority'] });
      setSettingsOpen(false);
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
      if (generatedId) setCompetencyId(String(generatedId));
      queryClient.invalidateQueries({ queryKey: ['competencies'] });
      queryClient.invalidateQueries({ queryKey: ['slots'] });
      queryClient.invalidateQueries({ queryKey: ['pdf-columns'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-management'] });
      await downloadPdf(data.item);
  };
  const generateNext = useMutation({
    mutationFn: () => api.post('/competencies/generate-next').then((response) => response.data),
    onSuccess: generationSuccess
  });
  const regenerate = useMutation({
    mutationFn: () => api.post(`/competencies/${competencyId}/regenerate`, { confirmOrdinaryReset: true }).then((response) => response.data),
    onSuccess: generationSuccess
  });
  const generated = generateNext.data || regenerate.data;
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
    <header className="page-header month-management-header"><div><span className="eyebrow">GESTÃO DO MÊS</span><h1>{selectedCompetency?.name || 'Escala mensal'}</h1><p>Gere o mês seguinte, baixe o PDF e abra os ajustes da escala.</p></div><button type="button" onClick={() => { setDestructiveAcknowledged(false); setMonthAction('GENERATE'); }} disabled={generateNext.isPending || regenerate.isPending}>{generateNext.isPending ? 'Gerando e baixando…' : 'Gerar próximo mês'}</button></header>
    <section className="panel month-toolbar">
      <label>Mês exibido<select disabled={!generatedCompetencies.length} value={competencyId} onChange={(event) => setCompetencyId(event.target.value)}>{!generatedCompetencies.length && <option value="">Nenhum mês gerado</option>}{generatedCompetencies.map((competency) => <option value={competency.id} key={competency.id}>{competency.name}</option>)}</select></label>
      <div className="month-toolbar-stats"><span><strong>{days.length}</strong> dias</span><span><strong>{availablePositions}</strong> vagas livres</span><span><strong>{highestColumn}</strong> posições</span></div>
      <div className="month-toolbar-actions"><button type="button" className="secondary-button" onClick={() => downloadPdf()} disabled={!competencyId || isDownloading}>{isDownloading ? 'Baixando…' : 'Baixar PDF'}</button><button type="button" className="secondary-button" onClick={() => { setDestructiveAcknowledged(false); setMonthAction('REGENERATE'); }} disabled={!competencyId || regenerate.isPending}>{regenerate.isPending ? 'Regerando…' : 'Regerar'}</button><button type="button" className="secondary-button" onClick={openSettings} disabled={!dates.length}>Colunas</button><button type="button" onClick={() => navigate(`/gerenciar-escala?competency_id=${competencyId}`)} disabled={!competencyId}>Ajustar escala</button></div>
    </section>
    {(generateNext.isSuccess || regenerate.isSuccess) && <div className="success month-generation-feedback"><strong>{generated.item.name}</strong> {regenerate.isSuccess ? 'regerado' : 'gerado'} com {generated.generation.ordinaryDutyDays} serviços ordinários. O download do PDF foi iniciado e o mês já está aberto abaixo.{generated.generation.conflictDays.length > 0 && <> Revise {generated.generation.conflictDays.length} dia(s) com conflito.</>}</div>}
    {(generateNext.isError || regenerate.isError) && <div className="error month-generation-feedback">{(generateNext.error || regenerate.error)?.response?.data?.message || 'Não foi possível gerar a escala do mês.'}</div>}
    {downloadError && <div className="error month-generation-feedback">{downloadError}</div>}
    {!generatedCompetencies.length
      ? <section className="panel empty-month"><h2>Nenhum mês gerado</h2><p>Use o botão “Gerar próximo mês”. Ele prepara a escala e baixa o PDF automaticamente.</p></section>
      : <section className="panel table-wrap"><div className="table-title"><div><h2>Horários de {selectedCompetency?.name}</h2><span>{days.length} dias neste mês</span></div></div>
        <table><thead><tr><th>Data</th><th>Turno do dia</th><th>Turno da noite</th><th>Posições livres</th><th /></tr></thead><tbody>{days.map((day) => {
          const daySlot = day.DIURNO; const nightSlot = day.NOTURNO;
          const available = (daySlot?.available_positions || 0) + (nightSlot?.available_positions || 0);
          const total = (daySlot?.current_capacity || 0) + (nightSlot?.current_capacity || 0);
          return <tr key={day.date}><td><strong>{dateLabel(day.date)}</strong></td><td>{coverage(daySlot)}</td><td>{coverage(nightSlot)}</td><td>{available} de {total}</td><td><button className="table-button" onClick={() => setConfirmationDate(day.date)}>Ver militares</button></td></tr>;
        })}</tbody></table>{!slots.length && <p className="empty-table">Este mês ainda não possui horários.</p>}</section>}

    {monthAction && <div className="modal-backdrop" role="presentation"><section className={`edit-modal month-confirmation-modal ${monthAction === 'REGENERATE' ? 'destructive' : ''}`} role="dialog" aria-modal="true" aria-label={monthAction === 'REGENERATE' ? 'Confirmar regeneração' : 'Confirmar geração'}>
      <div className="modal-header"><div><span className="eyebrow">{monthAction === 'REGENERATE' ? 'AÇÃO DESTRUTIVA' : 'CONFIRMAR NOVO MÊS'}</span><h2>{monthAction === 'REGENERATE' ? `Regerar ${selectedCompetency?.name}?` : `Gerar ${nextMonthName}?`}</h2></div><button className="close-button" onClick={() => setMonthAction(null)} aria-label="Fechar">×</button></div>
      {monthAction === 'GENERATE' ? <><div className="generation-notice"><strong>O que acontecerá:</strong><ul><li>Será criado o próximo mês com o ciclo ordinário 1x4.</li><li>O mês atual e suas marcações não serão apagados.</li><li>O novo mês será aberto na tela e o PDF será baixado.</li><li>O mês ativo do WhatsApp só muda quando você escolher na configuração ou usar o comando no grupo.</li></ul></div><div className="form-actions month-confirmation-actions"><button type="button" className="secondary-button" onClick={() => setMonthAction(null)}>Cancelar</button><button type="button" onClick={() => { setMonthAction(null); regenerate.reset(); generateNext.mutate(); }}>Sim, gerar {nextMonthName}</button></div></>
        : <>{regenerationImpact.isLoading ? <p className="modal-copy">Calculando quantas marcações serão afetadas...</p> : regenerationImpact.isError ? <p className="error">{regenerationImpact.error.response?.data?.message || 'Não foi possível calcular o impacto.'}</p> : <><div className="destructive-notice"><strong>As marcações ordinárias serão excluídas.</strong><p><b>{regenerationImpact.data.ordinaryAssignments}</b> marcações ordinárias, correspondentes a <b>{regenerationImpact.data.ordinaryDutyDays}</b> serviços, serão apagadas e geradas novamente.</p><p>Ajustes manuais feitos nesses ordinários serão perdidos. As <b>{regenerationImpact.data.extraordinaryAssignments}</b> marcações extras serão preservadas.</p></div><label className="destructive-acknowledgement"><input type="checkbox" checked={destructiveAcknowledged} onChange={(event) => setDestructiveAcknowledged(event.target.checked)} /><span>Entendi que as marcações ordinárias e seus ajustes serão excluídos e refeitos.</span></label></>}
        <div className="form-actions month-confirmation-actions"><button type="button" className="secondary-button" onClick={() => setMonthAction(null)}>Cancelar</button><button type="button" className="danger-button" disabled={!destructiveAcknowledged || regenerationImpact.isLoading || regenerationImpact.isError} onClick={() => { setMonthAction(null); generateNext.reset(); regenerate.mutate(); }}>Excluir ordinários e regerar</button></div></>}
    </section></div>}

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
