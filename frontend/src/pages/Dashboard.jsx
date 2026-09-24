import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

const labels = {
  eligible_members: ['Militares aptos', 'Autorizados para marcar extras', '◉'],
  vacant_days: ['Dias com vagas', 'Datas que ainda possuem espaço', '□'],
  available_vacancies: ['Vagas disponíveis', 'Posições abertas para marcação', '+'],
  coverage_percent: ['Escala preenchida', 'Cobertura do mês em operação', '✓']
};

export default function Dashboard() {
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard').then((response) => response.data) });
  const { data: connection } = useQuery({ queryKey: ['whatsapp'], queryFn: () => api.get('/whatsapp/status').then((response) => response.data.item) });
  const sendReminder = useMutation({ mutationFn: () => api.post('/whatsapp/automation/send-reminder') });
  const sendSchedule = useMutation({ mutationFn: () => api.post('/whatsapp/automation/send-schedule') });
  const sendMonthly = useMutation({ mutationFn: () => api.post('/whatsapp/automation/send-monthly') });
  const sendDaily = useMutation({ mutationFn: () => api.post('/whatsapp/automation/send-daily') });
  const connected = connection?.status === 'CONNECTED';
  const mutations = [sendReminder, sendSchedule, sendMonthly, sendDaily];
  const result = mutations.map((mutation) => mutation.data?.data).find(Boolean);
  const sendError = mutations.map((mutation) => mutation.error).find(Boolean);

  return <>
    <header className="page-header"><div><span className="eyebrow">VISÃO GERAL</span><h1>Central da escala</h1><p>{data?.competency ? `Resumo operacional — ${data.competency.name}.` : 'Acompanhe a cobertura e publique mensagens para o grupo.'}</p></div><div className={`connection-badge ${connection?.status?.toLowerCase() || ''}`}><i />{connected ? 'WhatsApp conectado' : 'WhatsApp desconectado'}</div></header>
    <section className="cards">{Object.entries(labels).map(([key, [label, caption, icon]]) => <article className={`card card-${key}`} key={key}><div><span>{label}</span><small>{caption}</small></div><i>{icon}</i><strong>{isLoading ? '—' : `${data?.cards?.[key] ?? 0}${key === 'coverage_percent' ? '%' : ''}`}</strong></article>)}</section>
    <section className="panel dispatch-panel">
      <div className="dispatch-heading"><div><span className="eyebrow">ENVIAR PARA O GRUPO</span><h2>Comandos operacionais</h2><p>Os envios usam o grupo configurado no WhatsApp.</p></div><span className={connected ? 'dispatch-status ready' : 'dispatch-status'}>{connected ? 'Pronto para enviar' : 'Conecte o WhatsApp'}</span></div>
      <div className="dispatch-actions dispatch-actions-four">
        <article><span className="dispatch-icon">01</span><h3>Vagas da vez</h3><p>Reenvia as vagas, menciona quem está na vez e envia o PDF.</p><button className="secondary-button" disabled={!connected || sendReminder.isPending} onClick={() => sendReminder.mutate()}>Enviar vagas agora</button></article>
        <article><span className="dispatch-icon">02</span><h3>Cronograma</h3><p>Publica a Antiguidade com o horário limite de cada militar.</p><button className="secondary-button" disabled={!connected || sendSchedule.isPending} onClick={() => sendSchedule.mutate()}>Enviar cronograma</button></article>
        <article className="featured"><span className="dispatch-icon">03</span><h3>Abrir próximo mês</h3><p>Gera a escala e envia o PDF. A fila é iniciada separadamente com data e coluna.</p><button disabled={!connected || sendMonthly.isPending} onClick={() => sendMonthly.mutate()}>Enviar próximo mês</button></article>
        <article><span className="dispatch-icon">04</span><h3>Escala de amanhã</h3><p>Publica os confirmados e as vagas do próximo dia.</p><button className="secondary-button" disabled={!connected || sendDaily.isPending} onClick={() => sendDaily.mutate()}>Enviar escala de amanhã</button></article>
      </div>
      {result && <p className={result.sent ? 'success' : 'error'}>{result.sent ? 'Mensagem enviada ao grupo.' : result.reason}</p>}
      {sendError && <p className="error">{sendError.response?.data?.message || 'Não foi possível enviar a mensagem.'}</p>}
    </section>
    <section className="dashboard-grid"><article className="notice"><span className="eyebrow">FLUXO DE TRABALHO</span><h2>Preparar, abrir e acompanhar</h2><p>O mês começa com duas posições. Quando a 2ª estiver completa, a 3ª abre automaticamente e inicia uma nova rodada.</p><div className="journey"><span className="done">1</span><hr /><span>2</span><hr /><span>3</span></div><div className="journey-labels"><span>Mês</span><span>Vagas</span><span>Escala</span></div></article><article className="operational-card"><span className="eyebrow">STATUS OPERACIONAL</span><div><strong>{connected ? 'Grupo pronto para operar' : 'Aguardando conexão'}</strong><span className="status-live"><i />{connected ? 'Canal disponível' : 'Abra WhatsApp para conectar'}</span></div><p>Os horários do cronograma são preenchidos em Antiguidade.</p></article></section>
  </>;
}
