import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const initialSettings = { dailyEnabled: false, dailyTime: '18:00', monthlyEnabled: false, monthlyDay: 25, monthlyTime: '07:00', markingReminderEnabled: true, markingReminderMinutes: 60 };

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: automation, isLoading } = useQuery({ queryKey: ['whatsapp-automation'], queryFn: () => api.get('/whatsapp/automation').then((response) => response.data.item) });
  const [settings, setSettings] = useState(initialSettings);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  const [passwordError, setPasswordError] = useState('');
  useEffect(() => { if (automation) setSettings({ ...initialSettings, ...automation }); }, [automation]);
  const save = useMutation({ mutationFn: () => api.put('/whatsapp/automation', settings), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp-automation'] }) });
  const changePassword = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '', confirmation: '' });
      setPasswordError('');
      queryClient.invalidateQueries({ queryKey: ['me'] });
    }
  });
  const set = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const setPassword = (key, value) => {
    setPasswords((current) => ({ ...current, [key]: value }));
    setPasswordError('');
    changePassword.reset();
  };
  const submitPassword = (event) => {
    event.preventDefault();
    if (passwords.newPassword.length < 12) return setPasswordError('A nova senha precisa ter pelo menos 12 caracteres.');
    if (passwords.newPassword !== passwords.confirmation) return setPasswordError('A confirmação não é igual à nova senha.');
    changePassword.mutate();
  };
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
          <div className="automation-card-head"><div><h3>Vagas do próximo mês</h3><p>Gera a escala e envia o PDF. A fila aguarda o comando com data e coluna.</p></div><label className="automation-toggle"><input type="checkbox" checked={settings.monthlyEnabled} onChange={(event) => set('monthlyEnabled', event.target.checked)} /><span>Ativar</span></label></div>
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
    <section className="panel password-settings">
      <div className="password-settings-copy"><span className="eyebrow">SEGURANÇA DA CONTA</span><h2>Trocar senha</h2><p>A alteração vale para o seu usuário do painel. A senha precisa ter pelo menos 12 caracteres.</p></div>
      <form className="password-form" onSubmit={submitPassword}>
        <label>Senha atual<input type="password" required autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPassword('currentPassword', event.target.value)} /></label>
        <label>Nova senha<input type="password" required minLength="12" autoComplete="new-password" value={passwords.newPassword} onChange={(event) => setPassword('newPassword', event.target.value)} /></label>
        <label>Confirmar nova senha<input type="password" required minLength="12" autoComplete="new-password" value={passwords.confirmation} onChange={(event) => setPassword('confirmation', event.target.value)} /></label>
        <div className="password-form-footer"><span>Você continuará conectado depois da alteração.</span><button disabled={changePassword.isPending}>{changePassword.isPending ? 'Alterando…' : 'Alterar senha'}</button></div>
        {passwordError && <p className="error">{passwordError}</p>}
        {changePassword.isSuccess && <p className="success">Senha alterada com sucesso. Use a nova senha no próximo acesso.</p>}
        {changePassword.isError && <p className="error">{changePassword.error.response?.data?.message || 'Não foi possível alterar a senha.'}</p>}
      </form>
    </section>
  </>;
}
