import dayjs from 'dayjs';
import { db, now } from '../database/index.js';
import { buildSchedulePdf } from './schedule-pdf.js';
import {
  advanceExpiredMarkingTurn, getWhatsAppStatus, notifyCurrentMarkingTurn,
  sendMarkingSchedule, sendWhatsAppDocument, sendWhatsAppText
} from './whatsapp.js';
import { ensureCompetencySchedule, generateOrdinaryAssignments } from '../scheduling/monthly.js';

const weekdayNames = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const readSetting = (key) => db.prepare('SELECT value FROM system_settings WHERE key=?').get(key)?.value ?? '';
const writeSetting = (key, value, userId = null) => db.prepare(`INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(key, String(value), userId, now());

export function getAutomationSettings() {
  return {
    dailyEnabled: readSetting('automation_daily_enabled') === '1',
    dailyTime: readSetting('automation_daily_time') || '18:00',
    monthlyEnabled: readSetting('automation_monthly_enabled') === '1',
    monthlyDay: Number(readSetting('automation_monthly_day') || 25),
    monthlyTime: readSetting('automation_monthly_time') || '07:00',
    markingReminderEnabled: readSetting('automation_marking_reminder_enabled') !== '0',
    markingReminderMinutes: Number(readSetting('automation_marking_reminder_minutes') || 60),
    lastMarkingReminderAt: readSetting('automation_last_marking_reminder_at') || null,
    lastDailyRun: readSetting('automation_last_daily_run') || null,
    lastMonthlyRun: readSetting('automation_last_monthly_run') || null,
    lastMonthlyQueueStarted: readSetting('automation_last_monthly_queue_started') || null,
    activeMarkingColumn: Number(readSetting('bot_active_marking_column') || 2)
  };
}

export function saveAutomationSettings(input, userId) {
  const previous = getAutomationSettings();
  const dailyChanged = previous.dailyEnabled !== input.dailyEnabled || previous.dailyTime !== input.dailyTime;
  const monthlyChanged = previous.monthlyEnabled !== input.monthlyEnabled || previous.monthlyDay !== input.monthlyDay || previous.monthlyTime !== input.monthlyTime;
  writeSetting('automation_daily_enabled', input.dailyEnabled ? '1' : '0', userId);
  writeSetting('automation_daily_time', input.dailyTime, userId);
  writeSetting('automation_monthly_enabled', input.monthlyEnabled ? '1' : '0', userId);
  writeSetting('automation_monthly_day', input.monthlyDay, userId);
  writeSetting('automation_monthly_time', input.monthlyTime, userId);
  writeSetting('automation_marking_reminder_enabled', input.markingReminderEnabled ? '1' : '0', userId);
  writeSetting('automation_marking_reminder_minutes', input.markingReminderMinutes, userId);
  if (dailyChanged) writeSetting('automation_last_daily_run', '', userId);
  if (monthlyChanged) writeSetting('automation_last_monthly_run', '', userId);
  return getAutomationSettings();
}

function scheduleRows(competencyId, empty = false) {
  return db.prepare(`SELECT s.*,COUNT(a.id) confirmed_count,
      (SELECT GROUP_CONCAT(name, ' | ') FROM (SELECT m.rank || ' ' || m.operational_name name
       FROM assignments a2 JOIN members m ON m.id=a2.member_id WHERE a2.service_slot_id=s.id
       AND a2.status='CONFIRMED' ORDER BY a2.position_number)) members
    FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
    WHERE s.competency_id=? GROUP BY s.id
    ORDER BY s.service_date,CASE s.period WHEN 'DIURNO' THEN 0 ELSE 1 END`).all(competencyId).map((row) => ({
      ...row,
      confirmed_count: empty ? 0 : Number(row.confirmed_count),
      available_positions: empty ? row.current_capacity : row.current_capacity - Number(row.confirmed_count),
      members: empty || !row.members ? [] : row.members.split(' | ')
    }));
}

function eligibleMembers() {
  return db.prepare(`SELECT m.id,m.seniority_position,d.deadline_at
    FROM members m LEFT JOIN marking_deadlines d ON d.member_id=m.id
    WHERE m.seniority_position IS NOT NULL AND m.active=1 AND m.operational_status='ACTIVE'
      AND m.authorization_status='AUTHORIZED' ORDER BY m.seniority_position`).all();
}

function rebaseDeadlinesForRound(userId) {
  const members = eligibleMembers();
  if (!members.length || members.some((member) => !member.deadline_at)) return false;
  const current = dayjs();
  let previous = null;
  const update = db.prepare('UPDATE marking_deadlines SET deadline_at=?,updated_by=?,updated_at=? WHERE member_id=?');
  db.transaction(() => {
    for (const member of members) {
      const template = dayjs(member.deadline_at);
      let candidate = current.startOf('day').hour(template.hour()).minute(template.minute()).second(0).millisecond(0);
      if (!previous && !candidate.isAfter(current)) candidate = candidate.add(1, 'day');
      while (previous && !candidate.isAfter(previous)) candidate = candidate.add(1, 'day');
      update.run(candidate.toISOString(), userId, now(), member.id);
      previous = candidate;
    }
  })();
  return true;
}

function openPreparedMarkingSequence(competency, administratorId) {
  const members = eligibleMembers();
  if (!administratorId || !members.length || members.some((member) => !member.deadline_at)) return false;
  for (let index = 1; index < members.length; index += 1) {
    if (new Date(members[index].deadline_at) <= new Date(members[index - 1].deadline_at)) return false;
  }
  if (new Date(members[0].deadline_at) <= new Date()) return false;
  const stamp = now();
  db.transaction(() => {
    db.prepare('UPDATE marking_turns SET active=0,closed_at=? WHERE active=1').run(stamp);
    db.prepare('INSERT INTO marking_turns (member_id,deadline_at,active,created_by,created_at) VALUES (?,?,1,?,?)')
      .run(members[0].id, members[0].deadline_at, administratorId, stamp);
  })();
  writeSetting('bot_active_competency_id', competency.id, administratorId);
  return true;
}

export async function startColumnMarkingRound({ competencyId, column, userId = null, reason = 'COLUMN_OPEN' }) {
  if (getWhatsAppStatus().status !== 'CONNECTED') return { started: false, reason: 'WhatsApp desconectado.' };
  const competency = db.prepare('SELECT * FROM competencies WHERE id=?').get(competencyId);
  if (!competency) return { started: false, reason: 'Mês não encontrado.' };
  const administratorId = userId || db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get()?.id;
  if (!administratorId) return { started: false, reason: 'Administrador não encontrado.' };
  if (!rebaseDeadlinesForRound(administratorId)) return { started: false, reason: 'Preencha todos os horários na Antiguidade.' };
  if (!openPreparedMarkingSequence(competency, administratorId)) return { started: false, reason: 'Não foi possível abrir a fila.' };
  writeSetting('bot_active_marking_column', column, administratorId);
  writeSetting('automation_last_marking_reminder_at', '', administratorId);
  const schedule = await sendMarkingSchedule({ competencyId: competency.id, column });
  const reminder = await notifyCurrentMarkingTurn();
  writeSetting(`marking_round_${competency.id}_${column}`, `${reason}:${now()}`, administratorId);
  return { started: true, scheduleSent: schedule.sent, reminderSent: reminder, column };
}

async function startOpenedMonthQueue({ competency, monthKey, administrator }) {
  if (readSetting('automation_last_monthly_queue_started') === monthKey) {
    const activeColumn = Number(readSetting('bot_active_marking_column') || 2);
    await sendMarkingSchedule({ competencyId: competency.id, column: activeColumn });
    return notifyCurrentMarkingTurn();
  }
  const result = await startColumnMarkingRound({ competencyId: competency.id, column: 2, userId: administrator.id, reason: 'MONTH_OPEN' });
  if (result.started) writeSetting('automation_last_monthly_queue_started', monthKey, administrator.id);
  return result.started;
}

async function maybeOpenThirdColumnRound() {
  if (getWhatsAppStatus().status !== 'CONNECTED') return false;
  const competencyId = Number(readSetting('bot_active_competency_id'));
  if (!Number.isInteger(competencyId) || competencyId < 1) return false;
  if (Number(readSetting('bot_active_marking_column') || 2) >= 3) return false;
  const coverage = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN confirmed_count>=2 THEN 1 ELSE 0 END) filled
    FROM (SELECT s.id,COUNT(a.id) confirmed_count FROM service_slots s
      LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
      WHERE s.competency_id=? AND s.status='OPEN' AND s.homologated_at IS NULL GROUP BY s.id)`).get(competencyId);
  if (!coverage.total || Number(coverage.filled) !== Number(coverage.total)) return false;
  const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
  if (!administrator) return false;
  const dates = db.prepare('SELECT DISTINCT service_date FROM service_slots WHERE competency_id=?').all(competencyId);
  const stamp = now();
  db.transaction(() => {
    const save = db.prepare(`INSERT INTO schedule_pdf_column_releases
      (competency_id,service_date,third_column_open,fourth_column_open,updated_by,updated_at)
      VALUES (?,?,1,0,?,?) ON CONFLICT(competency_id,service_date) DO UPDATE SET
      third_column_open=1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
    for (const { service_date: serviceDate } of dates) save.run(competencyId, serviceDate, administrator.id, stamp);
    db.prepare('UPDATE service_slots SET current_capacity=3,updated_at=? WHERE competency_id=?').run(stamp, competencyId);
  })();
  const result = await startColumnMarkingRound({ competencyId, column: 3, userId: administrator.id, reason: 'AUTO_SECOND_COLUMN_FULL' });
  return result.started;
}

function tomorrowScheduleMessage(serviceDate) {
  const slots = db.prepare(`SELECT * FROM service_slots WHERE service_date=?
    ORDER BY CASE period WHEN 'DIURNO' THEN 0 ELSE 1 END`).all(serviceDate);
  if (!slots.length) return `*ESCALA DE AMANHÃ — ${dayjs(serviceDate).format('DD/MM/YYYY')}*\n\nNenhum horário cadastrado.`;
  const sections = slots.map((slot) => {
    const assignments = db.prepare(`SELECT a.position_number,m.rank,m.operational_name
      FROM assignments a JOIN members m ON m.id=a.member_id
      WHERE a.service_slot_id=? AND a.status='CONFIRMED' ORDER BY a.position_number`).all(slot.id);
    const names = new Map(assignments.map((assignment) => [assignment.position_number, `${assignment.rank} ${assignment.operational_name}`]));
    const lines = Array.from({ length: slot.current_capacity }, (_, index) => `${index + 1}. ${names.get(index + 1) ?? 'VAGA'}`);
    const period = slot.period === 'DIURNO' ? 'DIA — 07h às 19h' : 'NOITE — 19h às 07h';
    return `*${period}*\n${lines.join('\n')}`;
  });
  const date = dayjs(serviceDate);
  return `*ESCALA DE AMANHÃ — ${date.format('DD/MM/YYYY')}*\n${weekdayNames[date.day()].toUpperCase()}\n\n${sections.join('\n\n')}`;
}

export async function sendDailySchedule({ force = false } = {}) {
  if (getWhatsAppStatus().status !== 'CONNECTED') return { sent: false, reason: 'WhatsApp desconectado.' };
  const todayKey = dayjs().format('YYYY-MM-DD');
  if (!force && readSetting('automation_last_daily_run') === todayKey) return { sent: false, reason: 'A escala de amanhã já foi enviada hoje.' };
  const tomorrow = dayjs().add(1, 'day');
  const { competency } = ensureCompetencySchedule(tomorrow);
  generateOrdinaryAssignments({ competencyId: competency.id, reason: 'Preparação automática da escala diária' });
  await sendWhatsAppText(tomorrowScheduleMessage(tomorrow.format('YYYY-MM-DD')));
  writeSetting('automation_last_daily_run', todayKey);
  return { sent: true };
}

export async function sendMonthlyOpening({ force = false } = {}) {
  if (getWhatsAppStatus().status !== 'CONNECTED') return { sent: false, reason: 'WhatsApp desconectado.' };
  const nextMonth = dayjs().add(1, 'month').startOf('month');
  const monthKey = nextMonth.format('YYYY-MM');
  if (!force && readSetting('automation_last_monthly_run') === monthKey) return { sent: false, reason: 'A abertura do próximo mês já foi enviada.' };
  const firstOpening = readSetting('automation_last_monthly_run') !== monthKey;
  const { competency } = ensureCompetencySchedule(nextMonth);
  const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
  if (administrator && firstOpening) {
    const stamp = now();
    db.transaction(() => {
      db.prepare('DELETE FROM schedule_pdf_column_releases WHERE competency_id=?').run(competency.id);
      db.prepare('UPDATE service_slots SET minimum_required=2,normal_capacity=2,current_capacity=2,updated_at=? WHERE competency_id=?').run(stamp, competency.id);
    })();
    writeSetting('bot_active_competency_id', competency.id, administrator.id);
    writeSetting('bot_active_marking_column', 2, administrator.id);
  }
  const generation = generateOrdinaryAssignments({
    competencyId: competency.id,
    userId: administrator?.id ?? null,
    reason: 'Geração e publicação do próximo mês no WhatsApp'
  });
  const pdf = await buildSchedulePdf({ competency, slots: scheduleRows(competency.id) });
  await sendWhatsAppDocument({
    buffer: pdf,
    fileName: `escala-${monthKey}.pdf`,
    caption: `*ESCALA — ${competency.name.toUpperCase()}*\n\nServiços ordinários em preto; vagas restantes serão preenchidas como extras.`
  });
  const started = administrator ? await startOpenedMonthQueue({ competency, monthKey, administrator }) : false;
  writeSetting('automation_last_monthly_run', monthKey);
  return { sent: true, sequenceStarted: started, competency, generation };
}

export async function sendMarkingReminder({ force = false } = {}) {
  const settings = getAutomationSettings();
  if (!settings.markingReminderEnabled) return { sent: false, reason: 'Lembrete de vagas desativado.' };
  if (getWhatsAppStatus().status !== 'CONNECTED') return { sent: false, reason: 'WhatsApp desconectado.' };
  if (!db.prepare('SELECT id FROM marking_turns WHERE active=1 LIMIT 1').get()) return { sent: false, reason: 'Não há uma vez de marcação aberta.' };
  if (!force && settings.lastMarkingReminderAt && dayjs().diff(dayjs(settings.lastMarkingReminderAt), 'minute', true) < settings.markingReminderMinutes) {
    return { sent: false, reason: 'O próximo lembrete ainda não está no horário.' };
  }
  return { sent: await notifyCurrentMarkingTurn() };
}

let automationRunning = false;
async function automationTick() {
  if (automationRunning) return;
  automationRunning = true;
  try {
    const settings = getAutomationSettings();
    await advanceExpiredMarkingTurn();
    const current = dayjs(); const currentTime = current.format('HH:mm');
    if (settings.dailyEnabled && currentTime >= settings.dailyTime && settings.lastDailyRun !== current.format('YYYY-MM-DD')) await sendDailySchedule();
    const scheduledDay = Math.min(settings.monthlyDay, current.daysInMonth());
    const monthlyDue = current.date() > scheduledDay || (current.date() === scheduledDay && currentTime >= settings.monthlyTime);
    const nextMonthKey = current.add(1, 'month').format('YYYY-MM');
    if (settings.monthlyEnabled && monthlyDue) {
      if (settings.lastMonthlyRun !== nextMonthKey) await sendMonthlyOpening();
      else if (settings.lastMonthlyQueueStarted !== nextMonthKey && getWhatsAppStatus().status === 'CONNECTED') {
        const { competency } = ensureCompetencySchedule(current.add(1, 'month').startOf('month'));
        const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
        generateOrdinaryAssignments({ competencyId: competency.id, userId: administrator?.id ?? null, reason: 'Retomada automática do próximo mês' });
        if (administrator) await startOpenedMonthQueue({ competency, monthKey: nextMonthKey, administrator });
      }
    }
    await maybeOpenThirdColumnRound();
    await sendMarkingReminder();
  } finally {
    automationRunning = false;
  }
}

let automationTimer = null;
export function refreshWhatsAppAutomation() { return automationTick(); }
export function startWhatsAppAutomation() {
  if (automationTimer) return;
  const run = () => refreshWhatsAppAutomation().catch((error) => console.error('Falha na automação do WhatsApp:', error));
  run();
  automationTimer = setInterval(run, 60_000);
  automationTimer.unref?.();
}
