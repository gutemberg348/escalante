import { Router } from 'express';
import dayjs from 'dayjs';
import { z } from 'zod';
import { db, audit, now } from '../../database/index.js';
import { allow } from '../../middlewares/auth.js';
import { isMajoradoDate } from '../../scheduling/majorado.js';
import { generateNextMonthSchedule, generateOrdinaryAssignments, regenerateOrdinaryAssignments } from '../../scheduling/monthly.js';

const router = Router();
const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const slotsCountSql = `SELECT c.*,COUNT(s.id) AS slots_count FROM competencies c LEFT JOIN service_slots s ON s.competency_id=c.id GROUP BY c.id`;

const generationDetails = (generation) => ({
  competencyCreated: Boolean(generation.competencyCreated),
  anchors: generation.anchors,
  dutyDays: generation.dutyDays,
  assignmentsCreated: generation.assignmentsCreated,
  assignmentsReclassified: generation.assignmentsReclassified,
  assignmentsRemoved: generation.assignmentsRemoved || 0,
  ordinaryDutyDays: generation.ordinaryDutyDays,
  ordinaryShifts: generation.ordinaryShifts,
  skippedMembers: generation.skippedMembers,
  unavailableDays: generation.unavailableDays,
  conflictDays: generation.conflictDays
});

function prepareMonth(competency) {
  const stamp = now();
  const insert = db.prepare(`INSERT OR IGNORE INTO service_slots (competency_id,service_date,period,starts_at,ends_at,minimum_required,normal_capacity,current_capacity,service_classification,is_majorado,status,homologation_deadline,created_at,updated_at)
    VALUES (?,?,?,?,?,2,2,2,'EXTRAORDINARY',?,'OPEN',?,?,?)`);
  const updateMajorado = db.prepare('UPDATE service_slots SET is_majorado=?,updated_at=? WHERE competency_id=? AND service_date=?');
  db.transaction(() => {
    for (let day = 1; day <= dayjs(`${competency.year}-${String(competency.month).padStart(2, '0')}-01`).daysInMonth(); day += 1) {
      const serviceDate = `${competency.year}-${String(competency.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const nextDate = dayjs(serviceDate).add(1, 'day').format('YYYY-MM-DD');
      const deadline = dayjs(`${serviceDate}T07:00:00`).subtract(1, 'day').toISOString();
      const majorado = Number(isMajoradoDate(serviceDate));
      insert.run(competency.id, serviceDate, 'DIURNO', `${serviceDate}T07:00:00`, `${serviceDate}T19:00:00`, majorado, deadline, stamp, stamp);
      insert.run(competency.id, serviceDate, 'NOTURNO', `${serviceDate}T19:00:00`, `${nextDate}T07:00:00`, majorado, deadline, stamp, stamp);
      updateMajorado.run(majorado, stamp, competency.id, serviceDate);
    }
  })();
}

router.get('/', (req, res) => res.json({ items: db.prepare(`${slotsCountSql} ORDER BY c.year DESC,c.month DESC`).all().map((item) => ({ ...item, slots_count: Number(item.slots_count) })) }));
router.post('/generate-next', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const generation = generateNextMonthSchedule({ userId: req.user.id, reason: 'Geração manual pelo painel' });
    const item = db.prepare(`${slotsCountSql} HAVING c.id=?`).get(generation.competency.id);
    res.status(generation.competencyCreated ? 201 : 200).json({
      item: { ...item, slots_count: Number(item.slots_count) },
      generation: generationDetails(generation)
    });
  } catch (error) { next(error); }
});
router.get('/:id/regeneration-impact', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const competencyId = z.coerce.number().int().positive().parse(req.params.id);
    const competency = db.prepare('SELECT id,name FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(competencyId);
    if (!competency) return res.status(404).json({ message: 'Mês gerado não encontrado.' });
    const impact = db.prepare(`SELECT
        COUNT(CASE WHEN a.service_type='ORDINARY' THEN 1 END) AS ordinary_assignments,
        COUNT(DISTINCT CASE WHEN a.service_type='ORDINARY' THEN s.service_date || ':' || a.member_id END) AS ordinary_duty_days,
        COUNT(CASE WHEN a.service_type='EXTRAORDINARY' THEN 1 END) AS extraordinary_assignments
      FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
      WHERE s.competency_id=?`).get(competencyId);
    res.json({ item: {
      competency,
      ordinaryAssignments: Number(impact.ordinary_assignments || 0),
      ordinaryDutyDays: Number(impact.ordinary_duty_days || 0),
      extraordinaryAssignments: Number(impact.extraordinary_assignments || 0)
    } });
  } catch (error) { next(error); }
});
router.post('/:id/regenerate', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const competencyId = z.coerce.number().int().positive().parse(req.params.id);
    z.object({ confirmOrdinaryReset: z.literal(true) }).parse(req.body);
    const competency = db.prepare('SELECT * FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(competencyId);
    if (!competency) return res.status(404).json({ message: 'Mês gerado não encontrado.' });
    prepareMonth(competency);
    const generation = regenerateOrdinaryAssignments({ competencyId, userId: req.user.id, reason: 'Regeneração manual pelo painel' });
    const item = db.prepare(`${slotsCountSql} HAVING c.id=?`).get(competencyId);
    res.json({ item: { ...item, slots_count: Number(item.slots_count) }, generation: generationDetails(generation) });
  } catch (error) { next(error); }
});
router.get('/:id', (req, res) => { const item = db.prepare(`${slotsCountSql} HAVING c.id=?`).get(req.params.id); return item ? res.json({ item }) : res.status(404).json({ message: 'Mês não encontrado.' }); });
router.post('/', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const { year, month } = z.object({ year: z.number().int().min(2020), month: z.number().int().min(1).max(12) }).parse(req.body);
    const stamp = now();
    const existing = db.prepare('SELECT * FROM competencies WHERE year=? AND month=?').get(year, month);
    if (existing) return res.status(409).json({ message: 'Este mês já está preparado. Use Horários para ajustar os dias.' });
    const result = db.prepare(`INSERT INTO competencies (year,month,name,standard_hour_limit,current_hour_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(year, month, `${monthNames[month - 1]} de ${year}`, 192, 192, stamp, stamp);
    const competency = db.prepare('SELECT * FROM competencies WHERE id=?').get(result.lastInsertRowid);
    prepareMonth(competency);
    generateOrdinaryAssignments({ competencyId: competency.id, userId: req.user.id, reason: 'Criação manual da competência' });
    const item = db.prepare(`${slotsCountSql} HAVING c.id=?`).get(competency.id);
    audit({ userId: req.user.id, action: 'PREPARE_MONTH', entityType: 'COMPETENCY', entityId: item.id, after: item, req });
    res.status(201).json({ item: { ...item, slots_count: Number(item.slots_count) } });
  } catch (error) { next(error); }
});
router.post('/:id/prepare', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const competency = db.prepare('SELECT * FROM competencies WHERE id=?').get(req.params.id);
    if (!competency) return res.status(404).json({ message: 'Mês não encontrado.' });
    prepareMonth(competency);
    generateOrdinaryAssignments({ competencyId: competency.id, userId: req.user.id, reason: 'Complementação manual da competência' });
    const item = db.prepare(`${slotsCountSql} HAVING c.id=?`).get(competency.id);
    res.json({ item: { ...item, slots_count: Number(item.slots_count) } });
  } catch (error) { next(error); }
});
export default router;
