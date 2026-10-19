import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import ConfirmationDialog from './ConfirmationDialog.jsx';

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
    {targetId && <ConfirmationDialog title={`Excluir ${impact.data?.competency.name || 'mês'}?`}
      pending={remove.isPending} confirmDisabled={!impact.data || impact.isFetching || impact.isError}
      confirmLabel="Excluir mês e marcações" onClose={close} onConfirm={() => remove.mutate()}
      error={(impact.error || remove.error) ? (impact.error || remove.error).response?.data?.message || 'Não foi possível excluir o mês.' : ''}>
      {impact.isLoading && <p>Conferindo marcações…</p>}
      {impact.data && <>
        <p>Serão excluídos todos os horários e as {impact.data.assignments} marcações deste mês: {impact.data.ordinaryAssignments} ordinárias e {impact.data.extraordinaryAssignments} extras.</p>
        <p>Essa exclusão é permanente. O cadastro dos militares e das alas será mantido.</p>
        {impact.data.activeOnWhatsApp && <p>Este é o mês ativo no WhatsApp. A fila será encerrada e outro mês disponível será selecionado.</p>}
      </>}
    </ConfirmationDialog>}
  </>;
}
