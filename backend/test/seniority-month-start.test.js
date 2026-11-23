import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import dayjs from 'dayjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-seniority-month-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule } = await import('../src/scheduling/monthly.js');
const { startColumnMarkingRound } = await import('../src/messaging/automation.js');
const { buildMarkingSchedule, activeCompetency } = await import('../src/messaging/whatsapp.js');
const { createSeniorityRouter } = await import('../src/modules/seniority/routes.js');
runMigrations();
const stamp = now();
db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(1,'Teste','month-start@example.com','hash','ADMIN',?,?)").run(stamp, stamp);
for (const id of [1, 2]) db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,seniority_position,active,operational_status,authorization_status,created_at,updated_at) VALUES (?,'Sgt',?,'CICC',?,1,'ACTIVE','AUTHORIZED',?,?)").run(id, `Teste ${id}`, id, stamp, stamp);
const november = ensureCompetencySchedule('2031-11-01').competency;
const december = ensureCompetencySchedule('2031-12-01').competency;
db.prepare('UPDATE competencies SET generated_at=?').run(stamp);
let sent; let connected;
const delivery = { getStatus: () => ({ status: connected ? 'CONNECTED' : 'DISCONNECTED' }),
  sendSchedule: async (options) => { const schedule = await buildMarkingSchedule(options); sent.push({ options, text: schedule.text }); return { sent: true }; },
  notify: async () => { sent.push({ memberId: db.prepare('SELECT member_id FROM marking_turns WHERE active=1').get()?.member_id }); return true; } };
const app = express(); app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' }; next(); });
app.use('/seniority', createSeniorityRouter({ startRound: (options) => startColumnMarkingRound(options, delivery) }));
app.use((error, req, res, next) => res.status(error.name === 'ZodError' ? 400 : 500).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/seniority`;
const post = async (body, action = 'start', role = 'ADMIN') => {
  const response = await fetch(`${url}/turn/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const setting = (key, value) => db.prepare('INSERT OR REPLACE INTO system_settings(key,value,updated_at) VALUES (?,?,?)').run(key, String(value), stamp);
const state = () => ({ deadlines: db.prepare('SELECT * FROM marking_deadlines ORDER BY member_id').all(), turns: db.prepare('SELECT * FROM marking_turns ORDER BY id').all(),
  settings: db.prepare('SELECT * FROM system_settings ORDER BY key').all(), slots: db.prepare('SELECT * FROM service_slots ORDER BY id').all() });
beforeEach(() => {
  db.exec("DELETE FROM marking_turns; DELETE FROM marking_deadlines; DELETE FROM system_settings; UPDATE service_slots SET current_capacity=2; UPDATE competencies SET status='DRAFT';");
  db.prepare('UPDATE competencies SET generated_at=?').run(stamp);
  for (const id of [1, 2]) db.prepare('INSERT INTO marking_deadlines(member_id,deadline_at,updated_by,updated_at) VALUES (?,?,1,?)')
    .run(id, dayjs().add(2, 'day').startOf('day').hour(7 + id).toISOString(), stamp);
  setting('bot_active_competency_id', november.id);
  setting('bot_active_selection_month', dayjs().format('YYYY-MM'));
  sent = []; connected = true;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close(); for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, name), { force: true }); fs.rmdirSync(directory); });

test('viewing the page exposes the actual queue month without changing the WhatsApp selection', async () => {
  const before = state();
  const data = await fetch(url).then((response) => response.json());
  assert.equal(data.markingCompetency.id, november.id);
  assert.deepEqual(state(), before);
});

test('starting December publishes its saved cronograma and selects December while preserving dates and roster', async () => {
  const before = state();
  const result = await post({ competencyId: december.id });
  assert.equal(result.status, 201);
  assert.equal(result.data.markingCompetency.id, december.id);
  assert.ok(result.data.message.includes(december.name));
  assert.equal(result.data.markingScheduled, true);
  assert.equal(activeCompetency().id, december.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.competencyId, december.id);
  assert.match(sent[0].text, /ESCALA DE DEZEMBRO/);
  assert.match(sent[0].text, /Sgt Teste 1 — até 08h/);
  assert.deepEqual(state().deadlines, before.deadlines);
  assert.deepEqual(state().slots, before.slots);
  const opened = state();
  assert.equal((await post({ competencyId: november.id })).status, 409);
  assert.deepEqual(state(), opened);
  assert.equal(sent.length, 1);
});

test('start validates roles, month, connection and column before changing the selected month', async () => {
  const before = state();
  for (const role of ['SCHEDULER', 'SYSTEM_OPERATOR', 'APPROVING_AUTHORITY']) assert.equal((await post({ competencyId: december.id }, 'start', role)).status, 403);
  for (const body of [{ competencyId: 0 }, { competencyId: '2' }, { competencyId: december.id, unrelated: true }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ competencyId: 999999 })).status, 404);
  connected = false;
  assert.equal((await post({ competencyId: december.id })).status, 409);
  assert.deepEqual(state(), before);
  connected = true;
  setting('bot_active_marking_column', 4);
  let snapshot = state();
  assert.equal((await post({ competencyId: december.id })).status, 409); assert.deepEqual(state(), snapshot);
  setting('bot_active_marking_column', 2);
  db.prepare("UPDATE competencies SET status='HOMOLOGATED' WHERE id=?").run(december.id);
  snapshot = state();
  assert.equal((await post({ competencyId: december.id })).status, 409); assert.deepEqual(state(), snapshot);
  assert.equal(sent.length, 0);
});

test('a reset cannot silently transfer a running queue to another month', async () => {
  await post({ competencyId: december.id });
  const before = state();
  const result = await post({ startMemberId: 1, competencyId: november.id }, 'reset');
  assert.equal(result.status, 409);
  assert.match(result.data.message, /outro mês/);
  assert.deepEqual(state(), before);
});
