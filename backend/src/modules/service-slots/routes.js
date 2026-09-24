import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { z } from 'zod';
import { db, audit, now } from '../../database/index.js';
import { allow } from '../../middlewares/auth.js';
import { buildSchedulePdf } from '../../messaging/schedule-pdf.js';

const router = Router();
const slotSchema = z.object({
  competency_id: z.number().int().positive(), service_date: z.string().date(),
  period: z.enum(['DIURNO', 'NOTURNO']), minimum_required: z.literal(2).default(2),
  current_capacity: z.number().int().min(2).max(4).default(2)
});
const listSql = `SELECT s.*,c.name competency_name,COUNT(CASE WHEN a.status='CONFIRMED' THEN 1 END) confirmed_count
  FROM service_slots s JOIN competencies c ON c.id=s.competency_id
  LEFT JOIN assignments a ON a.service_slot_id=s.id GROUP BY s.id`;
const presentation = (row) => ({ ...row, confirmed_count: Number(row.confirmed_count), available_positions: row.current_capacity - Number(row.confirmed_count) });

function manualSlot(slotId) {
  const slot = db.prepare('SELECT * FROM service_slots WHERE id=?').get(slotId);
  if (!slot) throw new Error('Horário não encontrado.');
  if (slot.status !== 'OPEN' || slot.homologated_at) throw new Error('Não é possível alterar um horário fechado ou homologado.');
  return slot;
}

function eligibleMember(memberId) {
  const member = db.prepare(`SELECT * FROM members WHERE id=? AND active=1
    AND operational_status IN ('ACTIVE','VACATION') AND authorization_status='AUTHORIZED'`).get(memberId);
  if (!member) throw new Error('Selecione um militar autorizado e apto para serviços extras.');
  return member;
}

function scheduleRows(competencyId) {
  return db.prepare(`SELECT s.id,s.service_date,s.period,s.is_majorado,s.current_capacity,s.status,s.homologated_at,s.homologation_deadline,
      COUNT(a.id) AS confirmed_count,
      (SELECT GROUP_CONCAT(name, ' | ') FROM (SELECT m2.rank || ' ' || m2.operational_name || COALESCE(' (' || NULLIF(TRIM(a2.display_prefix),'') || ')', '') AS name
        FROM assignments a2 JOIN members m2 ON m2.id=a2.member_id
        WHERE a2.service_slot_id=s.id AND a2.status='CONFIRMED' ORDER BY a2.position_number)) AS members
    FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
    WHERE s.competency_id=? GROUP BY s.id ORDER BY s.service_date,
      CASE s.period WHEN 'DIURNO' THEN 0 ELSE 1 END`).all(competencyId).map((row) => ({
    ...row,
    confirmed_count: Number(row.confirmed_count),
    available_positions: row.current_capacity - Number(row.confirmed_count),
    members: row.members ? row.members.split(' | ') : []
  }));
}

function createSlot(input, userId, req) {
  const startsAt = `${input.service_date}T${input.period === 'DIURNO' ? '07:00:00' : '19:00:00'}`;
  const endsAt = dayjs(startsAt).add(12, 'hour').toISOString();
  const stamp = now();
  const result = db.prepare(`INSERT INTO service_slots
    (competency_id,service_date,period,starts_at,ends_at,minimum_required,normal_capacity,current_capacity,homologation_deadline,created_at,updated_at)
    VALUES (?,?,?,?,?,2,2,?,?,?,?)`).run(
    input.competency_id, input.service_date, input.period, startsAt, endsAt, input.current_capacity,
    dayjs(startsAt).subtract(1, 'day').toISOString(), stamp, stamp
  );
  const item = db.prepare('SELECT * FROM service_slots WHERE id=?').get(result.lastInsertRowid);
  audit({ userId, action: 'CREATE', entityType: 'SERVICE_SLOT', entityId: item.id, after: item, req });
  return item;
}

router.get('/', (req, res) => {
  let sql = listSql; const filters = []; const args = [];
  for (const key of ['competency_id', 'service_date', 'period', 'status']) {
    if (req.query[key]) { filters.push(`s.${key}=?`); args.push(req.query[key]); }
  }
  if (filters.length) sql += ` HAVING ${filters.join(' AND ')}`;
  sql += ' ORDER BY s.service_date,s.period';
  res.json({ items: db.prepare(sql).all(...args).map(presentation) });
});

router.get('/confirmations', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const input = z.object({ competency_id: z.coerce.number().int().positive(), service_date: z.string().date() }).parse(req.query);
    const items = db.prepare(`SELECT a.id assignment_id,a.position_number,a.display_prefix,s.period,s.starts_at,s.ends_at,m.rank,m.operational_name
      FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id JOIN members m ON m.id=a.member_id
      WHERE s.competency_id=? AND s.service_date=? AND a.status='CONFIRMED'
      ORDER BY CASE s.period WHEN 'DIURNO' THEN 0 ELSE 1 END,a.position_number`).all(input.competency_id, input.service_date)
      .map((item) => ({ assignmentId: item.assignment_id, positionNumber: item.position_number, displayPrefix: item.display_prefix, period: item.period, startsAt: item.starts_at, endsAt: item.ends_at, rank: item.rank, operationalName: item.operational_name }));
    res.json({ items });
  } catch (error) { next(error); }
});

router.get('/available', (req, res) => res.json({
  items: db.prepare(`${listSql} HAVING s.status='OPEN' AND s.homologated_at IS NULL AND confirmed_count<s.current_capacity ORDER BY s.service_date,s.period`).all().map(presentation)
}));

router.get('/manage', (req, res, next) => {
  try {
    const competencyId = z.coerce.number().int().positive().parse(req.query.competency_id);
    const competency = db.prepare('SELECT id,name,year,month,status,generated_at FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(competencyId);
    if (!competency) return res.status(404).json({ message: 'Mês da escala não encontrado.' });
    const slots = db.prepare(`SELECT s.*,a.id AS assignment_id,a.position_number,a.member_id,a.service_type,a.display_prefix,m.rank,m.operational_name
      FROM service_slots s
      LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
      LEFT JOIN members m ON m.id=a.member_id
      WHERE s.competency_id=?
      ORDER BY s.service_date,CASE s.period WHEN 'DIURNO' THEN 0 ELSE 1 END,a.position_number`).all(competencyId);
    const items = new Map();
    for (const row of slots) {
      if (!items.has(row.id)) {
        const { assignment_id, position_number, member_id, service_type, display_prefix, rank, operational_name, ...slot } = row;
        items.set(row.id, { ...slot, assignments: [] });
      }
      if (row.assignment_id) items.get(row.id).assignments.push({
        id: row.assignment_id, positionNumber: row.position_number, memberId: row.member_id,
        rank: row.rank, operationalName: row.operational_name, serviceType: row.service_type, displayPrefix: row.display_prefix
      });
    }
    res.json({ competency, items: [...items.values()] });
  } catch (error) { next(error); }
});

router.get('/pdf', (req, res, next) => {
  try {
    const competencyId = z.coerce.number().int().positive().parse(req.query.competency_id);
    const competency = db.prepare('SELECT * FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(competencyId);
    if (!competency) return res.status(404).json({ message: 'Mês da escala não encontrado.' });
    buildSchedulePdf({ competency, slots: scheduleRows(competencyId) })
      .then((buffer) => {
        const fileName = `escala-${competency.year}-${String(competency.month).padStart(2, '0')}.pdf`;
        res.type('application/pdf').attachment(fileName).send(buffer);
      })
      .catch(next);
  } catch (error) { next(error); }
});

router.put('/:slotId/positions/:positionNumber', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const slotId = z.coerce.number().int().positive().parse(req.params.slotId);
    const positionNumber = z.coerce.number().int().min(1).max(4).parse(req.params.positionNumber);
    const { memberId, serviceType } = z.object({ memberId: z.number().int().positive().nullable(), serviceType: z.enum(['ORDINARY', 'EXTRAORDINARY']).optional() }).parse(req.body);
    const slot = manualSlot(slotId);
    if (positionNumber > slot.current_capacity) return res.status(400).json({ message: 'Esta posição ainda está trancada para o turno selecionado.' });
    const existing = db.prepare(`SELECT a.*,m.rank,m.operational_name FROM assignments a JOIN members m ON m.id=a.member_id
      WHERE a.service_slot_id=? AND a.position_number=? AND a.status='CONFIRMED'`).get(slotId, positionNumber);
    if (!memberId) {
      if (!existing) return res.status(204).end();
      db.prepare('DELETE FROM assignments WHERE id=?').run(existing.id);
      audit({ userId: req.user.id, action: 'MANUAL_ASSIGNMENT_REMOVE', entityType: 'ASSIGNMENT', entityId: existing.id, before: existing, req });
      return res.status(204).end();
    }
    const member = eligibleMember(memberId);
    const resultingServiceType = serviceType || existing?.service_type || 'EXTRAORDINARY';
    if (member.operational_status === 'VACATION' && resultingServiceType === 'ORDINARY') {
      return res.status(409).json({ message: 'Militar de férias pode ocupar somente serviço extra.' });
    }
    const duplicate = db.prepare(`SELECT id FROM assignments WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' AND id<>?`).get(slotId, memberId, existing?.id ?? 0);
    if (duplicate) return res.status(409).json({ message: 'Este militar já está confirmado neste turno.' });
    let assignment;
    if (existing) {
      db.prepare('UPDATE assignments SET member_id=?,service_type=COALESCE(?,service_type),display_prefix=NULL,updated_at=? WHERE id=?').run(memberId, serviceType || null, now(), existing.id);
      assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(existing.id);
      audit({ userId: req.user.id, action: 'MANUAL_ASSIGNMENT_REPLACE', entityType: 'ASSIGNMENT', entityId: existing.id, before: existing, after: assignment, req });
    } else {
      const stamp = now();
      const result = db.prepare(`INSERT INTO assignments
        (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
        VALUES (?,?,?,?,'CONFIRMED',?,?,?,?)`).run(slotId, positionNumber, member.id, serviceType || 'EXTRAORDINARY', `MANUAL-${randomUUID()}`, stamp, stamp, stamp);
      assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(result.lastInsertRowid);
      audit({ userId: req.user.id, action: 'MANUAL_ASSIGNMENT_CREATE', entityType: 'ASSIGNMENT', entityId: assignment.id, after: assignment, req });
    }
    res.json({ item: assignment });
  } catch (error) { next(error); }
});

router.post('/assignments/:id/move', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const assignmentId = z.coerce.number().int().positive().parse(req.params.id);
    const input = z.object({ targetSlotId: z.number().int().positive(), targetPosition: z.number().int().min(1).max(4) }).parse(req.body);
    const assignment = db.prepare(`SELECT a.*,s.competency_id,s.status AS slot_status,s.homologated_at
      FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id WHERE a.id=? AND a.status='CONFIRMED'`).get(assignmentId);
    if (!assignment) return res.status(404).json({ message: 'Marcação não encontrada.' });
    if (assignment.slot_status !== 'OPEN' || assignment.homologated_at) return res.status(400).json({ message: 'Não é possível mover uma marcação de horário fechado ou homologado.' });
    const target = manualSlot(input.targetSlotId);
    if (target.competency_id !== assignment.competency_id) return res.status(400).json({ message: 'A vaga de destino deve pertencer ao mesmo mês da escala.' });
    if (input.targetSlotId === assignment.service_slot_id && input.targetPosition === assignment.position_number) return res.status(400).json({ message: 'Selecione uma vaga de destino diferente.' });
    if (input.targetPosition > target.current_capacity) return res.status(400).json({ message: 'A posição de destino ainda está trancada.' });
    const occupied = db.prepare(`SELECT * FROM assignments WHERE service_slot_id=? AND position_number=? AND status='CONFIRMED'`).get(input.targetSlotId, input.targetPosition);
    const duplicate = db.prepare(`SELECT id FROM assignments WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' AND id NOT IN (?,?)`).get(input.targetSlotId, assignment.member_id, assignmentId, occupied?.id ?? 0);
    if (duplicate) return res.status(409).json({ message: 'O militar já está confirmado no turno de destino.' });
    if (occupied) {
      const reverseDuplicate = db.prepare(`SELECT id FROM assignments WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' AND id NOT IN (?,?)`).get(assignment.service_slot_id, occupied.member_id, assignmentId, occupied.id);
      if (reverseDuplicate) return res.status(409).json({ message: 'O militar da posição de destino já está no turno de origem.' });
      db.transaction(() => {
        db.prepare('UPDATE assignments SET position_number=?,updated_at=? WHERE id=?').run(-assignmentId, now(), assignmentId);
        db.prepare('UPDATE assignments SET service_slot_id=?,position_number=?,updated_at=? WHERE id=?').run(assignment.service_slot_id, assignment.position_number, now(), occupied.id);
        db.prepare('UPDATE assignments SET service_slot_id=?,position_number=?,updated_at=? WHERE id=?').run(input.targetSlotId, input.targetPosition, now(), assignmentId);
      })();
    } else {
      db.prepare('UPDATE assignments SET service_slot_id=?,position_number=?,updated_at=? WHERE id=?').run(input.targetSlotId, input.targetPosition, now(), assignmentId);
    }
    const item = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignmentId);
    audit({ userId: req.user.id, action: occupied ? 'MANUAL_ASSIGNMENT_SWAP' : 'MANUAL_ASSIGNMENT_MOVE', entityType: 'ASSIGNMENT', entityId: assignmentId, before: { assignment, occupied }, after: item, req });
    res.json({ item, swapped: Boolean(occupied) });
  } catch (error) { next(error); }
});

router.patch('/assignments/:id/type', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const assignmentId = z.coerce.number().int().positive().parse(req.params.id);
    const { serviceType } = z.object({ serviceType: z.enum(['ORDINARY', 'EXTRAORDINARY']) }).parse(req.body);
    const before = db.prepare(`SELECT a.*,s.status AS slot_status,s.homologated_at,m.operational_status FROM assignments a
      JOIN service_slots s ON s.id=a.service_slot_id JOIN members m ON m.id=a.member_id
      WHERE a.id=? AND a.status='CONFIRMED'`).get(assignmentId);
    if (!before) return res.status(404).json({ message: 'Marcação não encontrada.' });
    if (before.slot_status !== 'OPEN' || before.homologated_at) return res.status(400).json({ message: 'Não é possível alterar um horário fechado ou homologado.' });
    if (before.operational_status === 'VACATION' && serviceType === 'ORDINARY') {
      return res.status(409).json({ message: 'Militar de férias pode ocupar somente serviço extra.' });
    }
    db.prepare('UPDATE assignments SET service_type=?,updated_at=? WHERE id=?').run(serviceType, now(), assignmentId);
    const item = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignmentId);
    audit({ userId: req.user.id, action: 'MANUAL_ASSIGNMENT_TYPE_CHANGE', entityType: 'ASSIGNMENT', entityId: assignmentId, before, after: item, req });
    res.json({ item });
  } catch (error) { next(error); }
});

router.get('/pdf-columns', allow('ADMIN'), (req, res, next) => {
  try {
    const competencyId = z.coerce.number().int().positive().parse(req.query.competency_id);
    const dates = db.prepare('SELECT DISTINCT service_date FROM service_slots WHERE competency_id=? ORDER BY service_date').all(competencyId);
    const releases = new Map(db.prepare(`SELECT service_date,third_column_open,fourth_column_open
      FROM schedule_pdf_column_releases WHERE competency_id=?`).all(competencyId).map((row) => [row.service_date, row]));
    res.json({ item: { competencyId, items: dates.map((row) => {
      const release = releases.get(row.service_date);
      const fourth = Boolean(release?.fourth_column_open);
      const third = Boolean(release?.third_column_open || fourth);
      return { serviceDate: row.service_date, openColumns: [1, 2, ...(third ? [3] : []), ...(fourth ? [4] : [])] };
    }) } });
  } catch (error) { next(error); }
});

router.put('/pdf-columns', allow('ADMIN'), async (req, res, next) => {
  try {
    const input = z.object({
      competencyId: z.number().int().positive(),
      items: z.array(z.object({ serviceDate: z.string().date(), openColumns: z.array(z.number().int().min(1).max(4)) }))
    }).parse(req.body);
    const validDates = new Set(db.prepare('SELECT DISTINCT service_date FROM service_slots WHERE competency_id=?').all(input.competencyId).map((row) => row.service_date));
    if (input.items.some((item) => !validDates.has(item.serviceDate))) return res.status(400).json({ message: 'Uma das datas não pertence ao mês selecionado.' });
    const confirmed = new Map(db.prepare(`SELECT s.service_date,s.period,COUNT(a.id) confirmed_count
      FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
      WHERE s.competency_id=? GROUP BY s.id`).all(input.competencyId)
      .map((row) => [`${row.service_date}:${row.period}`, Number(row.confirmed_count)]));
    const normalized = input.items.map((item) => {
      const selected = new Set(item.openColumns);
      const fourth = selected.has(4);
      const third = selected.has(3) || fourth;
      const capacity = fourth ? 4 : third ? 3 : 2;
      for (const period of ['DIURNO', 'NOTURNO']) {
        if ((confirmed.get(`${item.serviceDate}:${period}`) || 0) > capacity) throw new Error(`Não é possível trancar a coluna de ${item.serviceDate}: já há militares confirmados nela.`);
      }
      return { serviceDate: item.serviceDate, third, fourth, capacity, openColumns: [1, 2, ...(third ? [3] : []), ...(fourth ? [4] : [])] };
    });
    const stamp = now();
    db.transaction(() => {
      const save = db.prepare(`INSERT INTO schedule_pdf_column_releases
        (competency_id,service_date,third_column_open,fourth_column_open,updated_by,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(competency_id,service_date) DO UPDATE SET
        third_column_open=excluded.third_column_open,fourth_column_open=excluded.fourth_column_open,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
      const remove = db.prepare('DELETE FROM schedule_pdf_column_releases WHERE competency_id=? AND service_date=?');
      const updateCapacity = db.prepare(`UPDATE service_slots SET minimum_required=2,normal_capacity=2,current_capacity=?,updated_at=?
        WHERE competency_id=? AND service_date=?`);
      for (const item of normalized) {
        if (item.third || item.fourth) save.run(input.competencyId, item.serviceDate, Number(item.third), Number(item.fourth), req.user.id, stamp);
        else remove.run(input.competencyId, item.serviceDate);
        updateCapacity.run(item.capacity, stamp, input.competencyId, item.serviceDate);
      }
    })();
    audit({ userId: req.user.id, action: 'UPDATE_PDF_COLUMNS', entityType: 'SCHEDULE_PDF', entityId: String(input.competencyId), after: normalized, req });
    res.json({ item: { competencyId: input.competencyId, items: normalized.map(({ serviceDate, openColumns }) => ({ serviceDate, openColumns })) } });
  } catch (error) { next(error); }
});

router.post('/', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try { res.status(201).json({ item: createSlot(slotSchema.parse(req.body), req.user.id, req) }); }
  catch (error) { next(error); }
});

router.post('/generate-range', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const input = z.object({
      competency_id: z.number().int().positive(), starts_on: z.string().date(), ends_on: z.string().date(),
      periods: z.array(z.enum(['DIURNO', 'NOTURNO'])).min(1), minimum_required: z.literal(2).default(2),
      current_capacity: z.number().int().min(2).max(4).default(2)
    }).parse(req.body);
    if (dayjs(input.ends_on).isBefore(input.starts_on)) return res.status(400).json({ message: 'A data final deve ser posterior à inicial.' });
    let created = 0;
    db.transaction(() => {
      for (let cursor = dayjs(input.starts_on); !cursor.isAfter(input.ends_on); cursor = cursor.add(1, 'day')) {
        for (const period of input.periods) {
          try { createSlot({ ...input, service_date: cursor.format('YYYY-MM-DD'), period }, req.user.id, req); created += 1; }
          catch (error) { if (!String(error.message).includes('UNIQUE')) throw error; }
        }
      }
    })();
    res.status(201).json({ created });
  } catch (error) { next(error); }
});

router.patch('/:id', allow('ADMIN', 'SCHEDULER'), (req, res, next) => {
  try {
    const input = z.object({ status: z.enum(['OPEN', 'CLOSED']).optional(), minimum_required: z.literal(2).optional(), is_majorado: z.boolean().optional() }).parse(req.body);
    db.prepare(`UPDATE service_slots SET status=COALESCE(@status,status),minimum_required=2,normal_capacity=2,
      is_majorado=COALESCE(@is_majorado,is_majorado),updated_at=@updated_at WHERE id=@id`).run({
      ...input, is_majorado: input.is_majorado === undefined ? null : Number(input.is_majorado), updated_at: now(), id: req.params.id
    });
    res.json({ item: db.prepare('SELECT * FROM service_slots WHERE id=?').get(req.params.id) });
  } catch (error) { next(error); }
});

router.post('/capacity/bulk-update', allow('ADMIN', 'APPROVING_AUTHORITY'), (req, res, next) => {
  try {
    const input = z.object({
      slotIds: z.array(z.number().int().positive()).min(1), newCapacity: z.number().int().min(2).max(4),
      authorityName: z.string().min(2), authorizationReference: z.string().min(2), reason: z.string().min(5)
    }).parse(req.body);
    db.transaction(() => {
      const get = db.prepare('SELECT * FROM service_slots WHERE id=?');
      const update = db.prepare('UPDATE service_slots SET current_capacity=?,updated_at=? WHERE id=?');
      const log = db.prepare(`INSERT INTO capacity_changes
        (service_slot_id,previous_capacity,new_capacity,authority_name,authorization_reference,reason,changed_by,changed_at)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const id of input.slotIds) {
        const slot = get.get(id);
        if (!slot) throw new Error(`Horário ${id} não encontrado.`);
        const occupied = db.prepare("SELECT COUNT(*) count FROM assignments WHERE service_slot_id=? AND status='CONFIRMED'").get(id).count;
        if (occupied > input.newCapacity) throw new Error(`Horário ${id} possui ${occupied} militares confirmados.`);
        if (slot.homologated_at) throw new Error(`Horário ${id} já foi homologado.`);
        update.run(input.newCapacity, now(), id);
        log.run(id, slot.current_capacity, input.newCapacity, input.authorityName, input.authorizationReference, input.reason, req.user.id, now());
      }
    })();
    audit({ userId: req.user.id, action: 'CAPACITY_UPDATE', entityType: 'SERVICE_SLOT', entityId: input.slotIds.join(','), after: input, reason: input.reason, req });
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
