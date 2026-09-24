import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const empty = { rank: 'Sgt', operational_name: '', unit_type: 'CICC', phone_number: '', whatsapp_jid: '', operational_status: 'ACTIVE', authorization_status: 'AUTHORIZED', active: true, monthly_hour_limit: '', hour_limit_exempt: false, ordinary_eligible: true, notes: '' };
const operationalOptions = [['ACTIVE', 'Ativo'], ['INACTIVE', 'Desativado'], ['VACATION', 'Férias'], ['LEAVE', 'Licença'], ['AWAY', 'Afastado']];
const authorizationLabels = { AUTHORIZED: 'Autorizado', PENDING: 'Pendente', SUSPENDED: 'Suspenso', NOT_AUTHORIZED: 'Não autorizado' };

function MemberForm({ value, onChange, onSubmit, pending, editing, onCancel }) {
  const set = (key, nextValue) => onChange({ ...value, [key]: nextValue });
  return <form className="member-form form-grid" onSubmit={onSubmit}>
    <label>Graduação<input value={value.rank} onChange={event => set('rank', event.target.value)} required /></label><label>Nome operacional<input value={value.operational_name} onChange={event => set('operational_name', event.target.value)} required /></label><label>Base<select value={value.unit_type} onChange={event => set('unit_type', event.target.value)}><option value="CICC">CICC</option><option value="APOIO">Apoio</option></select></label>
    <label>Telefone<input value={value.phone_number || ''} placeholder="5583..." onChange={event => set('phone_number', event.target.value)} /></label><label>JID do WhatsApp<input value={value.whatsapp_jid || ''} placeholder="5583...@s.whatsapp.net" onChange={event => set('whatsapp_jid', event.target.value)} /></label><label>Situação<select value={value.operational_status} onChange={event => { const status = event.target.value; onChange({ ...value, operational_status: status, active: status !== 'INACTIVE' }); }}>{operationalOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>Autorização<select value={value.authorization_status} onChange={event => set('authorization_status', event.target.value)}>{Object.entries(authorizationLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Limite mensal (horas)<input type="number" min="12" max="192" step="12" disabled={Boolean(value.hour_limit_exempt)} value={value.monthly_hour_limit ?? ''} placeholder="Padrão: 192" onChange={event => set('monthly_hour_limit', event.target.value)} /><small>{value.hour_limit_exempt ? 'Sem limite: este campo não é aplicado.' : 'Em branco, usa o limite padrão de 192h.'}</small></label><label className="hour-exempt-option"><input type="checkbox" checked={Boolean(value.hour_limit_exempt)} onChange={event => set('hour_limit_exempt', event.target.checked)} /><span>Não contabilizar horas<small>Permite marcar sem consumir ou bloquear pelo limite mensal.</small></span></label><label className="ordinary-schedule-option"><input type="checkbox" checked={Boolean(value.ordinary_eligible)} onChange={event => set('ordinary_eligible', event.target.checked)} /><span>Participa da escala ordinária automática<small>Desmarque para usar o bot e marcar extras sem entrar no ciclo 1x4.</small></span></label><label className="full-width">Observação administrativa<input value={value.notes || ''} onChange={event => set('notes', event.target.value)} placeholder="Opcional" /></label>
    <div className="form-actions"><button type="submit" disabled={pending}>{editing ? 'Salvar alterações' : 'Cadastrar militar'}</button>{editing && <button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button>}</div>
  </form>;
}

export default function Members() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [statusFeedback, setStatusFeedback] = useState('');
  const [competencyId, setCompetencyId] = useState('');
  const { data: competencies = [] } = useQuery({ queryKey: ['competencies'], queryFn: () => api.get('/competencies').then(response => response.data.items) });
  const generatedCompetencies = competencies.filter(item => item.generated_at);
  useEffect(() => {
    if (!generatedCompetencies.length || generatedCompetencies.some((item) => String(item.id) === String(competencyId))) return;
    const today = new Date();
    const currentMonth = generatedCompetencies.find((item) => item.year === today.getFullYear() && item.month === today.getMonth() + 1);
    setCompetencyId(String((currentMonth || generatedCompetencies[0]).id));
  }, [competencies, competencyId]);
  const { data = [], isLoading } = useQuery({ queryKey: ['members', competencyId], queryFn: () => api.get('/members', { params: competencyId ? { competency_id: competencyId } : {} }).then(response => response.data.items) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['members'] });
  const downloadSchedulePdf = async () => {
    if (!competencyId) return;
    const competency = generatedCompetencies.find(item => String(item.id) === String(competencyId));
    const response = await api.get('/service-slots/pdf', { params: { competency_id: competencyId }, responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = competency ? `escala-${competency.year}-${String(competency.month).padStart(2, '0')}.pdf` : 'escala-atualizada.pdf';
    link.click();
    URL.revokeObjectURL(url);
  };
  const handleStatusEffect = async response => {
    invalidate();
    if (!response.data.statusEffect) return;
    setStatusFeedback(response.data.statusEffect.type === 'REGENERATED_ON_REACTIVATION'
      ? 'Militar ativado, escala ordinária regerada e PDF atualizado baixado.'
      : 'Férias aplicadas na escala selecionada e PDF atualizado baixado.');
    await downloadSchedulePdf();
  };
  const save = useMutation({
    mutationFn: member => { const payload = { ...member, competency_id: member.id && competencyId ? Number(competencyId) : undefined, phone_number: member.phone_number || null, whatsapp_jid: member.whatsapp_jid || null, monthly_hour_limit: member.monthly_hour_limit === '' || member.monthly_hour_limit === null ? null : Number(member.monthly_hour_limit), hour_limit_exempt: Boolean(member.hour_limit_exempt), ordinary_eligible: Boolean(member.ordinary_eligible), notes: member.notes || null }; return member.id ? api.patch(`/members/${member.id}`, payload) : api.post('/members', payload); },
    onSuccess: async response => { await handleStatusEffect(response); setForm(empty); setEditing(null); }
  });
  const changeStatus = useMutation({
    mutationFn: ({ id, status }) => api.patch(`/members/${id}`, { operational_status: status, active: status !== 'INACTIVE', competency_id: competencyId ? Number(competencyId) : undefined }),
    onSuccess: handleStatusEffect
  });
  const removeMember = useMutation({ mutationFn: id => api.delete(`/members/${id}`), onSuccess: () => { invalidate(); setDeleteTarget(null); } });
  const submit = event => { event.preventDefault(); save.mutate(form); };
  const openEdit = member => { setForm({ ...member, phone_number: member.phone_number || '', whatsapp_jid: member.whatsapp_jid || '', monthly_hour_limit: member.monthly_hour_limit ?? '', hour_limit_exempt: Boolean(member.hour_limit_exempt), ordinary_eligible: Number(member.ordinary_eligible) !== 0, notes: member.notes || '', active: Boolean(member.active) }); setEditing(member); };

  return <><header className="page-header"><div><span className="eyebrow">CADASTRO OPERACIONAL</span><h1>Efetivo</h1><p>Edite dados, situação e o limite mensal individual de horas.</p></div><button className="page-action" onClick={() => { setEditing({}); setForm(empty); }}>+ Novo militar</button></header>
    {statusFeedback && <div className="success">{statusFeedback}</div>}
    <section className="panel member-hours-filter"><div><span className="eyebrow">ESCALA SELECIONADA</span><h2>Competência para situação e horas</h2><p>Férias retiram somente os serviços ordinários; os extras são mantidos e continuam liberados. Cada serviço extra confirmado vale 12h.</p></div><label>Mês / competência<select value={competencyId} onChange={event => setCompetencyId(event.target.value)}><option value="">Selecione uma escala gerada</option>{generatedCompetencies.map(competency => <option value={competency.id} key={competency.id}>{competency.name}</option>)}</select></label></section>
    <section className="panel table-wrap members-table"><div className="table-title"><div><h2>Militares cadastrados</h2><span>{data.length} registros</span></div></div><table><thead><tr><th>Ordem</th><th>Militar</th><th>Telefone</th><th>Base</th><th>Ala</th><th>Ordinária automática</th><th>Horas extras no mês</th><th>Situação</th><th>Autorização</th><th></th></tr></thead><tbody>{isLoading ? <tr><td colSpan="10">Carregando…</td></tr> : data.map(member => <tr key={member.id}><td>{member.seniority_position || '—'}</td><td><strong>{member.rank} {member.operational_name}</strong></td><td>{member.phone_number || 'Não informado'}</td><td>{member.unit_type === 'APOIO' ? 'Apoio' : 'CICC'}</td><td>{member.wing_name || '—'}</td><td><span className={`ordinary-badge ${Number(member.ordinary_eligible) === 0 ? 'excluded' : ''}`}>{Number(member.ordinary_eligible) === 0 ? 'Não participa' : 'Participa'}</span></td><td>{competencyId ? member.hour_limit_exempt ? <span className="hours-badge exempt">Sem limite</span> : <span className={`hours-badge ${member.monthly_hours >= 198 ? 'limit' : ''}`}>{member.monthly_hours}h / {member.effective_hour_limit}h</span> : '—'}</td><td><select className={`status-select status-${member.operational_status.toLowerCase()}`} value={member.operational_status} onChange={event => changeStatus.mutate({ id: member.id, status: event.target.value })}>{operationalOptions.map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></td><td><span className="badge">{authorizationLabels[member.authorization_status]}</span></td><td><div className="member-row-actions"><button className="table-button" onClick={() => openEdit(member)}>Editar</button><button className="table-button danger-table-button" onClick={() => { removeMember.reset(); setDeleteTarget(member); }}>Excluir</button></div></td></tr>)}</tbody></table></section>
    {editing && <div className="modal-backdrop" role="presentation"><section className="edit-modal" role="dialog" aria-modal="true" aria-label="Editar militar"><div className="modal-header"><div><span className="eyebrow">{editing.id ? 'EDITAR MILITAR' : 'NOVO MILITAR'}</span><h2>{editing.id ? `${editing.rank} ${editing.operational_name}` : 'Cadastro de militar'}</h2></div><button className="close-button" onClick={() => { setEditing(null); setForm(empty); }} aria-label="Fechar">×</button></div><MemberForm value={form} onChange={setForm} onSubmit={submit} pending={save.isPending} editing={Boolean(editing.id)} onCancel={() => { setEditing(null); setForm(empty); }} />{save.isError && <p className="error">{save.error.response?.data?.message || 'Não foi possível salvar o militar.'}</p>}</section></div>}
    {deleteTarget && <div className="modal-backdrop" role="presentation"><section className="edit-modal member-delete-modal" role="dialog" aria-modal="true" aria-label="Excluir militar"><div className="modal-header"><div><span className="eyebrow">EXCLUSÃO DO CADASTRO</span><h2>Excluir {deleteTarget.rank} {deleteTarget.operational_name}?</h2></div><button className="close-button" onClick={() => setDeleteTarget(null)} aria-label="Fechar">×</button></div><p>O cadastro será removido definitivamente. Se o militar já possuir escala ou histórico operacional, o sistema bloqueará a exclusão e orientará a desativação.</p>{removeMember.isError && <p className="error">{removeMember.error.response?.data?.message || 'Não foi possível excluir o militar.'}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={removeMember.isPending}>Cancelar</button><button type="button" className="danger-button" onClick={() => removeMember.mutate(deleteTarget.id)} disabled={removeMember.isPending}>{removeMember.isPending ? 'Excluindo…' : 'Excluir definitivamente'}</button></div></section></div>}
  </>;
}
