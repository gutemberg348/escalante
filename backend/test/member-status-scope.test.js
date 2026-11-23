import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-status-scope-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule, generateOrdinaryAssignments, generateSelectedMonthSchedule } = await import('../src/scheduling/monthly.js');
const { default: routes } = await import('../src/modules/members/routes.js');
runMigrations();
const stamp = now();
db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES (1,'Teste','status@example.com','hash','ADMIN',?,?)").run(stamp, stamp);
for (const [id, name] of [[1, 'Ferias'], [2, 'Ativo']]) {
  db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,active,operational_status,authorization_status,ordinary_eligible,created_at,updated_at) VALUES (?,'Sgt',?,'CICC',1,'ACTIVE','AUTHORIZED',1,?,?)").run(id, name, stamp, stamp);
  db.prepare("INSERT INTO ordinary_rotations(member_id,position_number,anchor_date,active,created_at,updated_at) VALUES (?,?,'2031-10-30',1,?,?)").run(id, id, stamp, stamp);
}
const { competency } = ensureCompetencySchedule('2031-11-01');
const app = express(); app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' }; next(); });
app.use('/members', routes);
app.use((error, req, res, next) => res.status(error.name === 'ZodError' ? 400 : error.status || 500).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/members/1`;
const patch = async (body, role = 'ADMIN') => {
  const response = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const assignments = () => db.prepare('SELECT * FROM assignments ORDER BY id').all();
const rosterSnapshot = () => Object.fromEntries(['assignments', 'service_slots', 'competencies', 'ordinary_rotations', 'schedule_pdf_column_releases']
  .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const member = () => db.prepare('SELECT * FROM members WHERE id=1').get();
beforeEach(() => {
  db.exec("DELETE FROM assignments; DELETE FROM audit_logs; DELETE FROM service_slots WHERE competency_id IN (SELECT id FROM competencies WHERE month=12); DELETE FROM competencies WHERE month=12; UPDATE members SET operational_status='ACTIVE',active=1; UPDATE service_slots SET status='OPEN',homologated_at=NULL;");
  generateOrdinaryAssignments({ competencyId: competency.id });
  const slot = db.prepare("SELECT id FROM service_slots WHERE competency_id=? AND service_date='2031-11-02' AND period='DIURNO'").get(competency.id);
  db.prepare(`INSERT INTO assignments(service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,2,1,'EXTRAORDINARY','CONFIRMED','status-extra',?,?,?)`).run(slot.id, stamp, stamp, stamp);
});
after(async () => {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, name), { force: true });
  fs.rmdirSync(directory);
});

for (const role of ['ADMIN', 'SCHEDULER']) test(`${role} can put a member on vacation for generation without changing any published service`, async () => {
  const before = rosterSnapshot();
  assert.equal(db.prepare('SELECT id FROM competencies WHERE year=2031 AND month=12').get(), undefined);
  const result = await patch({ operational_status: 'VACATION', active: true, competency_id: competency.id, apply_to_selected_schedule: false }, role);
  assert.equal(result.status, 200);
  assert.equal(result.data.item.operational_status, 'VACATION');
  assert.equal(result.data.item.active, 1);
  assert.equal(result.data.schedulePreserved, true);
  assert.equal(result.data.statusEffect, null);
  assert.deepEqual(rosterSnapshot(), before);
  const audit = db.prepare("SELECT after_json FROM audit_logs WHERE action='UPDATE' AND entity_type='MEMBER'").get();
  assert.equal(JSON.parse(audit.after_json).applyToSelectedSchedule, false);
  const generated = generateSelectedMonthSchedule({ year: 2031, month: 12 });
  const nextId = generated.competency.id;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id WHERE s.competency_id=? AND a.member_id=1 AND a.service_type='ORDINARY'").get(nextId).n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id WHERE s.competency_id=? AND a.member_id=2 AND a.service_type='ORDINARY'").get(nextId).n > 0);
  assert.deepEqual(assignments().filter((item) => before.assignments.some((original) => original.id === item.id)), before.assignments);
  assert.deepEqual(db.prepare('SELECT * FROM service_slots WHERE competency_id=? ORDER BY id').all(competency.id), before.service_slots);
});

test('vacation for upcoming generation also works without selecting any generated month', async () => {
  const before = rosterSnapshot();
  const result = await patch({ operational_status: 'VACATION', apply_to_selected_schedule: false });
  assert.equal(result.status, 200);
  assert.equal(member().operational_status, 'VACATION');
  assert.equal(result.data.competency, null);
  assert.deepEqual(rosterSnapshot(), before);
});

for (const explicit of [true, false]) test(`applying vacation to the selected month ${explicit ? 'explicitly' : 'with the legacy default'} removes only its ordinaries`, async () => {
  const preserved = assignments().filter((item) => item.member_id !== 1 || item.service_type !== 'ORDINARY');
  const result = await patch({ operational_status: 'VACATION', competency_id: competency.id, ...(explicit ? { apply_to_selected_schedule: true } : {}) });
  assert.equal(result.status, 200);
  assert.equal(result.data.schedulePreserved, false);
  assert.ok(result.data.statusEffect.ordinaryAssignmentsRemoved > 0);
  assert.deepEqual(assignments(), preserved);
});

test('returning to active can preserve the selected roster or explicitly regenerate it', async () => {
  await patch({ operational_status: 'VACATION', competency_id: competency.id, apply_to_selected_schedule: true });
  const before = rosterSnapshot();
  const result = await patch({ operational_status: 'ACTIVE', competency_id: competency.id, apply_to_selected_schedule: false });
  assert.equal(result.status, 200);
  assert.equal(result.data.statusEffect, null);
  assert.deepEqual(rosterSnapshot(), before);
  await patch({ operational_status: 'VACATION', competency_id: competency.id, apply_to_selected_schedule: false });
  const extra = assignments().find((item) => item.protocol === 'status-extra');
  const applied = await patch({ operational_status: 'ACTIVE', competency_id: competency.id, apply_to_selected_schedule: true });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.statusEffect.type, 'REGENERATED_ON_REACTIVATION');
  assert.ok(assignments().some((item) => item.member_id === 1 && item.service_type === 'ORDINARY'));
  assert.deepEqual(assignments().find((item) => item.protocol === 'status-extra'), extra);
});

test('invalid scope, nonexistent selection and unauthorized roles write nothing', async () => {
  const before = rosterSnapshot(); const originalMember = member();
  for (const value of ['false', 'future', 0, null]) assert.equal((await patch({ operational_status: 'VACATION', apply_to_selected_schedule: value })).status, 400);
  assert.equal((await patch({ operational_status: 'VACATION', apply_to_selected_schedule: false, competency_id: 999999 })).status, 404);
  for (const role of ['SYSTEM_OPERATOR', 'APPROVING_AUTHORITY']) assert.equal((await patch({ operational_status: 'VACATION', apply_to_selected_schedule: false }, role)).status, 403);
  assert.deepEqual(member(), originalMember);
  assert.deepEqual(rosterSnapshot(), before);
});
