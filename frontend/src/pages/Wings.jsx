import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useMonthRollover } from '../hooks/useMonthRollover.js';

const name = (member) => `${member.rank} ${member.operational_name}`;
const dateLabel = (value) => value ? value.slice(0, 10).split('-').reverse().join('/') : '';
const statusLabel = { ACTIVE: 'Ativo', VACATION: 'Férias', LEAVE: 'Licença', AWAY: 'Afastado', INACTIVE: 'Desativado' };
const localToday = () => new Date().toLocaleDateString('en-CA');

export default function Wings() {
  const client = useQueryClient();
  const [competencyId, setCompetencyId] = useState('');
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const session = useQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me').then((r) => r.data.user) });
  const editable = ['ADMIN', 'SCHEDULER'].includes(session.data?.role);
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((r) => r.data.items) });
  const generated = competencies.filter((item) => item.generated_at);
  useMonthRollover(competencies, competencyId, setCompetencyId, Boolean(preview || editing));
  useEffect(() => {
    if (generated.some((item) => String(item.id) === competencyId)) return;
    const today = new Date();
    const current = generated.find((item) => item.year === today.getFullYear() && item.month === today.getMonth() + 1);
    if (generated.length) setCompetencyId(String((current || generated[0]).id));
  }, [competencies, competencyId]);
  const query = useQuery({ queryKey: ['wings', competencyId], enabled: Boolean(competencyId),
    queryFn: () => api.get('/wings', { params: { competency_id: competencyId } }).then((r) => r.data) });
  const data = query.data;
  const wings = data?.wings || [];
  const members = data?.members || [];
  const start = data ? `${data.competency.year}-${String(data.competency.month).padStart(2, '0')}-01` : '';
  const end = data ? `${start.slice(0, 8)}${new Date(data.competency.year, data.competency.month, 0).getDate()}` : '';
  const refresh = async () => {
    await Promise.all(['wings', 'members', 'schedule-management', 'slots', 'dashboard', 'competencies'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  };
  const loadPreview = useMutation({ mutationFn: () => api.get('/wings/import-preview', { params: { competency_id: competencyId } }),
    onSuccess: (response) => { setPreview(response.data); saveImport.reset(); } });
  const saveImport = useMutation({ mutationFn: () => api.post('/wings/import', { competencyId: Number(competencyId),
    entries: preview.entries.map(({ memberId, wingId, positionNumber }) => ({ memberId, wingId, positionNumber })) }),
    onSuccess: async (response) => { setPreview(null); setFeedback(response.data.message); await refresh(); } });
  const move = useMutation({ mutationFn: () => {
    const entries = [{ memberId: editing.memberId, wingId: Number(editing.wingId), positionNumber: Number(editing.positionNumber) }];
    if (editing.partnerId) entries.push({ memberId: Number(editing.partnerId), wingId: editing.originalWingId, positionNumber: editing.originalPosition });
    return api.post('/wings/move', { competencyId: Number(competencyId), scope: editing.scope, entries,
      fromDate: editing.scope === 'THIS_MONTH' ? editing.fromDate : undefined });
  }, onSuccess: async (response) => { setEditing(null); setFeedback(response.data.message); await refresh(); } });
  const openMove = (memberId, scope = 'NEXT_MONTH') => {
    const rows = scope === 'NEXT_MONTH' ? data.nextMemberships : data.memberships;
    const current = rows.find((row) => row.member_id === memberId);
    move.reset();
    setEditing({ memberId, scope, wingId: current?.wing_id || wings[0]?.id, positionNumber: current?.position_number || 1,
      originalWingId: current?.wing_id || null, originalPosition: current?.position_number || null,
      fromDate: [start, localToday()].sort().at(-1), partnerId: '' });
  };
  const download = async () => {
    setDownloadError('');
    try {
      const response = await api.get('/service-slots/pdf', { params: { competency_id: competencyId }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a'); link.href = url; link.download = `escala-${start.slice(0, 7)}.pdf`; link.click();
      URL.revokeObjectURL(url);
    } catch { setDownloadError('Não foi possível baixar o PDF. Tente novamente.'); }
  };
  const editRows = editing?.scope === 'THIS_MONTH' ? data?.memberships : data?.nextMemberships;
  const error = query.error || loadPreview.error;
  return <>
    <header className="page-header"><div><span className="eyebrow">ORGANIZAÇÃO DO SERVIÇO ORDINÁRIO</span><h1>Alas · ciclo 1x4</h1><p>Cinco equipes, uma escala. Organize os militares e planeje as próximas mudanças.</p></div>
      <Link className="secondary-button wings-link" to={`/gerenciar-escala?competency_id=${competencyId}`}>Gerenciar escala</Link></header>
    <section className="panel wings-toolbar"><label>Mês de referência<select value={competencyId} onChange={(e) => {
      setCompetencyId(e.target.value); setPreview(null); setEditing(null); setFeedback(''); loadPreview.reset();
    }}><option value="">Selecione uma escala</option>{generated.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <p>As datas abaixo mostram o ciclo da ala no mês selecionado. Férias e indisponibilidades continuam sendo respeitadas na geração.</p>
      <button className="secondary-button" disabled={!data} onClick={download}>Baixar PDF</button></section>
    {feedback && <p className="success" role="status">{feedback}</p>}
    {(error || downloadError) && <p className="error" role="alert">{downloadError || error?.response?.data?.message || 'Não foi possível carregar as alas.'}</p>}
    {query.isLoading && competencyId && <section className="panel">Carregando alas…</section>}
    {!generated.length && <section className="panel"><h2>Prepare uma escala primeiro</h2><p>As alas serão cadastradas a partir de um mês já gerado.</p><Link to="/horarios">Ir para Gestão do mês</Link></section>}
    {data && <>
      <section className="panel wings-cycle"><div><span className="eyebrow">REGRA FIXA DA ESCALA</span><h2>Ciclo 1x4 contínuo</h2>
        <p>A sequência das alas continua entre os meses. Se o último dia for da Ala 3, o dia 1 do mês seguinte será da Ala 4. Cada militar mantém o intervalo de cinco dias entre os serviços.</p>
        {!data.configured && editable && <button onClick={() => loadPreview.mutate()} disabled={loadPreview.isPending}>{loadPreview.isPending ? 'Lendo escala…' : 'Cadastrar alas pela escala atual'}</button>}</div>
        <div className="wings-continuous-rule"><strong>1 → 2 → 3 → 4 → 5 → 1</strong><span>Sem reiniciar no dia 1</span><small>Vale para gerar e regerar qualquer mês.</small></div></section>
      <div className="wings-grid">{wings.map((wing) => {
        const roster = data.memberships.filter((row) => row.wing_id === wing.id);
        return <section key={wing.id} className={`panel wing-card wing-${wing.number}`}><header><span className="wing-number">{wing.number}</span><div><h2>{wing.name}</h2><span>Ciclo ordinário · 24 horas</span></div></header>
          <div className="wing-dates">{wing.dates.length ? wing.dates.map((date) => <span key={date}>{Number(date.slice(-2))}</span>) : <small>Cadastre as alas para visualizar os dias.</small>}</div>
          <div className="wing-members">{[1, 2].map((position) => {
            const entries = roster.filter((row) => row.position_number === position);
            return <div className="wing-position" key={position}><span className="eyebrow">{position}ª POSIÇÃO</span>
              {!entries.length && <p className="wing-empty">Sem militar cadastrado</p>}
              {entries.map((row) => { const member = members.find((item) => item.id === row.member_id); if (!member) return null;
                const next = data.nextMemberships.find((item) => item.member_id === row.member_id);
                return <div key={row.member_id} className="wing-person"><strong>{name(member)}</strong><small>{statusLabel[member.operational_status]}{!member.ordinary_eligible ? ' · Fora da ordinária' : ''}</small>
                  {row.temporary && <span className="wing-tag">Somente este mês · desde {dateLabel(row.from_date)}</span>}
                  {next && (next.wing_id !== row.wing_id || next.position_number !== row.position_number) && <span className="wing-tag next">Próximo mês: {wings.find((item) => item.id === next.wing_id)?.name} · {next.position_number}ª posição</span>}
                  {editable && <button className="table-button" onClick={() => openMove(member.id)}>Trocar / remanejar</button>}</div>;
              })}</div>;
          })}</div></section>;
      })}</div>
      {data.configured && <section className="panel wings-roster"><div><h2>Efetivo e mudanças programadas</h2><p>Veja a ala deste mês e a que será usada no próximo. Use “Trocar” para incluir ou remanejar um militar.</p></div>
        <div className="table-wrap"><table><thead><tr><th>Militar</th><th>Neste mês</th><th>Próximo mês</th><th>Situação</th>{editable && <th>Ação</th>}</tr></thead><tbody>{members.map((member) => {
          const current = data.memberships.find((row) => row.member_id === member.id);
          const next = data.nextMemberships.find((row) => row.member_id === member.id);
          const label = (row) => row ? `${wings.find((item) => item.id === row.wing_id)?.name} · ${row.position_number}ª` : 'Sem ala';
          return <tr key={member.id}><td><strong>{name(member)}</strong></td><td>{label(current)}{current?.temporary && <small className="wing-table-note">Temporária</small>}</td><td>{label(next)}</td><td>{statusLabel[member.operational_status]}</td>
            {editable && <td><button className="table-button" onClick={() => openMove(member.id)}>{current ? 'Trocar' : 'Incluir na ala'}</button></td>}</tr>;
        })}</tbody></table></div></section>}
    </>}
    {preview && <div className="modal-backdrop"><section className="edit-modal wings-modal" role="dialog" aria-modal="true" aria-label="Conferir alas da escala">
      <div className="modal-header"><div><span className="eyebrow">CADASTRAR PELA ESCALA ATUAL</span><h2>Confira cada militar</h2></div><button className="close-button" aria-label="Fechar" onClick={() => setPreview(null)} disabled={saveImport.isPending}>×</button></div>
      <p>Ala 1 corresponde aos dias 1, 6, 11… deste mês; Ala 2 aos dias 2, 7, 12… O cadastro não reorganiza a escala já publicada.</p>
      {preview.unresolved.length > 0 && <div className="wings-import-notice"><strong>Precisam de conferência</strong>{preview.unresolved.map((item) => <p key={item.memberId}>{item.name}: {item.reason}</p>)}<p>Esses militares poderão ser incluídos manualmente depois do cadastro.</p></div>}
      <div className="table-wrap"><table><thead><tr><th>Militar</th><th>Ala</th><th>Posição</th><th></th></tr></thead><tbody>{preview.entries.map((item, index) => <tr key={item.memberId}>
        <td><strong>{item.name}</strong><small className="wing-table-note">{item.source === 'ESCALA' ? 'Identificado na escala' : 'Pelo ciclo ordinário anterior'}</small></td>
        <td><select aria-label={`Ala de ${item.name}`} value={item.wingId} onChange={(e) => setPreview({ ...preview, entries: preview.entries.map((row, i) => i === index ? { ...row, wingId: Number(e.target.value) } : row) })}>{wings.map((wing) => <option key={wing.id} value={wing.id}>{wing.name}</option>)}</select></td>
        <td><select aria-label={`Posição de ${item.name}`} value={item.positionNumber} onChange={(e) => setPreview({ ...preview, entries: preview.entries.map((row, i) => i === index ? { ...row, positionNumber: Number(e.target.value) } : row) })}><option value={1}>1ª</option><option value={2}>2ª</option></select></td>
        <td><button className="table-button" onClick={() => setPreview({ ...preview, entries: preview.entries.filter((row) => row.memberId !== item.memberId) })}>Deixar para depois</button></td></tr>)}</tbody></table></div>
      {!preview.entries.length && <p>Nenhum ciclo ordinário identificado. Inclua pelo menos um militar abaixo para começar.</p>}
      <label>Adicionar militar à conferência<select value="" onChange={(e) => { const member = members.find((item) => item.id === Number(e.target.value)); if (member) setPreview({ ...preview, entries: [...preview.entries,
        { memberId: member.id, name: name(member), wingId: wings[0].id, positionNumber: 1, source: 'MANUAL' }] }); }}><option value="">Selecione um militar</option>{members.filter((member) => !preview.entries.some((row) => row.memberId === member.id)).map((member) => <option value={member.id} key={member.id}>{name(member)}</option>)}</select></label>
      {saveImport.isError && <p className="error" role="alert">{saveImport.error.response?.data?.message || 'Não foi possível cadastrar as alas.'}</p>}
      <div className="form-actions"><button disabled={!preview.entries.length || saveImport.isPending} onClick={() => saveImport.mutate()}>{saveImport.isPending ? 'Cadastrando…' : 'Confirmar cadastro das cinco alas'}</button><button className="secondary-button" disabled={saveImport.isPending} onClick={() => setPreview(null)}>Cancelar</button></div>
    </section></div>}
    {editing && <div className="modal-backdrop"><section className="edit-modal wings-modal" role="dialog" aria-modal="true" aria-label="Trocar ala do militar">
      <div className="modal-header"><div><span className="eyebrow">TROCA DE ALA</span><h2>{name(members.find((member) => member.id === editing.memberId))}</h2></div><button className="close-button" aria-label="Fechar" disabled={move.isPending} onClick={() => setEditing(null)}>×</button></div>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); move.mutate(); }}>
        <label className="full-width">Quando aplicar?<select value={editing.scope} onChange={(e) => openMove(editing.memberId, e.target.value)}><option value="NEXT_MONTH">Próximo mês em diante · permanente</option><option value="THIS_MONTH">Somente este mês · temporária</option></select></label>
        <label>Ala de destino<select value={editing.wingId} onChange={(e) => setEditing({ ...editing, wingId: Number(e.target.value), partnerId: '' })}>{wings.map((wing) => <option key={wing.id} value={wing.id}>{wing.name}</option>)}</select></label>
        <label>Posição<select value={editing.positionNumber} onChange={(e) => setEditing({ ...editing, positionNumber: Number(e.target.value), partnerId: '' })}><option value={1}>1ª posição</option><option value={2}>2ª posição</option></select></label>
        {editing.scope === 'THIS_MONTH' && <label>A partir de<input type="date" min={[start, localToday()].sort().at(-1)} max={end} required value={editing.fromDate} onChange={(e) => setEditing({ ...editing, fromDate: e.target.value })} /></label>}
        {editing.originalWingId && <label className="full-width">Trocar com outro militar? (opcional)<select value={editing.partnerId} onChange={(e) => {
          const other = editRows.find((row) => row.member_id === Number(e.target.value));
          setEditing({ ...editing, partnerId: e.target.value, ...(other ? { wingId: other.wing_id, positionNumber: other.position_number } : {}) });
        }}><option value="">Somente remanejar para uma posição livre</option>{editRows.filter((row) => row.member_id !== editing.memberId).map((row) => <option key={row.member_id} value={row.member_id}>{name(members.find((member) => member.id === row.member_id))} · {wings.find((wing) => wing.id === row.wing_id)?.name} · {row.position_number}ª</option>)}</select></label>}
        <p className="full-width wings-change-summary">{editing.scope === 'NEXT_MONTH' ? `A mudança será usada nas gerações a partir de ${dateLabel(data.nextMonth.startsAt)}. Se o mês já estiver gerado, aplique com Regerar.`
          : `Apenas os ordinários de ${dateLabel(editing.fromDate)} em diante serão recalculados neste mês. Os extras e os dias anteriores ficam preservados; no próximo mês, volta a ala permanente.`}</p>
        {move.isError && <p className="error full-width" role="alert">{move.error.response?.data?.message || 'Não foi possível salvar a mudança.'}</p>}
        <div className="form-actions full-width"><button disabled={move.isPending}>{move.isPending ? 'Salvando…' : editing.scope === 'THIS_MONTH' ? 'Aplicar neste mês' : 'Programar troca permanente'}</button><button className="secondary-button" disabled={move.isPending} type="button" onClick={() => setEditing(null)}>Cancelar</button></div>
      </form></section></div>}
  </>;
}
