import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const today = new Date();
const statusLabels = { CONFIGURING: 'Em preparação', DRAFT: 'Rascunho', OPEN: 'Aberta', UNDER_REVIEW: 'Em revisão', APPROVED: 'Aprovada', PUBLISHED: 'Publicada', CLOSED: 'Encerrada', CANCELLED: 'Cancelada' };

export default function Competencies() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 });
  const { data = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then((response) => response.data.items) });
  const prepare = useMutation({ mutationFn: () => api.post('/competencies', { year: Number(form.year), month: Number(form.month) }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['competencies'] }) });
  const complete = useMutation({ mutationFn: (id) => api.post(`/competencies/${id}/prepare`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['competencies'] }) });
  return <>
    <header className="page-header"><div><span className="eyebrow">PLANEJAMENTO MENSAL</span><h1>Meses da escala</h1><p>Área manual para preparar ou completar uma competência específica.</p></div></header>
    <section className="panel month-prep"><div><span className="eyebrow">PREPARAR NOVO MÊS</span><h2>Criar escala mensal completa</h2><p>Use apenas para antecipar um mês. Com a abertura mensal ativa em Configurações, o próximo mês é preparado automaticamente no dia escolhido.</p></div><form className="form-grid" onSubmit={(event) => { event.preventDefault(); prepare.mutate(); }}><label>Ano<input type="number" value={form.year} onChange={(event) => setForm({ ...form, year: event.target.value })} /></label><label>Mês<select value={form.month} onChange={(event) => setForm({ ...form, month: Number(event.target.value) })}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{String(index + 1).padStart(2, '0')}</option>)}</select></label><button disabled={prepare.isPending}>Preparar mês</button></form>{prepare.isSuccess && <p className="success">Mês preparado com todos os horários de Dia e Noite.</p>}{prepare.isError && <p className="error">{prepare.error.response?.data?.message || 'Não foi possível preparar este mês.'}</p>}</section>
    <section className="panel table-wrap"><div className="table-title"><div><h2>Meses preparados</h2><span>{data.length} competências</span></div></div><table><thead><tr><th>Mês</th><th>Horários criados</th><th>Limite mensal</th><th>Situação</th><th /></tr></thead><tbody>{data.map((item) => { const expected = new Date(item.year, item.month, 0).getDate() * 2; const completeSchedule = item.slots_count === expected; return <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.slots_count} / {expected} turnos</td><td>192h por militar</td><td><span className="badge">{completeSchedule ? 'Pronto' : statusLabels[item.status] || item.status}</span></td><td>{completeSchedule ? <Link className="table-button month-link" to="/horarios">Abrir horários</Link> : <button className="table-button" onClick={() => complete.mutate(item.id)} disabled={complete.isPending}>Completar mês</button>}</td></tr>; })}</tbody></table></section>
  </>;
}
