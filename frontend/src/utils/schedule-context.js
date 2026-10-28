export const writtenDate = (value) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
export const serviceTypeLabel = (type) => type === 'ORDINARY' ? 'Ordinário (preto)' : 'Extra (vermelho)';
export const scheduleContext = (month, slot, position) => `${month} · ${writtenDate(slot.service_date)} · ${slot.period === 'DIURNO' ? 'Dia · 07h às 19h' : 'Noite · 19h às 07h'} · ${position}ª coluna`;
