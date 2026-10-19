import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-wings-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-wings-test-secret';
process.env.ADMIN_EMAIL = 'wings-test@example.com';
process.env.ADMIN_INITIAL_PASSWORD = 'isolated-wings-password';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule, generateOrdinaryAssignments, regenerateOrdinaryAssignments, generateSelectedMonthSchedule } = await import('../src/scheduling/monthly.js');
const { fiveWings, wingDays, cycleRuleForMonth, previewWingImport, membershipsForMonth } = await import('../src/scheduling/wings.js');
const { default: routes } = await import('../src/modules/wings/routes.js');
const { default: competencyRoutes } = await import('../src/modules/competencies/routes.js');
runMigrations();
const stamp = now();
db.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at,updated_at)
  VALUES (1,'Teste','test@example.com','hash','ADMIN',?,?)`).run(stamp, stamp);
for (let member = 1; member <= 6; member += 1) {
  db.prepare(`INSERT INTO members (id,rank,operational_name,unit_type,active,operational_status,authorization_status,ordinary_eligible,created_at,updated_at)
    VALUES (?,'Sgt',?,'CICC',1,'ACTIVE','AUTHORIZED',1,?,?)`).run(member, `Militar ${member}`, stamp, stamp);
}
const { competency } = ensureCompetencySchedule('2031-07-01');
db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp, competency.id);
const wings = fiveWings();
const wingId = (number) => wings.find((wing) => wing.number === number).id;
const memberEntry = (member, wing, position = 1) => ({ memberId: member, wingId: wingId(wing), positionNumber: position });
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' }; next(); });
app.use('/api/wings', routes);
app.use('/api/competencies', competencyRoutes);
app.use((err, req, res, next) => res.status(err.name === 'ZodError' ? 400 : 500).json({ message: err.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/api/wings`;
async function request(endpoint, body, method = 'POST', role = 'ADMIN') {
  const response = await fetch(`${url}${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function requestMonth(endpoint, body, method = 'POST', role = 'ADMIN') {
  const response = await fetch(`${url.replace('/api/wings', '/api/competencies')}${endpoint}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, data: await response.json() };
}
function assignment(memberId, date, period = 'DIURNO', type = 'ORDINARY', position = 1) {
  const slot = db.prepare('SELECT id FROM service_slots WHERE competency_id=? AND service_date=? AND period=?').get(competency.id, date, period);
  return db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,?,?,?,'CONFIRMED',?,?,?,?)`).run(slot.id, position, memberId, type, `${memberId}-${date}-${period}-${position}`, stamp, stamp, stamp);
}
async function importRoster(mode = 'CONTINUOUS') {
  const preview = previewWingImport(competency);
  const result = await request('/import', { competencyId: competency.id, mode, entries: preview.entries });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
function memberDates(memberId, competencyId = competency.id) {
  return db.prepare(`SELECT DISTINCT s.service_date FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.competency_id=? AND a.member_id=? AND a.service_type='ORDINARY' ORDER BY s.service_date`)
    .all(competencyId, memberId).map((row) => row.service_date);
}
beforeEach(() => {
  db.exec(`DELETE FROM wing_month_overrides; DELETE FROM wing_memberships; DELETE FROM wing_cycle_rules;
    DELETE FROM assignments; DELETE FROM ordinary_rotations; DELETE FROM audit_logs;
    UPDATE members SET active=1,operational_status='ACTIVE',ordinary_eligible=1;
    UPDATE service_slots SET status='OPEN',homologated_at=NULL,current_capacity=2;`);
  for (let member = 1; member <= 5; member += 1) {
    for (const period of ['DIURNO', 'NOTURNO']) assignment(member, `2031-07-0${member}`, period);
  }
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, name), { force: true });
  fs.rmdirSync(directory);
});

test('migration creates exactly the five standard wings and is idempotent', () => {
  assert.deepEqual(fiveWings().map((wing) => wing.name), ['Ala 1', 'Ala 2', 'Ala 3', 'Ala 4', 'Ala 5']);
  assert.equal(runMigrations(), 0);
});

test('preview infers five ordinary wings from the selected month and ignores extras', async () => {
  assignment(6, '2031-07-01', 'DIURNO', 'EXTRAORDINARY', 2);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await request(`/import-preview?competency_id=${competency.id}`, null, 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.entries.map(({ memberId, wingId: wing, positionNumber }) => ({ memberId, wingId: wing, positionNumber })),
    [1, 2, 3, 4, 5].map((member) => memberEntry(member, member)));
  assert.deepEqual(response.data.unresolved, []);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_memberships').get().total, 0);
});

test('inconsistent ordinary duties need manual review instead of guessing an ala', () => {
  assignment(1, '2031-07-02', 'DIURNO', 'ORDINARY', 2);
  const preview = previewWingImport(competency);
  assert.equal(preview.entries.some((item) => item.memberId === 1), false);
  assert.equal(preview.unresolved[0].memberId, 1);
});

test('import saves the roster without changing the existing scale or extras', async () => {
  assignment(6, '2031-07-01', 'DIURNO', 'EXTRAORDINARY', 2);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  await importRoster();
  assert.equal(membershipsForMonth(competency).length, 5);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  const result = await request(`/import-preview?competency_id=${competency.id}`, null, 'GET');
  assert.equal(result.status, 200);
  const duplicate = await request('/import', { competencyId: competency.id, mode: 'CONTINUOUS', entries: previewWingImport(competency).entries });
  assert.equal(duplicate.status, 409);
});

const editedRoster = () => [memberEntry(1, 2), memberEntry(2, 1), ...[3, 4, 5].map((member) => memberEntry(member, member))];
const savedAssignments = () => db.prepare('SELECT * FROM assignments ORDER BY id').all();

test('edited initial roster starts next month and keeps the original current baseline', async () => {
  const before = savedAssignments();
  const result = await request('/import', { competencyId: competency.id, entries: editedRoster() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.effectiveMonth, '2031-08-01');
  assert.equal(result.data.appliedFromDate, null);
  assert.deepEqual(savedAssignments(), before);
  assert.equal(membershipsForMonth(competency).find((row) => row.member_id === 1).wing_id, wingId(1));
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  assert.deepEqual(memberDates(1), ['2031-07-01', '2031-07-06', '2031-07-11', '2031-07-16', '2031-07-21', '2031-07-26', '2031-07-31']);
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.equal(memberDates(1, next.id)[0], '2031-08-01');
});

test('initial registration can also apply remaining dates without touching past rows or extras', async () => {
  assignment(6, '2031-07-12', 'DIURNO', 'EXTRAORDINARY', 2);
  const before = savedAssignments();
  const result = await request('/import', { competencyId: competency.id, entries: editedRoster(), applyToCurrentMonth: true, fromDate: '2031-07-10' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.appliedFromDate, '2031-07-10');
  for (const row of before) assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE id=?').get(row.id), row);
  assert.deepEqual(memberDates(1), ['2031-07-01', '2031-07-12', '2031-07-17', '2031-07-22', '2031-07-27']);
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.equal(memberDates(1, next.id)[0], '2031-08-01');
});

test('registration rolls back everything when applying current dates conflicts with an extra', async () => {
  assignment(6, '2031-07-12', 'DIURNO', 'EXTRAORDINARY', 1);
  const before = savedAssignments();
  const membersBefore = db.prepare('SELECT * FROM members ORDER BY id').all();
  const result = await request('/import', { competencyId: competency.id, entries: editedRoster(), applyToCurrentMonth: true, fromDate: '2031-07-10' });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.deepEqual(savedAssignments(), before);
  assert.deepEqual(db.prepare('SELECT * FROM members ORDER BY id').all(), membersBefore);
  for (const table of ['wing_memberships', 'wing_month_overrides', 'wing_cycle_rules', 'audit_logs']) {
    assert.equal(db.prepare(`SELECT COUNT(*) total FROM ${table}`).get().total, 0);
  }
});

test('registration rejects invalid or past apply dates before saving anything', async () => {
  for (const fromDate of ['2020-07-10', '2031-07-32', '2031-08-01']) {
    const result = await request('/import', { competencyId: competency.id, entries: editedRoster(), applyToCurrentMonth: true, fromDate });
    assert.equal(result.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_cycle_rules').get().total, 0);
  }
});

test('member selector changes next month and can also update the current remaining dates atomically', async () => {
  await importRoster();
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  assignment(6, '2031-07-12', 'DIURNO', 'EXTRAORDINARY', 2);
  const protectedRows = db.prepare(`SELECT a.* FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.service_date<'2031-07-10' OR a.service_type='EXTRAORDINARY' ORDER BY a.id`).all();
  const result = await request('/move', { competencyId: competency.id, scope: 'NEXT_MONTH', entries: [memberEntry(1, 2), memberEntry(2, 1)],
    applyToCurrentMonth: true, fromDate: '2031-07-10' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  for (const row of protectedRows) assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE id=?').get(row.id), row);
  assert.deepEqual(memberDates(1), ['2031-07-01', '2031-07-06', '2031-07-12', '2031-07-17', '2031-07-22', '2031-07-27']);
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.equal(memberDates(1, next.id)[0], '2031-08-01');
});

test('a combined future/current move rolls back the future change on a current conflict', async () => {
  await importRoster();
  assignment(6, '2031-07-12', 'DIURNO', 'EXTRAORDINARY', 1);
  const before = savedAssignments();
  const memberships = db.prepare('SELECT * FROM wing_memberships ORDER BY id').all();
  const result = await request('/move', { competencyId: competency.id, scope: 'NEXT_MONTH', entries: [memberEntry(1, 2), memberEntry(2, 1)],
    applyToCurrentMonth: true, fromDate: '2031-07-10' });
  assert.equal(result.status, 409);
  assert.deepEqual(savedAssignments(), before);
  assert.deepEqual(db.prepare('SELECT * FROM wing_memberships ORDER BY id').all(), memberships);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_month_overrides').get().total, 0);
});

test('combined changes reject past dates and unauthorized users', async () => {
  await importRoster();
  const body = { competencyId: competency.id, scope: 'NEXT_MONTH', entries: [memberEntry(1, 1, 2)], applyToCurrentMonth: true, fromDate: '2020-07-01' };
  assert.equal((await request('/move', body)).status, 400);
  assert.equal((await request('/move', { ...body, fromDate: '2031-07-10' }, 'POST', 'SYSTEM_OPERATOR')).status, 403);
});

test('initial current application cannot remove homologated ordinary services', async () => {
  assignment(1, '2031-07-11');
  db.prepare("UPDATE service_slots SET homologated_at=? WHERE competency_id=? AND service_date='2031-07-11'").run(stamp, competency.id);
  const before = savedAssignments();
  const result = await request('/import', { competencyId: competency.id, entries: editedRoster(), applyToCurrentMonth: true, fromDate: '2031-07-10' });
  assert.equal(result.status, 409);
  assert.deepEqual(savedAssignments(), before);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_cycle_rules').get().total, 0);
});

test('the continuous cycle crosses month lengths, leap years and year boundaries without restarting', () => {
  const continuous = { mode: 'CONTINUOUS', reference_date: '2031-01-01' };
  assert.deepEqual(wingDays({ year: 2031, month: 1 }, 1, continuous).map((d) => Number(d.slice(-2))), [1, 6, 11, 16, 21, 26, 31]);
  assert.deepEqual(wingDays({ year: 2031, month: 2 }, 1, continuous).map((d) => Number(d.slice(-2))), [5, 10, 15, 20, 25]);
  assert.deepEqual(wingDays({ year: 2032, month: 2 }, 1, { ...continuous, reference_date: '2032-01-01' }).map((d) => Number(d.slice(-2))), [5, 10, 15, 20, 25]);
  assert.equal(wingDays({ year: 2032, month: 3 }, 1, { ...continuous, reference_date: '2032-01-01' })[0], '2032-03-01');
  assert.equal(wingDays({ year: 2032, month: 1 }, 1, { ...continuous, reference_date: '2031-12-01' })[0], '2032-01-05');
  const reference = { ...continuous, reference_date: '2031-07-29' };
  assert.equal(wingDays({ year: 2031, month: 7 }, 3, reference).at(-1), '2031-07-31');
  assert.equal(wingDays({ year: 2031, month: 8 }, 4, reference)[0], '2031-08-01');
});

test('ordinary generation uses the imported wings for the next month', async () => {
  await importRoster();
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.deepEqual(memberDates(1, next.id).map((d) => Number(d.slice(-2))), [5, 10, 15, 20, 25, 30]);
  assert.deepEqual(memberDates(2, next.id).map((d) => Number(d.slice(-2))), [1, 6, 11, 16, 21, 26, 31]);
});

test('the API rejects monthly resets and preserves the continuous cycle', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await request('/cycle', { competencyId: competency.id, mode: 'MONTHLY_RESET' }, 'PUT');
  assert.equal(response.status, 400);
  assert.equal(cycleRuleForMonth('2031-07-01').mode, 'CONTINUOUS');
  assert.equal(cycleRuleForMonth('2031-08-01').mode, 'CONTINUOUS');
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.equal(memberDates(1, next.id)[0], '2031-08-05');
});

test('a permanent swap applies next month and preserves the current month', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await request('/move', { competencyId: competency.id, scope: 'NEXT_MONTH', entries: [memberEntry(1, 2), memberEntry(2, 1)] });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.equal(membershipsForMonth(competency).find((r) => r.member_id === 1).wing_id, wingId(1));
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.equal(memberDates(1, next.id)[0], '2031-08-01');
  assert.equal(memberDates(2, next.id)[0], '2031-08-05');
});

test('temporary swaps preserve earlier dates and extras and do not persist to next month', async () => {
  await importRoster();
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  assignment(6, '2031-07-12', 'DIURNO', 'EXTRAORDINARY', 2);
  const extra = db.prepare("SELECT * FROM assignments WHERE service_type='EXTRAORDINARY'").get();
  const response = await request('/move', { competencyId: competency.id, scope: 'THIS_MONTH', fromDate: '2031-07-10', entries: [memberEntry(1, 2), memberEntry(2, 1)] });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(memberDates(1), ['2031-07-01', '2031-07-06', '2031-07-12', '2031-07-17', '2031-07-22', '2031-07-27']);
  assert.deepEqual(db.prepare("SELECT * FROM assignments WHERE service_type='EXTRAORDINARY'").get(), extra);
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  assert.deepEqual(memberDates(1), ['2031-07-01', '2031-07-06', '2031-07-12', '2031-07-17', '2031-07-22', '2031-07-27']);
  const next = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: next.id });
  assert.equal(memberDates(1, next.id)[0], '2031-08-05');
});

test('more than one temporary swap keeps the correct date ranges on regeneration', async () => {
  await importRoster();
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  for (const [fromDate, entries] of [
    ['2031-07-10', [memberEntry(1, 2), memberEntry(2, 1)]],
    ['2031-07-20', [memberEntry(1, 1), memberEntry(2, 2)]]
  ]) {
    const response = await request('/move', { competencyId: competency.id, scope: 'THIS_MONTH', fromDate, entries });
    assert.equal(response.status, 200, JSON.stringify(response.data));
  }
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  assert.deepEqual(memberDates(1), ['2031-07-01', '2031-07-06', '2031-07-12', '2031-07-17', '2031-07-21', '2031-07-26', '2031-07-31']);
});

test('a destination extra blocks a temporary swap and rolls the entire change back', async () => {
  await importRoster();
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  // Ala 2 occupies July 12. Replace its ordinary with an extra that must survive.
  db.prepare(`DELETE FROM assignments WHERE service_slot_id IN (SELECT id FROM service_slots WHERE service_date='2031-07-12' AND period='DIURNO')`).run();
  assignment(6, '2031-07-12', 'DIURNO', 'EXTRAORDINARY', 1);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await request('/move', { competencyId: competency.id, scope: 'THIS_MONTH', fromDate: '2031-07-10', entries: [memberEntry(1, 2), memberEntry(2, 1)] });
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_month_overrides').get().total, 0);
});

test('generation never turns an existing extra into ordinary even for the same member', async () => {
  await importRoster();
  assignment(1, '2031-07-06', 'DIURNO', 'EXTRAORDINARY', 1);
  const extra = db.prepare("SELECT * FROM assignments WHERE service_type='EXTRAORDINARY'").get();
  const result = generateOrdinaryAssignments({ competencyId: competency.id });
  assert.equal(result.conflictDays.some((row) => row.memberId === 1 && row.serviceDate === '2031-07-06'), true);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE id=?').get(extra.id), extra);
});

test('occupied roster position rejects a permanent move atomically', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM wing_memberships ORDER BY id').all();
  const response = await request('/move', { competencyId: competency.id, scope: 'NEXT_MONTH', entries: [memberEntry(1, 2)] });
  assert.equal(response.status, 409);
  assert.deepEqual(db.prepare('SELECT * FROM wing_memberships ORDER BY id').all(), before);
});

test('vacation and ordinary exclusion are still respected when generating by wing', async () => {
  await importRoster();
  db.prepare("UPDATE members SET operational_status='VACATION' WHERE id=1").run();
  db.prepare('UPDATE members SET ordinary_eligible=0 WHERE id=2').run();
  const next = ensureCompetencySchedule('2031-08-01').competency;
  const result = generateOrdinaryAssignments({ competencyId: next.id });
  assert.deepEqual(memberDates(1, next.id), []);
  assert.deepEqual(memberDates(2, next.id), []);
  assert.equal(result.skippedMembers.length, 2);
});

test('read-only roles can consult wings but cannot change them', async () => {
  const read = await request(`/?competency_id=${competency.id}`, null, 'GET', 'SYSTEM_OPERATOR');
  assert.equal(read.status, 200);
  const write = await request('/import', { competencyId: competency.id, mode: 'CONTINUOUS', entries: [memberEntry(1, 1)] }, 'POST', 'SYSTEM_OPERATOR');
  assert.equal(write.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_memberships').get().total, 0);
});

test('a homologated source blocks a temporary change without touching its assignments', async () => {
  await importRoster();
  regenerateOrdinaryAssignments({ competencyId: competency.id });
  db.prepare("UPDATE service_slots SET homologated_at=? WHERE competency_id=? AND service_date='2031-07-11'")
    .run(stamp, competency.id);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await request('/move', { competencyId: competency.id, scope: 'THIS_MONTH', fromDate: '2031-07-10', entries: [memberEntry(1, 2), memberEntry(2, 1)] });
  assert.equal(response.status, 409);
  assert.match(response.data.message, /homologados/);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_month_overrides').get().total, 0);
});

test('saving the fixed cycle from a later month never changes the original reference', async () => {
  await importRoster();
  const august = ensureCompetencySchedule('2031-08-01').competency;
  generateOrdinaryAssignments({ competencyId: august.id });
  const resumed = await request('/cycle', { competencyId: august.id, mode: 'CONTINUOUS' }, 'PUT');
  assert.equal(resumed.status, 200);
  const september = ensureCompetencySchedule('2031-09-01').competency;
  generateOrdinaryAssignments({ competencyId: september.id });
  assert.equal(memberDates(1, august.id).at(-1), '2031-08-30');
  assert.equal(memberDates(1, september.id)[0], '2031-09-04');
  assert.equal(cycleRuleForMonth('2031-09-01').reference_date, '2031-07-01');
});

test('invalid temporary dates are rejected before any roster or schedule changes', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  for (const fromDate of ['2031-07-32', '2031-08-01', '2031-06-30']) {
    const response = await request('/move', { competencyId: competency.id, scope: 'THIS_MONTH', fromDate, entries: [memberEntry(1, 1, 2)] });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_month_overrides').get().total, 0);
});

test('previewing an arbitrary month shows its rules without creating it', async () => {
  await importRoster();
  const before = db.prepare('SELECT COUNT(*) total FROM competencies').get().total;
  const result = await requestMonth('/generation-preview?year=2035&month=2', null, 'GET');
  assert.equal(result.status, 200);
  assert.equal(result.data.item.competency.id, null);
  assert.equal(result.data.item.competency.name, 'Fevereiro de 2035');
  assert.equal(result.data.item.action, 'GENERATE');
  assert.equal(result.data.item.expectedDays, 28);
  assert.equal(result.data.item.wings.length, 5);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM competencies').get().total, before);
});

test('the month picker generates exactly the requested month and preserves other scales', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await requestMonth('/generate-month', { year: 2034, month: 12 });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.item.year, 2034);
  assert.equal(response.data.item.month, 12);
  assert.equal(response.data.item.slots_count, 62);
  assert.equal(response.data.generation.action, 'GENERATE');
  assert.equal(response.data.generation.rule.mode, 'CONTINUOUS');
  assert.deepEqual(db.prepare(`SELECT a.* FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE s.competency_id=? ORDER BY a.id`).all(competency.id), before);
});

test('regenerating an existing month requires confirmation before deleting anything', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const response = await requestMonth('/generate-month', { year: 2031, month: 7 });
  assert.equal(response.status, 409);
  assert.match(response.data.message, /Confirme/);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
});

test('selected month regeneration recalculates ordinary duties and keeps extras and columns intact', async () => {
  await importRoster();
  assignment(6, '2031-07-06', 'DIURNO', 'EXTRAORDINARY', 2);
  db.prepare("UPDATE assignments SET display_prefix='ATESTADO' WHERE member_id=1 AND service_type='ORDINARY'").run();
  db.prepare(`INSERT INTO schedule_pdf_column_releases
    (competency_id,service_date,third_column_open,fourth_column_open,updated_by,updated_at) VALUES (?,'2031-07-06',1,1,1,?)`).run(competency.id, stamp);
  db.prepare("UPDATE service_slots SET current_capacity=4 WHERE competency_id=? AND service_date='2031-07-06'").run(competency.id);
  const beforeExtra = db.prepare("SELECT * FROM assignments WHERE service_type='EXTRAORDINARY'").all();
  const beforeColumns = db.prepare('SELECT * FROM schedule_pdf_column_releases').all();
  const preview = await requestMonth('/generation-preview?year=2031&month=7', null, 'GET');
  assert.equal(preview.data.item.annotatedOrdinaryAssignments, 2);
  assert.equal(preview.data.item.extraordinaryAssignments, 1);
  const response = await requestMonth('/generate-month', { year: 2031, month: 7, confirmOrdinaryReset: true });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.generation.action, 'REGENERATE');
  assert.deepEqual(memberDates(1).map((date) => Number(date.slice(-2))), [1, 6, 11, 16, 21, 26, 31]);
  assert.deepEqual(db.prepare("SELECT * FROM assignments WHERE service_type='EXTRAORDINARY'").all(), beforeExtra);
  assert.deepEqual(db.prepare('SELECT * FROM schedule_pdf_column_releases').all(), beforeColumns);
  assert.equal(db.prepare("SELECT current_capacity FROM service_slots WHERE competency_id=? AND service_date='2031-07-06' LIMIT 1").get(competency.id).current_capacity, 4);
});

test('the requested month uses its continuous cycle and permanent swaps instead of restarting on day one', async () => {
  await importRoster();
  assert.equal((await request('/move', { competencyId: competency.id, scope: 'NEXT_MONTH', entries: [memberEntry(1, 2), memberEntry(2, 1)] })).status, 200);
  const preview = await requestMonth('/generation-preview?year=2031&month=8', null, 'GET');
  assert.equal(preview.data.item.rule.mode, 'CONTINUOUS');
  const response = await requestMonth('/generate-month', { year: 2031, month: 8, confirmOrdinaryReset: true });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(memberDates(1, response.data.item.id)[0], '2031-08-01');
  assert.equal(memberDates(2, response.data.item.id)[0], '2031-08-05');
});

test('a homologated ordinary prevents selected month regeneration without data loss', async () => {
  await importRoster();
  db.prepare("UPDATE service_slots SET homologated_at=? WHERE competency_id=? AND service_date='2031-07-01'").run(stamp, competency.id);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  const preview = await requestMonth('/generation-preview?year=2031&month=7', null, 'GET');
  assert.equal(preview.data.item.canGenerate, false);
  assert.equal(preview.data.item.lockedOrdinaryAssignments, 2);
  const response = await requestMonth('/generate-month', { year: 2031, month: 7, confirmOrdinaryReset: true });
  assert.equal(response.status, 409);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
});

test('a failed regeneration rolls back deleted ordinary duties', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  db.exec("CREATE TEMP TRIGGER fail_generation BEFORE INSERT ON assignments BEGIN SELECT RAISE(ABORT, 'isolated generation failure'); END;");
  try {
    assert.throws(() => generateSelectedMonthSchedule({ year: 2031, month: 7, confirmOrdinaryReset: true, userId: 1 }), /isolated generation failure/);
    assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  } finally { db.exec('DROP TRIGGER fail_generation'); }
});

test('month generation rejects invalid months and read-only mutations', async () => {
  assert.equal((await requestMonth('/generation-preview?year=2031&month=13', null, 'GET')).status, 400);
  assert.equal((await requestMonth('/generate-month', { year: 2031, month: 0 })).status, 400);
  assert.equal((await requestMonth('/generate-month', { year: 2031, month: 9 }, 'POST', 'SYSTEM_OPERATOR')).status, 403);
});

test('initial import accepts only the continuous cycle and defaults to it when omitted', async () => {
  const entries = previewWingImport(competency).entries;
  const rejected = await request('/import', { competencyId: competency.id, entries, mode: 'MONTHLY_RESET' });
  assert.equal(rejected.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM wing_cycle_rules').get().total, 0);
  const accepted = await request('/import', { competencyId: competency.id, entries });
  assert.equal(accepted.status, 200);
  assert.equal(cycleRuleForMonth('2031-07-01').mode, 'CONTINUOUS');
});

test('migration converts old reset rules using the initial reference without changing published assignments', async () => {
  await importRoster();
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  // Simulate a database created by the earlier two-mode release, in this isolated test only.
  db.exec(`DROP TRIGGER wing_cycle_continuous_insert; DROP TRIGGER wing_cycle_continuous_update;
    DELETE FROM schema_migrations WHERE version='018_continuous_wings_only';`);
  db.prepare(`INSERT INTO wing_cycle_rules (effective_month,reference_date,mode,updated_by,updated_at)
    VALUES ('2031-08-01','2031-08-01','MONTHLY_RESET',1,?)`).run(stamp);
  assert.equal(runMigrations(), 1);
  assert.deepEqual(db.prepare('SELECT DISTINCT mode,reference_date FROM wing_cycle_rules').all(), [
    { mode: 'CONTINUOUS', reference_date: '2031-07-01' }
  ]);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.throws(() => db.prepare("UPDATE wing_cycle_rules SET mode='MONTHLY_RESET'").run(), /ciclo das alas/);
});
