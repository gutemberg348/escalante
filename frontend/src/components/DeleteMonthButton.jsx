import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

export default function DeleteMonthButton({ competencyId, onDeleted, onOpenChange = () => {} }) {
  const client = useQueryClient();
  const [targetId, setTargetId] = useState(null);
  const impact = useQuery({ queryKey: ['month-deletion-impact', targetId], enabled: Boolean(targetId),
    queryFn: () => api.get(`/competencies/${targetId}/deletion-impact`).then((response) => response.data.item) });
  const close = () => { setTargetId(null); onOpenChange(false); };
  const remove = useMutation({ mutationFn: () => api.delete(`/competencies/${targetId}`, { data: { confirm: true } }).then((response) => response.data),
    onSuccess: async (result) => {
      const items = (client.getQueryData(['competencies']) || []).filter((item) => item.id !== result.competency.id);
      client.setQueryData(['competencies'], items);
      const generated = items.filter((item) => item.generated_at);
      const today = new Date();
      const selected = generated.find((item) => item.year === today.getFullYear() && item.month === today.getMonth() + 1) || generated[0];
      close(); onDeleted(selected ? String(selected.id) : '', result.message);
      await Promise.all(['competencies', 'slots', 'pdf-columns', 'schedule-management', 'members', 'wings', 'dashboard', 'whatsapp', 'month-generation-preview']
        .map((key) => client.invalidateQueries({ queryKey: [key] })));
    } });
  return <>
    <button type="button" className="secondary-button danger-table-button" disabled={!competencyId || remove.isPending}
      onClick={() => { remove.reset(); setTargetId(Number(competencyId)); onOpenChange(true); }}>Excluir mês</button>
    {targetId && <div className="modal-backdrop"><section className="edit-modal" role="dialog" aria-modal="true" aria-label="Excluir mês da escala">
      <div className="modal-header"><h2>Excluir {impact.data?.competency.name || 'mês'}?</h2><button type="button" className="close-button" aria-label="Fechar" disabled={remove.isPending} onClick={close}>×</button></div>
      {impact.isLoading && <p>Conferindo marcações…</p>}
      {impact.data && <>
        <p>Serão excluídos todos os horários e as {impact.data.assignments} marcações deste mês: {impact.data.ordinaryAssignments} ordinárias e {impact.data.extraordinaryAssignments} extras.</p>
        <p>Essa exclusão é permanente. O cadastro dos militares e das alas será mantido.</p>
        {impact.data.activeOnWhatsApp && <p>Este é o mês ativo no WhatsApp. A fila será encerrada e outro mês disponível será selecionado.</p>}
      </>}
      {(impact.error || remove.error) && <p className="error" role="alert">{(impact.error || remove.error).response?.data?.message || 'Não foi possível excluir o mês.'}</p>}
      <div className="form-actions"><button type="button" className="secondary-button" disabled={remove.isPending} onClick={close}>Cancelar</button>
        <button type="button" className="danger-button" disabled={!impact.data || impact.isFetching || remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Excluindo…' : 'Excluir mês e marcações'}</button></div>
    </section></div>}
  </>;
}
