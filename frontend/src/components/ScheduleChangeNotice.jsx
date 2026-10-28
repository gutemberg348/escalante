import { writtenDate } from '../utils/schedule-context.js';

export default function ScheduleChangeNotice({ month, slot, position, children }) {
  return <div className="schedule-change-notice" role="note">
    <span>CONFIRA ANTES DE CONFIRMAR</span>
    <strong>Escala de {month}</strong>
    {slot && <p>{writtenDate(slot.service_date)} · {slot.period === 'DIURNO' ? 'Dia · 07h às 19h' : 'Noite · 19h às 07h'} · {position}ª coluna</p>}
    {children}
  </div>;
}
