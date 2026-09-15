import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-monthly-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-monthly-test-secret';
process.env.ADMIN_EMAIL = 'monthly-test@example.com';
process.env.ADMIN_INITIAL_PASSWORD = 'isolated-monthly-password';

const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule, generateOrdinaryAssignments, regenerateOrdinaryAssignments } = await import('../src/scheduling/monthly.js');
runMigrations();

const stamp = now();
const addMember = db.prepare(`INSERT INTO members
  (id,rank,operational_name,unit_type,active,operational_status,authorization_status,ordinary_eligible,created_at,updated_at)
  VALUES (?,'Sgt',?,'CICC',1,'ACTIVE','AUTHORIZED',?,?,?)`);
addMember.run(1, 'Escalado', 1, stamp, stamp);
addMember.run(2, 'Somente Bot', 0, stamp, stamp);
db.prepare(`INSERT INTO ordinary_rotations
  (member_id,position_number,anchor_date,active,created_at,updated_at) VALUES (?,?,?,1,?,?)`)
  .run(1, 1, '2031-01-30', stamp, stamp);
db.prepare(`INSERT INTO ordinary_rotations
  (member_id,position_number,anchor_date,active,created_at,updated_at) VALUES (?,?,?,1,?,?)`)
  .run(2, 2, '2031-01-30', stamp, stamp);
const { competency } = ensureCompetencySchedule('2031-02-01');

after(() => {
  db.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) {
    fs.rmSync(path.join(testDirectory, name), { force: true });
  }
  fs.rmdirSync(testDirectory);
});

test('ordinary generation skips a registered member excluded from the automatic 1x4 cycle', () => {
  const result = generateOrdinaryAssignments({ competencyId: competency.id });
  const generatedMembers = db.prepare(`SELECT DISTINCT a.member_id FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.competency_id=? AND a.service_type='ORDINARY' ORDER BY a.member_id`).all(competency.id);

  assert.deepEqual(generatedMembers, [{ member_id: 1 }]);
  assert.equal(result.skippedMembers.some((member) => member.memberId === 2 && member.ordinaryEligible === false), true);
});

test('re-enabling ordinary participation includes the member when the month is regenerated', () => {
  db.prepare('UPDATE members SET ordinary_eligible=1 WHERE id=2').run();
  regenerateOrdinaryAssignments({ competencyId: competency.id });

  const generatedMembers = db.prepare(`SELECT DISTINCT a.member_id FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.competency_id=? AND a.service_type='ORDINARY' ORDER BY a.member_id`).all(competency.id);
  assert.deepEqual(generatedMembers, [{ member_id: 1 }, { member_id: 2 }]);
});
