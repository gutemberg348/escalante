import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const initialSettings = { dailyEnabled: false, dailyTime: '18:00', monthlyEnabled: false, monthlyDay: 25, monthlyTime: '07:00', markingReminderEnabled: true, markingReminderMinutes: 60 };

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: automation, isLoading } = useQuery({ queryKey: ['whatsapp-automation'], queryFn: () => api.get('/whatsapp/automation').then((response) => response.data.item) });
  const [settings, setSettings] = useState(initialSettings);
  useEffect(() => { if (automation) setSettings({ ...initialSettings, ...automation }); }, [automation]);
  const save = useMutation({ mutationFn: () => api.put('/whatsapp/automation', settings), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp-automation'] }) });
  const set = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  return <>
    <header className="page-header"><div><span className="eyebrow">ADMINISTRAÇÃO</span><h1>Configurações</h1><p>Defina o momento de cada envio automático para o grupo.</p></div></header>
    <section className="panel settings-automation">
      <span className="eyebrow">ROTINAS DO WHATSAPP</span><h2>Envios automáticos</h2><p>O prazo individual de marcação é definido em <strong>Antiguidade</strong>. Esta página controla somente as mensagens automáticas.</p>
      <form className="automation-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <article className={`automation-card ${settings.dailyEnabled ? 'active' : ''}`}>
          <div className="automation-card-head"><div><h3>Escala de amanhã</h3><p>Publica a escala do dia seguinte.</p></div><label className="automation-toggle"><input type="checkbox" checked={settings.dailyEnabled} onChange={(event) => set('dailyEnabled', event.target.checked)} /><span>Ativar</span></label></div>
          <label>Horário de envio<input type="time" required disabled={!settings.dailyEnabled} value={settings.dailyTime} onChange={(event) => set('dailyTime', event.target.value)} /></label>
        </article>
        <article className={`automation-card ${settings.monthlyEnabled ? 'active' : ''}`}>
          <div className="automation-card-head"><div><h3>Vagas do próximo mês</h3><p>Envia o PDF, publica todas as vagas e chama o primeiro da fila.</p></div><label className="automation-toggle"><input type="checkbox" checked={settings.monthlyEnabled} onChange={(event) => set('monthlyEnabled', event.target.checked)} /><span>Ativar</span></label></div>
          <div className="automation-fields"><label>Dia do mês<input type="number" min="1" max="31" required disabled={!settings.monthlyEnabled} value={settings.monthlyDay} onChange={(event) => set('monthlyDay', Number(event.target.value))} /></label><label>Horário<input type="time" required disabled={!settings.monthlyEnabled} value={settings.monthlyTime} onChange={(event) => set('monthlyTime', event.target.value)} /></label></div><small>Exemplo: dia 25 prepara e envia as vagas do mês seguinte.</small>
        </article>
        <article className={`automation-card ${settings.markingReminderEnabled ? 'active' : ''}`}>
          <div className="automation-card-head"><div><h3>Tabela de vagas</h3><p>Repete a tabela enquanto existir uma vez aberta.</p></div><label className="automation-toggle"><input type="checkbox" checked={settings.markingReminderEnabled} onChange={(event) => set('markingReminderEnabled', event.target.checked)} /><span>Ativar</span></label></div>
          <label>Repetir a cada (minutos)<input type="number" min="5" max="720" required disabled={!settings.markingReminderEnabled} value={settings.markingReminderMinutes} onChange={(event) => set('markingReminderMinutes', Number(event.target.value))} /></label>
        </article>
        <div className="automation-footer"><small>Último envio diário: {automation?.lastDailyRun || 'ainda não enviado'} · Último envio mensal: {automation?.lastMonthlyRun || 'ainda não enviado'}</small><button disabled={save.isPending || isLoading}>Salvar configurações</button></div>
      </form>
      {save.isSuccess && <p className="success">Configurações salvas.</p>}{save.isError && <p className="error">{save.error.response?.data?.message || 'Não foi possível salvar as configurações.'}</p>}
    </section>
  </>;
}
