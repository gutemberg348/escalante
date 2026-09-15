import dayjs from 'dayjs';
import { db, audit, now } from '../database/index.js';
import { isMajoradoDate } from './majorado.js';

const monthNames = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function monthDate(value) {
  const date = dayjs(value).startOf('month');
  if (!date.isValid()) throw new Error('Mês inválido para geração da escala.');
  return date;
}

export function ensureCompetencySchedule(value) {
  const date = monthDate(value);
  const year = date.year();
  const month = date.month() + 1;
  const stamp = now();
  const existing = db.prepare('SELECT id FROM competencies WHERE year=? AND month=?').get(year, month);
  db.prepare(`INSERT OR IGNORE INTO competencies
    (year,month,name,status,standard_hour_limit,current_hour_limit,created_at,updated_at)
    VALUES (?,?,?,'CONFIGURING',192,192,?,?)`)
    .run(year, month, `${monthNames[month - 1]} de ${year}`, stamp, stamp);
  const competency = db.prepare('SELECT * FROM competencies WHERE year=? AND month=?').get(year, month);
  const insert = db.prepare(`INSERT OR IGNORE INTO service_slots
    (competency_id,service_date,period,starts_at,ends_at,minimum_required,normal_capacity,current_capacity,
     service_classification,is_majorado,status,homologation_deadline,created_at,updated_at)
    VALUES (?,?,?,?,?,2,2,2,'EXTRAORDINARY',?,'OPEN',?,?,?)`);
  const updateMajorado = db.prepare('UPDATE service_slots SET is_majorado=?,updated_at=? WHERE competency_id=? AND service_date=?');
  db.transaction(() => {
    for (let day = 1; day <= date.daysInMonth(); day += 1) {
      const serviceDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const nextDate = dayjs(serviceDate).add(1, 'day').format('YYYY-MM-DD');
      const deadline = dayjs(`${serviceDate}T07:00:00`).subtract(1, 'day').toISOString();
      const majorado = Number(isMajoradoDate(serviceDate));
      insert.run(competency.id, serviceDate, 'DIURNO', `${serviceDate}T07:00:00`, `${serviceDate}T19:00:00`, majorado, deadline, stamp, stamp);
      insert.run(competency.id, serviceDate, 'NOTURNO', `${serviceDate}T19:00:00`, `${nextDate}T07:00:00`, majorado, deadline, stamp, stamp);
      updateMajorado.run(majorado, stamp, competency.id, serviceDate);
    }
  })();
  return { competency, competencyCreated: !existing };
}

function eligibleForOrdinary(member) {
  return Number(member?.active) === 1
    && member.operational_status === 'ACTIVE'
    && member.authorization_status === 'AUTHORIZED'
    && Number(member.ordinary_eligible) === 1;
}

export function generateOrdinaryAssignments({ competencyId, userId = null, reason = 'Geração mensal da escala ordinária 1x4' }) {
  const competency = db.prepare('SELECT * FROM competencies WHERE id=?').get(competencyId);
  if (!competency) throw new Error('Mês não encontrado para gerar a escala ordinária.');
  const targetStart = dayjs(`${competency.year}-${String(competency.month).padStart(2, '0')}-01`);
  const targetEnd = targetStart.endOf('month');
  const anchors = db.prepare(`SELECT member_id,position_number,anchor_date AS last_service_date
    FROM ordinary_rotations WHERE active=1 AND anchor_date<?
    ORDER BY position_number,anchor_date,member_id`).all(targetStart.format('YYYY-MM-DD'));
  const slots = db.prepare(`SELECT id,service_date,period,starts_at,ends_at,current_capacity
    FROM service_slots WHERE competency_id=? ORDER BY service_date,period`).all(competency.id);
  const slotsByDate = new Map();
  for (const slot of slots) {
    const daySlots = slotsByDate.get(slot.service_date) ?? [];
    daySlots.push(slot);
    slotsByDate.set(slot.service_date, daySlots);
  }
  const findMember = db.prepare('SELECT * FROM members WHERE id=?');
  const findUnavailability = db.prepare(`SELECT id FROM unavailabilities
    WHERE member_id=? AND status='ACTIVE' AND affects_ordinary=1
      AND starts_at<=? AND ends_at>=? LIMIT 1`);
  const assignmentsForSlot = db.prepare(`SELECT id,member_id,position_number,service_type
    FROM assignments WHERE service_slot_id=? AND status='CONFIRMED'`);
  const insertAssignment = db.prepare(`INSERT INTO assignments
    (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,?,?,'ORDINARY','CONFIRMED',?,?,?,?)`);
  const setOrdinary = db.prepare(`UPDATE assignments SET service_type='ORDINARY',updated_at=? WHERE id=?`);
  const skippedMembers = [];
  const unavailableDays = [];
  const conflictDays = [];
  let dutyDays = 0;
  let assignmentsCreated = 0;
  let assignmentsReclassified = 0;

  db.transaction(() => {
    for (const anchor of anchors) {
      const member = findMember.get(anchor.member_id);
      if (!eligibleForOrdinary(member)) {
        skippedMembers.push({
          memberId: anchor.member_id,
          name: member ? `${member.rank} ${member.operational_name}` : `Militar ${anchor.member_id}`,
          active: Boolean(member?.active),
          operationalStatus: member?.operational_status ?? 'NOT_FOUND',
          authorizationStatus: member?.authorization_status ?? 'NOT_FOUND',
          ordinaryEligible: Boolean(member?.ordinary_eligible)
        });
        continue;
      }
      let serviceDate = dayjs(anchor.last_service_date).add(5, 'day');
      while (serviceDate.isBefore(targetStart, 'day')) serviceDate = serviceDate.add(5, 'day');
      for (; !serviceDate.isAfter(targetEnd, 'day'); serviceDate = serviceDate.add(5, 'day')) {
        const dateKey = serviceDate.format('YYYY-MM-DD');
        const daySlots = slotsByDate.get(dateKey) ?? [];
        const daySlot = daySlots.find((slot) => slot.period === 'DIURNO');
        const nightSlot = daySlots.find((slot) => slot.period === 'NOTURNO');
        if (!daySlot || !nightSlot || anchor.position_number > Math.min(daySlot.current_capacity, nightSlot.current_capacity)) {
          conflictDays.push({ memberId: member.id, serviceDate: dateKey, position: anchor.position_number, reason: 'Horários ou posição indisponíveis' });
          continue;
        }
        if (findUnavailability.get(member.id, nightSlot.ends_at, daySlot.starts_at)) {
          unavailableDays.push({ memberId: member.id, serviceDate: dateKey, position: anchor.position_number });
          continue;
        }
        const existingBySlot = daySlots.map((slot) => ({ slot, assignments: assignmentsForSlot.all(slot.id) }));
        const blocked = existingBySlot.some(({ assignments }) => {
          const occupant = assignments.find((item) => item.position_number === anchor.position_number);
          const sameMemberElsewhere = assignments.find((item) => item.member_id === member.id && item.position_number !== anchor.position_number);
          return Boolean((occupant && occupant.member_id !== member.id) || sameMemberElsewhere);
        });
        if (blocked) {
          conflictDays.push({ memberId: member.id, serviceDate: dateKey, position: anchor.position_number, reason: 'Vaga já ocupada' });
          continue;
        }
        dutyDays += 1;
        for (const { slot, assignments } of existingBySlot) {
          const existingAssignment = assignments.find((item) => item.position_number === anchor.position_number);
          if (existingAssignment) {
            if (existingAssignment.service_type !== 'ORDINARY') {
              setOrdinary.run(now(), existingAssignment.id);
              assignmentsReclassified += 1;
            }
            continue;
          }
          const stamp = now();
          const protocol = `ORD-${dateKey}-P${anchor.position_number}-M${member.id}-${slot.period}`;
          insertAssignment.run(slot.id, anchor.position_number, member.id, protocol, stamp, stamp, stamp);
          assignmentsCreated += 1;
        }
      }
    }
  })();

  const totals = db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN a.service_type='ORDINARY' THEN s.service_date || ':' || a.member_id END) AS ordinary_duty_days,
      COUNT(CASE WHEN a.service_type='ORDINARY' THEN 1 END) AS ordinary_shifts,
      COUNT(CASE WHEN a.service_type='EXTRAORDINARY' THEN 1 END) AS extraordinary_shifts
    FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
    WHERE s.competency_id=?`).get(competency.id);
  const result = {
    competency,
    anchors: anchors.length,
    dutyDays,
    assignmentsCreated,
    assignmentsReclassified,
    ordinaryDutyDays: Number(totals.ordinary_duty_days || 0),
    ordinaryShifts: Number(totals.ordinary_shifts || 0),
    extraordinaryShifts: Number(totals.extraordinary_shifts || 0),
    skippedMembers,
    unavailableDays,
    conflictDays
  };
  db.prepare(`UPDATE competencies SET generated_at=COALESCE(generated_at,?),status=CASE WHEN status='CONFIGURING' THEN 'DRAFT' ELSE status END,updated_at=? WHERE id=?`)
    .run(now(), now(), competency.id);
  if (assignmentsCreated > 0 || assignmentsReclassified > 0) {
    audit({ userId, action: 'GENERATE_ORDINARY_SCHEDULE', entityType: 'COMPETENCY', entityId: competency.id, after: result, reason });
  }
  return result;
}

export function regenerateOrdinaryAssignments({ competencyId, userId = null, reason = 'Regeneração manual da escala ordinária' }) {
  const competency = db.prepare('SELECT * FROM competencies WHERE id=?').get(competencyId);
  if (!competency) throw new Error('Mês não encontrado para regenerar a escala ordinária.');
  const ordinaryAssignments = db.prepare(`SELECT a.* FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.competency_id=? AND a.status='CONFIRMED' AND a.service_type='ORDINARY'`).all(competencyId);
  const removed = db.transaction(() => {
    const remove = db.prepare('DELETE FROM assignments WHERE id=?');
    for (const assignment of ordinaryAssignments) remove.run(assignment.id);
    return ordinaryAssignments.length;
  })();
  if (removed) audit({ userId, action: 'RESET_ORDINARY_SCHEDULE', entityType: 'COMPETENCY', entityId: competencyId, before: { assignments: ordinaryAssignments }, reason });
  return { ...generateOrdinaryAssignments({ competencyId, userId, reason }), assignmentsRemoved: removed };
}

export function generateNextMonthSchedule({ userId = null, reason } = {}) {
  const current = dayjs().startOf('month');
  const latest = db.prepare(`SELECT year,month FROM competencies WHERE generated_at IS NOT NULL ORDER BY year DESC,month DESC LIMIT 1`).get();
  const latestDate = latest ? dayjs(`${latest.year}-${String(latest.month).padStart(2, '0')}-01`) : null;
  const base = latestDate?.isAfter(current, 'month') ? latestDate : current;
  const target = base.add(1, 'month');
  const prepared = ensureCompetencySchedule(target);
  return {
    ...generateOrdinaryAssignments({ competencyId: prepared.competency.id, userId, reason }),
    competencyCreated: prepared.competencyCreated
  };
}
