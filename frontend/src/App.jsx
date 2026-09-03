import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Members from './pages/Members.jsx';
import Seniority from './pages/Seniority.jsx';
import Competencies from './pages/Competencies.jsx';
import ServiceSlots from './pages/ServiceSlots.jsx';
import ScheduleManagement from './pages/ScheduleManagement.jsx';
import WhatsApp from './pages/WhatsApp.jsx';
import Settings from './pages/Settings.jsx';

const links = [
  ['/dashboard', 'Visão geral', 'overview'],
  ['/efetivo', 'Efetivo', 'members'],
  ['/antiguidade', 'Antiguidade', 'seniority'],
  ['/horarios', 'Gestão do mês', 'calendar'],
  ['/gerenciar-escala', 'Gerenciar escala', 'schedule'],
  ['/whatsapp', 'WhatsApp', 'whatsapp'],
  ['/configuracoes', 'Configurações', 'settings']
];

function NavigationIcon({ name }) {
  const paths = {
    overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.4" /></>,
    members: <><circle cx="12" cy="8" r="3.25" /><path d="M5.5 20c.55-3.2 2.72-5 6.5-5s5.95 1.8 6.5 5" /><path d="M4.1 10.2a2.8 2.8 0 0 0 1.46.43M19.9 10.2a2.8 2.8 0 0 1-1.46.43" /></>,
    seniority: <><path d="M12 4v16M8.5 7.5 12 4l3.5 3.5M15.5 16.5 12 20l-3.5-3.5" /><path d="M5 7h2M17 17h2" /></>,
    calendar: <><rect x="3.5" y="5.2" width="17" height="15.2" rx="2" /><path d="M7.5 3.5v3.4M16.5 3.5v3.4M3.5 10h17M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" /></>,
    schedule: <><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M8 3.5v3M16 3.5v3M7.5 10h9M7.5 14h9M7.5 17h5" /></>,
    whatsapp: <><path d="M19.8 11.7a7.75 7.75 0 0 1-11.43 6.84L4 19.8l1.28-4.13a7.75 7.75 0 1 1 14.52-3.97Z" /><path d="M9 8.3c.2-.46.42-.47.63-.47h.3c.18 0 .38.03.5.3l.72 1.72c.1.25.04.44-.05.58l-.32.38c-.1.11-.2.23-.08.43.12.2.54.88 1.16 1.42.8.7 1.47.92 1.68 1.03.2.1.32.08.44-.05l.55-.64c.14-.17.29-.14.49-.07l1.56.73c.25.11.4.17.46.27.06.1.06.57-.13 1.1-.18.53-1.04 1.02-1.44 1.08-.37.06-.85.09-1.38-.08a12.55 12.55 0 0 1-1.2-.44 9.73 9.73 0 0 1-3.74-3.3c-.24-.33-.95-1.27-.95-2.43 0-1.16.61-1.73.82-1.97Z" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.35 14.85.08.06-.03.1-1.18 2.04-.1.03-1.32-.54a7.7 7.7 0 0 1-1.6.93l-.2 1.4-.08.08h-2.35l-.08-.08-.2-1.4a7.7 7.7 0 0 1-1.6-.93l-1.32.54-.1-.03-1.18-2.04-.03-.1.08-.06 1.12-.86a7.43 7.43 0 0 1 0-1.86l-1.12-.86-.08-.06.03-.1L9.3 8.1l.1-.03 1.32.54a7.7 7.7 0 0 1 1.6-.93l.2-1.4.08-.08h2.35l.08.08.2 1.4a7.7 7.7 0 0 1 1.6.93l1.32-.54.1.03 1.18 2.04.03.1-.08.06-1.12.86c.1.61.1 1.25 0 1.86l1.12.86Z" /></>
  };

  return <svg className="navigation-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Layout() {
  const navigate = useNavigate();
  const session = useQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me').then((response) => response.data.user), retry: false });
  if (session.isLoading) return <div className="centered">Carregando...</div>;
  if (session.isError) return <Navigate to="/login" replace />;
  const logout = async () => { await api.post('/auth/logout'); navigate('/login'); };

  return <div className="shell"><aside>
    <div className="brand"><span className="brand-mark">C</span><span className="brand-name">ESCALA</span></div>
    <div className="nav-label">OPERAÇÃO</div>
    <nav>{links.map(([to, label, icon]) => <NavLink key={to} to={to}><span className="nav-icon"><NavigationIcon name={icon} /></span>{label}</NavLink>)}</nav>
    <div className="sidebar-foot"><div className="environment"><span />Ambiente de simulação</div><div className="user"><div className="avatar">{session.data.name.slice(0, 1)}</div><div><strong>{session.data.name}</strong><span>{session.data.role.replaceAll('_', ' ')}</span></div><button className="link" title="Sair" onClick={logout}>↗</button></div></div>
  </aside><main><div className="topbar"><div><span className="eyebrow">CICC / GESTÃO DE ESCALA</span><strong>Central de operação</strong></div><div className="topbar-status"><span />Sistema operacional</div></div>
    <div className="page-content"><Routes>
      <Route path="/dashboard" element={<Dashboard />} /><Route path="/efetivo" element={<Members />} /><Route path="/antiguidade" element={<Seniority />} /><Route path="/competencias" element={<Competencies />} /><Route path="/horarios" element={<ServiceSlots />} /><Route path="/gerenciar-escala" element={<ScheduleManagement />} /><Route path="/whatsapp" element={<WhatsApp />} /><Route path="/configuracoes" element={<Settings />} /><Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes></div>
  </main></div>;
}

export default function App() {
  return <Routes><Route path="/login" element={<Login />} /><Route path="/*" element={<Layout />} /></Routes>;
}
