import { audit, db, now } from '../database/index.js';

export function vacationImpact({ memberId, competencyId }) {
  const assignments = db.prepare(`SELECT a.id,a.service_slot_id,a.position_number,a.service_type,s.service_date,s.period
    FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.competency_id=? AND a.member_id=? AND a.status='CONFIRMED'
    ORDER BY s.service_date,s.period,a.position_number`).all(competencyId, memberId);
  return {
    assignments,
    ordinaryAssignments: assignments.filter((item) => item.service_type === 'ORDINARY').length,
    extraordinaryAssignments: assignments.filter((item) => item.service_type === 'EXTRAORDINARY').length
  };
}

export function applyVacationToCompetency({ memberId, competencyId, extraAction = null, userId = null, reason = 'Alteração para férias' }) {
  const impact = vacationImpact({ memberId, competencyId });
  if (impact.extraordinaryAssignments && !extraAction) return { confirmationRequired: true, ...impact };
  const assignmentsToRemove = impact.assignments.filter((assignment) =>
    assignment.service_type === 'ORDINARY' || extraAction === 'REMOVE');
  const affectedSlotIds = [...new Set(assignmentsToRemove.map((assignment) => assignment.service_slot_id))];
  const stamp = now();
  db.transaction(() => {
    const removeAssignment = db.prepare('DELETE FROM assignments WHERE id=?');
    for (const assignment of assignmentsToRemove) removeAssignment.run(assignment.id);
    const remainingAssignments = db.prepare(`SELECT id FROM assignments
      WHERE service_slot_id=? AND status='CONFIRMED' ORDER BY position_number,id`);
    const moveAssignment = db.prepare('UPDATE assignments SET position_number=?,updated_at=? WHERE id=?');
    for (const slotId of affectedSlotIds) {
      const remaining = remainingAssignments.all(slotId);
      for (const assignment of remaining) moveAssignment.run(-assignment.id, stamp, assignment.id);
      for (const [index, assignment] of remaining.entries()) moveAssignment.run(index + 1, stamp, assignment.id);
    }
  })();
  const result = {
    confirmationRequired: false,
    ordinaryAssignmentsRemoved: impact.ordinaryAssignments,
    extraordinaryAssignmentsRemoved: extraAction === 'REMOVE' ? impact.extraordinaryAssignments : 0,
    extraordinaryAssignmentsKept: extraAction === 'KEEP' ? impact.extraordinaryAssignments : 0,
    affectedSlots: affectedSlotIds.length
  };
  audit({ userId, memberId, action: 'APPLY_MEMBER_VACATION_TO_SCHEDULE', entityType: 'COMPETENCY', entityId: competencyId,
    before: { assignments: impact.assignments }, after: result, reason });
  return result;
}
