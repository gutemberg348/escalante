import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-delete-month-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-delete-month-secret';
process.env.ADMIN_EMAIL = 'delete-test@example.com';
process.env.ADMIN_INITIAL_PASSWORD = 'isolated-delete-month-password';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule } = await import('../src/scheduling/monthly.js');
const { default: routes } = await import('../src/modules/competencies/routes.js');
runMigrations();
const stamp = now();
db.prepare("INSERT INTO users (id,name,email,password_hash,role,created_at,updated_at) VALUES (1,'Teste','test@example.com','hash','ADMIN',?,?)").run(stamp, stamp);
db.prepare("INSERT INTO members (id,rank,operational_name,unit_type,created_at,updated_at) VALUES (1,'Sgt','Teste','CICC',?,?)").run(stamp, stamp);
db.prepare("INSERT INTO members (id,rank,operational_name,unit_type,created_at,updated_at) VALUES (2,'Sgt','Extra','CICC',?,?)").run(stamp, stamp);
const wing = db.prepare("SELECT id FROM wings WHERE code='ALA-1'").get();
db.prepare("INSERT INTO wing_cycle_rules (effective_month,reference_date,mode,updated_by,updated_at) VALUES ('2031-01-01','2031-01-01','CONTINUOUS',1,?)").run(stamp);
db.prepare("INSERT INTO wing_memberships (member_id,wing_id,position_number,effective_month,updated_by,updated_at) VALUES (1,?,1,'2031-01-01',1,?)").run(wing.id, stamp);
db.prepare("INSERT INTO ordinary_rotations (member_id,position_number,anchor_date,active,created_at,updated_at) VALUES (1,1,'2031-01-01',1,?,?)").run(stamp, stamp);
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' }; next(); });
app.use('/competencies', routes);
app.use((error, req, res, next) => res.status(error.name === 'ZodError' ? 400 : 500).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/competencies`;
const setting = (key, value) => db.prepare('INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)').run(key, String(value), stamp);
const readSetting = (key) => db.prepare('SELECT value FROM system_settings WHERE key=?').get(key)?.value;
let first;
let second;
async function request(endpoint, method = 'GET', body, role = 'ADMIN') {
  const response = await fetch(`${url}${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const rows = (table) => db.prepare(`SELECT * FROM ${table}`).all();
beforeEach(() => {
  db.exec(`DELETE FROM assignments; DELETE FROM capacity_changes; DELETE FROM bot_passes;
    DELETE FROM schedule_pdf_column_releases; DELETE FROM wing_month_overrides; DELETE FROM service_slots;
    DELETE FROM competencies; DELETE FROM marking_turns; DELETE FROM audit_logs; DELETE FROM system_settings;`);
  first = ensureCompetencySchedule('2031-01-01').competency;
  second = ensureCompetencySchedule('2031-02-01').competency;
  db.prepare('UPDATE competencies SET generated_at=?').run(stamp);
  for (const competency of [first, second]) {
    const slot = db.prepare('SELECT id FROM service_slots WHERE competency_id=? ORDER BY id LIMIT 1').get(competency.id);
    for (const [position, type] of [[1, 'ORDINARY'], [2, 'EXTRAORDINARY']]) {
      db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
        VALUES (?,?,?,?,'CONFIRMED',?,?,?,?)`).run(slot.id, position, position, type, `${competency.id}-${position}`, stamp, stamp, stamp);
    }
    db.prepare("INSERT INTO capacity_changes (service_slot_id,previous_capacity,new_capacity,authority_name,authorization_reference,reason,changed_by,changed_at) VALUES (?,2,3,'Teste','Teste','Teste',1,?)").run(slot.id, stamp);
    db.prepare('INSERT INTO bot_passes (competency_id,member_id,passed_at) VALUES (?,1,?)').run(competency.id, stamp);
    const date = `${competency.year}-${String(competency.month).padStart(2, '0')}-01`;
    db.prepare('INSERT INTO schedule_pdf_column_releases (competency_id,service_date,third_column_open,updated_by,updated_at) VALUES (?,?,1,1,?)').run(competency.id, date, stamp);
    db.prepare('INSERT INTO wing_month_overrides (competency_id,member_id,wing_id,position_number,from_date,updated_by,updated_at) VALUES (?,1,?,1,?,1,?)').run(competency.id, wing.id, date, stamp);
  }
  setting('bot_active_competency_id', first.id);
  setting('bot_marking_round_starts_at', '2031-01-25T06:00:00');
  setting('automation_last_monthly_run', '2031-01');
  setting('bot_pending_month_generation:test:1', JSON.stringify({ target: '2031-01' }));
  setting('bot_pending_month_generation:other:1', JSON.stringify({ target: '2031-02' }));
  db.prepare("INSERT INTO marking_turns (member_id,deadline_at,active,created_by,created_at) VALUES (1,'2031-01-25T08:00:00',1,1,?)").run(stamp);
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const file of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, file), { force: true });
  fs.rmdirSync(directory);
});

test('impact reports the exact selected month without modifying anything', async () => {
  const before = rows('assignments');
  const response = await request(`/${first.id}/deletion-impact`);
  assert.equal(response.status, 200);
  assert.equal(response.data.item.competency.id, first.id);
  assert.equal(response.data.item.assignments, 2);
  assert.equal(response.data.item.ordinaryAssignments, 1);
  assert.equal(response.data.item.extraordinaryAssignments, 1);
  assert.equal(response.data.item.slots, 62);
  assert.equal(response.data.item.activeOnWhatsApp, true);
  assert.deepEqual(rows('assignments'), before);
});

test('deleting a month removes its dependents and preserves other months and permanent roster', async () => {
  const otherSlots = db.prepare('SELECT * FROM service_slots WHERE competency_id=?').all(second.id);
  const otherAssignments = db.prepare('SELECT a.* FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id WHERE s.competency_id=?').all(second.id);
  const preserved = Object.fromEntries(['wing_cycle_rules', 'wing_memberships', 'ordinary_rotations', 'members'].map((table) => [table, rows(table)]));
  const response = await request(`/${first.id}`, 'DELETE', { confirm: true });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.assignments, 2);
  assert.equal(db.prepare('SELECT 1 FROM competencies WHERE id=?').get(first.id), undefined);
  for (const table of ['service_slots', 'bot_passes', 'wing_month_overrides', 'schedule_pdf_column_releases']) {
    assert.equal(db.prepare(`SELECT COUNT(*) total FROM ${table} WHERE competency_id=?`).get(first.id).total, 0);
  }
  assert.deepEqual(db.prepare('SELECT * FROM service_slots WHERE competency_id=?').all(second.id), otherSlots);
  assert.deepEqual(rows('assignments'), otherAssignments);
  assert.equal(rows('capacity_changes').length, 1);
  for (const [table, before] of Object.entries(preserved)) assert.deepEqual(rows(table), before);
  assert.equal(readSetting('bot_active_competency_id'), String(second.id));
  assert.equal(readSetting('bot_marking_round_starts_at'), '');
  assert.equal(rows('marking_turns')[0].active, 0);
  assert.equal(readSetting('automation_last_monthly_run'), '');
  assert.equal(readSetting('bot_pending_month_generation:test:1'), '');
  assert.equal(JSON.parse(readSetting('bot_pending_month_generation:other:1')).target, '2031-02');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const log = db.prepare("SELECT * FROM audit_logs WHERE action='DELETE_MONTH'").get();
  const snapshot = JSON.parse(log.before_json);
  assert.equal(snapshot.competency.id, first.id);
  assert.equal(snapshot.assignments.length, 2);
  assert.equal(snapshot.slots.length, 62);
});

test('deleting a non-active month leaves the current WhatsApp queue intact', async () => {
  const turns = rows('marking_turns');
  const response = await request(`/${second.id}`, 'DELETE', { confirm: true }, 'SCHEDULER');
  assert.equal(response.status, 200);
  assert.equal(readSetting('bot_active_competency_id'), String(first.id));
  assert.deepEqual(rows('marking_turns'), turns);
  assert.equal(readSetting('bot_marking_round_starts_at'), '2031-01-25T06:00:00');
});

test('deleting the last month clears its active selection', async () => {
  assert.equal((await request(`/${second.id}`, 'DELETE', { confirm: true })).status, 200);
  assert.equal((await request(`/${first.id}`, 'DELETE', { confirm: true })).status, 200);
  assert.equal(rows('competencies').length, 0);
  assert.equal(readSetting('bot_active_competency_id'), '');
});

test('missing confirmation, invalid month and read-only roles cannot delete', async () => {
  const before = rows('assignments');
  assert.equal((await request(`/${first.id}`, 'DELETE', {})).status, 400);
  assert.equal((await request(`/${first.id}`, 'DELETE', { confirm: false })).status, 400);
  assert.equal((await request(`/${first.id}`, 'DELETE', { confirm: true }, 'SYSTEM_OPERATOR')).status, 403);
  assert.equal((await request(`/${first.id}/deletion-impact`, 'GET', undefined, 'SYSTEM_OPERATOR')).status, 403);
  assert.equal((await request('/999999', 'DELETE', { confirm: true })).status, 404);
  assert.deepEqual(rows('assignments'), before);
});

test('a failed deletion rolls back assignments, settings and all related records', async () => {
  const tables = ['competencies', 'service_slots', 'assignments', 'capacity_changes', 'bot_passes', 'wing_month_overrides', 'schedule_pdf_column_releases', 'system_settings'];
  const before = Object.fromEntries(tables.map((table) => [table, rows(table)]));
  db.exec("CREATE TEMP TRIGGER fail_month_delete BEFORE DELETE ON competencies BEGIN SELECT RAISE(ABORT, 'isolated deletion failure'); END;");
  try {
    assert.equal((await request(`/${first.id}`, 'DELETE', { confirm: true })).status, 500);
    for (const table of tables) assert.deepEqual(rows(table), before[table]);
    assert.equal(db.prepare("SELECT COUNT(*) total FROM audit_logs WHERE action='DELETE_MONTH'").get().total, 0);
  } finally { db.exec('DROP TRIGGER fail_month_delete'); }
});
