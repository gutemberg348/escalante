import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

const statusLabel = { DISCONNECTED: 'Desconectado', CONNECTING: 'Conectando', RECONNECTING: 'Reconectando automaticamente', WAITING_QR: 'Aguardando leitura do QR', CONNECTED: 'Conectado', ERROR: 'Erro na conexão' };

export default function WhatsApp() {
  const queryClient = useQueryClient();
  const { data: connection, isLoading } = useQuery({
    queryKey: ['whatsapp'], queryFn: () => api.get('/whatsapp/status').then((response) => response.data.item),
    refetchInterval: (query) => ['CONNECTING', 'RECONNECTING', 'WAITING_QR'].includes(query.state.data?.status) ? 2000 : 5000
  });
  const [settings, setSettings] = useState({ targetNumber: '', groupJids: [] });
  useEffect(() => { if (connection) setSettings({ targetNumber: connection.configuredNumber || '', groupJids: connection.groupJids?.length ? connection.groupJids : (connection.groupJid ? [connection.groupJid] : []) }); }, [connection]);
  const refreshConnection = () => queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
  const save = useMutation({ mutationFn: () => api.put('/whatsapp/settings', settings), onSuccess: refreshConnection });
  const connect = useMutation({ mutationFn: () => api.post('/whatsapp/connect'), onSuccess: refreshConnection });
  const disconnect = useMutation({ mutationFn: () => api.post('/whatsapp/disconnect'), onSuccess: refreshConnection });
  const resetSession = useMutation({ mutationFn: () => api.post('/whatsapp/reset-session'), onSuccess: refreshConnection });
  const groups = useQuery({ queryKey: ['whatsapp-groups'], queryFn: () => api.get('/whatsapp/groups').then((response) => response.data.items), enabled: connection?.status === 'CONNECTED' });
  const set = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const busy = connect.isPending || disconnect.isPending || resetSession.isPending;
  const hasSession = Boolean(connection?.hasSession);
  const waitingQr = connection?.status === 'WAITING_QR';
  const connecting = ['CONNECTING', 'RECONNECTING'].includes(connection?.status);
  const connected = connection?.status === 'CONNECTED';

  return <>
    <header className="page-header"><div><span className="eyebrow">INTEGRAÇÃO</span><h1>WhatsApp</h1><p>Conecte o aparelho, escolha um ou mais grupos e envie as mensagens quando precisar.</p></div><span className={`connection-badge ${connection?.status?.toLowerCase() || ''}`}><i />{isLoading ? 'Consultando...' : statusLabel[connection?.status]}</span></header>
    <section className="whatsapp-grid">
      <article className="panel whatsapp-connect">
        <div><span className="eyebrow">CONEXÃO DO APARELHO</span><h2>{connected ? 'Aparelho conectado' : waitingQr ? 'Leia o QR Code uma única vez' : connecting && hasSession ? 'Reconectando a sessão salva' : hasSession ? 'Sessão vinculada' : 'Conecte pelo QR Code'}</h2><p>{connected ? `Número conectado: ${connection.phoneNumber || 'identificando...'}. A sessão está salva e reconectará automaticamente.` : waitingQr ? 'Depois da leitura, o vínculo fica salvo. Não será necessário gerar outro QR nos próximos reinícios.' : connecting && hasSession ? 'A conexão caiu, mas a autenticação continua salva. O sistema está tentando voltar sozinho.' : hasSession ? 'Este aparelho já está vinculado. A sessão será reutilizada sem gerar outro QR.' : 'Gere o QR Code e leia pelo WhatsApp do aparelho que será usado pelo sistema.'}</p></div>
        {connection?.qrDataUrl ? <div className="qr-area"><img src={connection.qrDataUrl} alt="QR Code para conexão do WhatsApp" /><span>WhatsApp → Dispositivos conectados → Conectar dispositivo</span></div> : <div className="connection-illustration"><span>⌁</span></div>}
        {connection?.error && <p className="connection-error">{connection.error}</p>}
        <div className="connection-actions">
          {!connected && !hasSession && !connecting && <button onClick={() => resetSession.mutate()} disabled={busy}>{resetSession.isPending ? 'Gerando QR...' : waitingQr ? 'Gerar outro QR' : 'Gerar QR Code'} <span>→</span></button>}
          {!connected && hasSession && !connecting && <button onClick={() => connect.mutate()} disabled={busy}>Conectar sessão salva <span>→</span></button>}
          {!connected && hasSession && !connecting && <button className="secondary-button" onClick={() => resetSession.mutate()} disabled={busy}>Trocar aparelho / novo QR</button>}
          {(connected || connecting || waitingQr) && <button className="secondary-button" onClick={() => disconnect.mutate()} disabled={busy}>{connected ? 'Desconectar temporariamente' : 'Cancelar conexão'}</button>}
        </div>
        {(connect.isError || disconnect.isError || resetSession.isError) && <p className="connection-error">Não foi possível alterar a conexão. Tente novamente.</p>}
      </article>
      <article className="panel whatsapp-settings">
        <span className="eyebrow">CONFIGURAÇÃO DE DESTINO</span><h2>Número e grupos</h2><p>O bot recebe comandos e envia avisos em todos os grupos selecionados abaixo.</p>
        <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          <label>Número do WhatsApp<input value={settings.targetNumber} onChange={(event) => set('targetNumber', event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Ex.: 5583999999999" /><small>Somente números, com DDI e DDD.</small></label>
          <label>Grupos de destino<select className="group-multi-select" multiple size="6" value={settings.groupJids} onChange={(event) => set('groupJids', [...event.target.selectedOptions].map((option) => option.value))}>{groups.data?.map((group) => <option key={group.jid} value={group.jid}>{group.name}</option>)}</select><small>Use Ctrl (Windows) ou ⌘ (Mac) para selecionar mais de um grupo.</small></label>
          <button disabled={save.isPending}>Salvar grupos ({settings.groupJids.length})</button>{save.isSuccess && <p className="success">Grupos salvos.</p>}{save.isError && <p className="error">{save.error.response?.data?.message || 'Confira os grupos selecionados.'}</p>}
        </form>
      </article>
    </section>
  </>;
}
