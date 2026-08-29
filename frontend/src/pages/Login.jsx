import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';

export default function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api.post('/auth/login', data);
      navigate('/dashboard');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Não foi possível entrar.');
    }
  };

  return <div className="login"><form className="login-panel" onSubmit={submit}><div className="login-panel-head"><span className="admin-mark">ADMIN</span><span className="eyebrow">ACESSO RESTRITO</span><h1>Boas-vindas</h1><p>Use as credenciais configuradas para acessar o painel.</p></div>{error && <div className="error">{error}</div>}<label>E-mail<input name="email" type="email" autoComplete="username" required placeholder="seu-email@unidade.gov.br"/></label><label>Senha<input name="password" type="password" autoComplete="current-password" required placeholder="••••••••••••"/></label><button>Entrar no painel <span>→</span></button></form></div>;
}
