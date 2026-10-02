import { audit, db } from '../database/index.js';

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

export function applyVacationToCompetency({ memberId, competencyId, userId = null, reason = 'Alteração para férias' }) {
  const impact = vacationImpact({ memberId, competencyId });
  const assignmentsToRemove = impact.assignments.filter((assignment) => assignment.service_type === 'ORDINARY');
  const affectedSlotIds = [...new Set(assignmentsToRemove.map((assignment) => assignment.service_slot_id))];
  db.transaction(() => {
    const removeAssignment = db.prepare('DELETE FROM assignments WHERE id=?');
    for (const assignment of assignmentsToRemove) removeAssignment.run(assignment.id);
  })();
  const result = {
    confirmationRequired: false,
    ordinaryAssignmentsRemoved: impact.ordinaryAssignments,
    extraordinaryAssignmentsRemoved: 0,
    extraordinaryAssignmentsKept: impact.extraordinaryAssignments,
    affectedSlots: affectedSlotIds.length
  };
  audit({ userId, memberId, action: 'APPLY_MEMBER_VACATION_TO_SCHEDULE', entityType: 'COMPETENCY', entityId: competencyId,
    before: { assignments: impact.assignments }, after: result, reason });
  return result;
}
