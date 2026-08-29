import dayjs from 'dayjs';
import { db, now } from './index.js';

const requestedYear = Number(process.argv[2] ?? new Date().getFullYear());
if (!Number.isInteger(requestedYear) || requestedYear < 2020 || requestedYear > 2100) {
  throw new Error('Informe um ano válido. Exemplo: npm run seed:schedule -- 2026');
}

const monthNames = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const upsertSetting = db.prepare(`
  INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);
const insertCompetency = db.prepare(`
  INSERT OR IGNORE INTO competencies
    (year,month,name,status,standard_hour_limit,current_hour_limit,created_at,updated_at)
  VALUES (?,?,?,'CONFIGURING',192,192,?,?)
`);
const getCompetency = db.prepare('SELECT id FROM competencies WHERE year=? AND month=?');
const insertSlot = db.prepare(`
  INSERT OR IGNORE INTO service_slots
    (competency_id,service_date,period,starts_at,ends_at,minimum_required,normal_capacity,current_capacity,
     service_classification,is_majorado,status,homologation_deadline,created_at,updated_at)
  VALUES (?,?,?,?,?,2,2,2,'EXTRAORDINARY',0,'OPEN',?,?,?)
`);

let createdCompetencies = 0;
let createdSlots = 0;

db.transaction(() => {
  const stamp = now();
  const settings = {
    default_day_start: '07:00',
    default_day_end: '19:00',
    default_night_start: '19:00',
    default_night_end: '07:00',
    default_minimum_required: '2',
    default_normal_capacity: '2'
  };
  for (const [key, value] of Object.entries(settings)) upsertSetting.run(key, value, stamp);

  for (let month = 1; month <= 12; month += 1) {
    const name = `${monthNames[month - 1]} de ${requestedYear}`;
    createdCompetencies += insertCompetency.run(requestedYear, month, name, stamp, stamp).changes;
    const competencyId = getCompetency.get(requestedYear, month).id;
    const daysInMonth = dayjs(`${requestedYear}-${String(month).padStart(2, '0')}-01`).daysInMonth();

    for (let day = 1; day <= daysInMonth; day += 1) {
      const serviceDate = `${requestedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayStart = `${serviceDate}T07:00:00`;
      const dayEnd = `${serviceDate}T19:00:00`;
      const nightStart = `${serviceDate}T19:00:00`;
      const nightEnd = `${dayjs(serviceDate).add(1, 'day').format('YYYY-MM-DD')}T07:00:00`;
      const deadline = dayjs(dayStart).subtract(1, 'day').toISOString();

      createdSlots += insertSlot.run(competencyId, serviceDate, 'DIURNO', dayStart, dayEnd, deadline, stamp, stamp).changes;
      createdSlots += insertSlot.run(competencyId, serviceDate, 'NOTURNO', nightStart, nightEnd, deadline, stamp, stamp).changes;
    }
  }
})();

const totals = db.prepare(`
  SELECT COUNT(*) AS slots,
    SUM(CASE WHEN period='DIURNO' THEN 1 ELSE 0 END) AS daytime,
    SUM(CASE WHEN period='NOTURNO' THEN 1 ELSE 0 END) AS nighttime
  FROM service_slots s
  JOIN competencies c ON c.id=s.competency_id
  WHERE c.year=?
`).get(requestedYear);

console.log(JSON.stringify({
  year: requestedYear,
  createdCompetencies,
  createdSlots,
  totalSlots: totals.slots,
  daytimeSlots: totals.daytime,
  nighttimeSlots: totals.nighttime
}, null, 2));
