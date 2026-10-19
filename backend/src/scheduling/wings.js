import dayjs from 'dayjs';
import { db, now, audit } from '../database/index.js';

export const wingNumbers = [1, 2, 3, 4, 5];
export const monthStart = (competency) => `${competency.year}-${String(competency.month).padStart(2, '0')}-01`;
const mod = (number) => ((number % 5) + 5) % 5;
export const fiveWings = () => db.prepare("SELECT * FROM wings WHERE code IN ('ALA-1','ALA-2','ALA-3','ALA-4','ALA-5') ORDER BY code")
  .all().map((wing) => ({ ...wing, number: Number(wing.code.slice(-1)) }));

export function cycleRuleForMonth(start) {
  return db.prepare('SELECT * FROM wing_cycle_rules WHERE effective_month<=? ORDER BY effective_month LIMIT 1').get(start) ?? null;
}

export function wingDays(competency, number, rule = cycleRuleForMonth(monthStart(competency))) {
  const start = dayjs(monthStart(competency));
  if (!rule) return [];
  return Array.from({ length: start.daysInMonth() }, (_, index) => start.add(index, 'day').format('YYYY-MM-DD'))
    .filter((date) => mod(dayjs(date).diff(dayjs(rule.reference_date), 'day')) + 1 === number);
}

export function membershipsForMonth(competency) {
  const start = monthStart(competency);
  const rows = db.prepare(`SELECT r.*,w.code FROM wing_memberships r JOIN wings w ON w.id=r.wing_id
    WHERE r.effective_month<=? AND NOT EXISTS (SELECT 1 FROM wing_memberships newer
      WHERE newer.member_id=r.member_id AND newer.effective_month<=? AND newer.effective_month>r.effective_month)`)
    .all(start, start);
  const result = new Map(rows.map((row) => [row.member_id, { ...row, temporary: false }]));
  for (const row of db.prepare(`SELECT o.*,w.code FROM wing_month_overrides o JOIN wings w ON w.id=o.wing_id
      WHERE o.competency_id=? ORDER BY o.from_date`).all(competency.id)) result.set(row.member_id, { ...row, temporary: true, baseline: result.get(row.member_id) });
  return [...result.values()];
}

export function wingAnchorsForMonth(competency) {
  const rule = cycleRuleForMonth(monthStart(competency));
  if (!rule) return [];
  const toAnchors = (row, untilDate = null) => {
    const days = wingDays(competency, Number(row.code.slice(-1)), rule);
    const anchor = { member_id: row.member_id, position_number: row.position_number,
      last_service_date: dayjs(days[0]).subtract(5, 'day').format('YYYY-MM-DD'), wing_id: row.wing_id,
      from_date: row.temporary ? row.from_date : null, until_date: untilDate };
    if (!row.temporary || !row.baseline || row.from_date <= monthStart(competency)) return [anchor];
    return [...toAnchors(row.baseline, dayjs(row.from_date).subtract(1, 'day').format('YYYY-MM-DD')), anchor];
  };
  return membershipsForMonth(competency).flatMap((row) => toAnchors(row));
}

export function previewWingImport(competency) {
  const start = monthStart(competency);
  const assignments = db.prepare(`SELECT a.member_id,a.position_number,s.service_date FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id WHERE s.competency_id=? AND a.status='CONFIRMED'
      AND a.service_type='ORDINARY' ORDER BY s.service_date,a.position_number`).all(competency.id);
  const wings = fiveWings();
  const members = db.prepare('SELECT * FROM members ORDER BY COALESCE(seniority_position,99999),rank,operational_name').all();
  const entries = [];
  const unresolved = [];
  for (const member of members) {
    const duties = assignments.filter((row) => row.member_id === member.id);
    const rotations = duties.length ? [] : db.prepare('SELECT position_number,anchor_date AS service_date FROM ordinary_rotations WHERE member_id=? AND active=1').all(member.id);
    const samples = duties.length ? duties : rotations;
    if (!samples.length) continue;
    const patterns = [...new Set(samples.map((row) => `${mod(dayjs(row.service_date).diff(dayjs(start), 'day')) + 1}:${row.position_number}`))];
    const name = `${member.rank} ${member.operational_name}`;
    if (patterns.length !== 1 || ![1, 2].includes(samples[0].position_number)) {
      unresolved.push({ memberId: member.id, name, reason: 'Serviços em mais de uma ala ou posição. Confira manualmente.' });
      continue;
    }
    const [number, position] = patterns[0].split(':').map(Number);
    entries.push({ memberId: member.id, name, wingId: wings.find((wing) => wing.number === number).id,
      positionNumber: position, source: duties.length ? 'ESCALA' : 'CICLO_ANTERIOR' });
  }
  return { entries, unresolved };
}

export function saveWingRoster({ competency, entries, mode = 'CONTINUOUS', userId }) {
  if (mode !== 'CONTINUOUS') throw Object.assign(new Error('As alas seguem somente o ciclo 1x4 contínuo, sem reiniciar no dia 1.'), { status: 400 });
  const start = monthStart(competency);
  const stamp = now();
  const before = membershipsForMonth(competency);
  if (db.prepare('SELECT 1 FROM wing_cycle_rules LIMIT 1').get()) throw Object.assign(new Error('As alas já foram cadastradas. Use a troca de ala para ajustar os militares.'), { status: 409 });
  const effectiveMonth = dayjs(start).add(1, 'month').format('YYYY-MM-DD');
  // Keep the observed current roster as the baseline; edited memberships start
  // next month. Applying them sooner uses a separate dated override.
  const selectedIds = new Set(entries.map((entry) => entry.memberId));
  const baseline = previewWingImport(competency).entries.filter((entry) => selectedIds.has(entry.memberId));
  const save = db.prepare(`INSERT INTO wing_memberships (member_id,wing_id,position_number,effective_month,updated_by,updated_at) VALUES (?,?,?,?,?,?)`);
  db.prepare('INSERT INTO wing_cycle_rules (effective_month,reference_date,mode,updated_by,updated_at) VALUES (?,?,?,?,?)')
    .run(start, start, mode, userId, stamp);
  for (const entry of baseline) save.run(entry.memberId, entry.wingId, entry.positionNumber, start, userId, stamp);
  for (const entry of entries) {
    save.run(entry.memberId, entry.wingId, entry.positionNumber, effectiveMonth, userId, stamp);
    db.prepare('UPDATE members SET default_wing_id=?,updated_at=? WHERE id=?').run(entry.wingId, stamp, entry.memberId);
  }
  audit({ userId, action: 'IMPORT_WING_ROSTER', entityType: 'COMPETENCY', entityId: competency.id,
    before, after: { entries, baseline, mode, effectiveMonth }, reason: 'Cadastro das alas programado a partir do próximo mês' });
}
