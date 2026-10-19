import dayjs from 'dayjs';
import { db, audit, now } from '../database/index.js';

const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
const readSetting = (key) => db.prepare('SELECT value FROM system_settings WHERE key=?').get(key)?.value ?? '';
const setSetting = (key, value) => db.prepare(`INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), now());

export function monthDeletionImpact(competencyId) {
  const competency = db.prepare('SELECT * FROM competencies WHERE id=?').get(competencyId);
  if (!competency) fail('Mês não encontrado.', 404);
  const totals = db.prepare(`SELECT COUNT(*) assignments,
    COALESCE(SUM(a.service_type='ORDINARY'),0) ordinaryAssignments,
    COALESCE(SUM(a.service_type='EXTRAORDINARY'),0) extraordinaryAssignments
    FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id WHERE s.competency_id=?`).get(competencyId);
  return { competency, ...totals,
    slots: db.prepare('SELECT COUNT(*) total FROM service_slots WHERE competency_id=?').get(competencyId).total,
    activeOnWhatsApp: Number(readSetting('bot_active_competency_id')) === competencyId };
}

export function deleteMonth({ competencyId, userId, req }) {
  return db.transaction(() => {
    const impact = monthDeletionImpact(competencyId);
    const slotFilter = 'SELECT id FROM service_slots WHERE competency_id=?';
    const before = { competency: impact.competency,
      slots: db.prepare('SELECT * FROM service_slots WHERE competency_id=?').all(competencyId),
      assignments: db.prepare(`SELECT * FROM assignments WHERE service_slot_id IN (${slotFilter})`).all(competencyId),
      capacityChanges: db.prepare(`SELECT * FROM capacity_changes WHERE service_slot_id IN (${slotFilter})`).all(competencyId),
      columns: db.prepare('SELECT * FROM schedule_pdf_column_releases WHERE competency_id=?').all(competencyId),
      overrides: db.prepare('SELECT * FROM wing_month_overrides WHERE competency_id=?').all(competencyId),
      passes: db.prepare('SELECT * FROM bot_passes WHERE competency_id=?').all(competencyId),
      settings: [] };
    const changeSetting = (key, value) => {
      before.settings.push({ key, value: readSetting(key) });
      setSetting(key, value);
    };
    db.prepare(`DELETE FROM assignments WHERE service_slot_id IN (${slotFilter})`).run(competencyId);
    db.prepare(`DELETE FROM capacity_changes WHERE service_slot_id IN (${slotFilter})`).run(competencyId);
    for (const table of ['schedule_pdf_column_releases', 'wing_month_overrides', 'bot_passes', 'service_slots']) {
      db.prepare(`DELETE FROM ${table} WHERE competency_id=?`).run(competencyId);
    }
    db.prepare('DELETE FROM competencies WHERE id=?').run(competencyId);
    let activeCompetencyId = null;
    if (impact.activeOnWhatsApp) {
      const calendarMonth = dayjs().year() * 12 + dayjs().month() + 1;
      const fallback = db.prepare(`SELECT id FROM competencies WHERE generated_at IS NOT NULL
        ORDER BY CASE WHEN year*12+month<=? THEN 0 ELSE 1 END,ABS(year*12+month-?) LIMIT 1`).get(calendarMonth, calendarMonth);
      activeCompetencyId = fallback?.id ?? null;
      changeSetting('bot_active_competency_id', activeCompetencyId ?? '');
      changeSetting('bot_active_selection_month', dayjs().format('YYYY-MM'));
      changeSetting('bot_marking_round_starts_at', '');
      changeSetting('automation_last_marking_reminder_at', '');
      before.activeTurns = db.prepare('SELECT * FROM marking_turns WHERE active=1').all();
      db.prepare('UPDATE marking_turns SET active=0,closed_at=? WHERE active=1').run(now());
    }
    const monthKey = `${impact.competency.year}-${String(impact.competency.month).padStart(2, '0')}`;
    if (readSetting('automation_last_monthly_run') === monthKey) changeSetting('automation_last_monthly_run', '');
    for (const row of db.prepare("SELECT key,value FROM system_settings WHERE key LIKE 'bot_pending_month_generation:%'").all()) {
      try { if (JSON.parse(row.value)?.target === monthKey) changeSetting(row.key, ''); } catch { /* Unrelated malformed settings are left alone. */ }
    }
    audit({ userId, action: 'DELETE_MONTH', entityType: 'COMPETENCY', entityId: competencyId,
      before, after: { activeCompetencyId }, reason: 'Exclusão do mês confirmada no gerenciamento da escala', req });
    return { ...impact, activeCompetencyId, message: `${impact.competency.name} excluído. ${impact.assignments} marcação(ões) removida(s).` };
  })();
}
