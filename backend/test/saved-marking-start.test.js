import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dayjs from 'dayjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-saved-queue-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule } = await import('../src/scheduling/monthly.js');
const { startColumnMarkingRound } = await import('../src/messaging/automation.js');
runMigrations();
const stamp = now();
db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(1,'Teste','saved-start@example.com','hash','ADMIN',?,?)").run(stamp, stamp);
for (const id of [1, 2, 3]) db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,seniority_position,active,operational_status,authorization_status,created_at,updated_at) VALUES (?,'Sgt',?,'CICC',?,1,'ACTIVE','AUTHORIZED',?,?)").run(id, `Teste ${id}`, id, stamp, stamp);
const { competency } = ensureCompetencySchedule(dayjs().add(1, 'month').startOf('month'));
db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp, competency.id);
const set = (key, value) => db.prepare('INSERT OR REPLACE INTO system_settings(key,value,updated_at) VALUES (?,?,?)').run(key, String(value), stamp);
const deadline = (id, date) => db.prepare('INSERT OR REPLACE INTO marking_deadlines(member_id,deadline_at,updated_by,updated_at) VALUES (?,?,1,?)').run(id, date.toISOString(), stamp);
let sent;
const delivery = { getStatus: () => ({ status: 'CONNECTED' }), sendSchedule: async (options) => { sent.push(['schedule', options]); return { sent: true }; },
  notify: async () => { sent.push(['notify', db.prepare('SELECT member_id FROM marking_turns WHERE active=1').get()?.member_id]); return true; } };
const start = (options = {}, transport = delivery) => startColumnMarkingRound({ competencyId: competency.id, column: 2, useSavedSchedule: true, ...options }, transport);
const state = () => ({ deadlines: db.prepare('SELECT * FROM marking_deadlines ORDER BY member_id').all(), turns: db.prepare('SELECT * FROM marking_turns ORDER BY id').all(), settings: db.prepare('SELECT * FROM system_settings ORDER BY key').all() });
beforeEach(() => {
  db.exec("DELETE FROM marking_turns; DELETE FROM marking_deadlines; DELETE FROM system_settings; UPDATE members SET operational_status='ACTIVE',active=1,authorization_status='AUTHORIZED'; UPDATE service_slots SET current_capacity=2;");
  for (const id of [1, 2, 3]) deadline(id, dayjs().add(2, 'day').startOf('day').hour(7 + id));
  set('bot_active_competency_id', competency.id); sent = [];
});
after(() => { db.close(); for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, name), { force: true }); fs.rmdirSync(directory); });

test('starts with the saved column/date/order, schedules 06h and never rebases saved deadlines', async () => {
  const before = state().deadlines;
  const result = await start();
  assert.equal(result.started, true); assert.equal(result.scheduled, true);
  assert.equal(result.startsAt, dayjs(before[0].deadline_at).startOf('day').hour(6).toISOString());
  assert.deepEqual(state().deadlines, before);
  assert.equal(db.prepare('SELECT member_id FROM marking_turns WHERE active=1').get().member_id, 1);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'schedule');
});

test('a schedule already in its open window immediately calls the first member with time remaining', async () => {
  const lastDate = dayjs().hour() >= 6 ? dayjs().startOf('day').hour(23).minute(59).second(59) : dayjs().subtract(1, 'day').startOf('day').hour(23).minute(59).second(59);
  deadline(1, lastDate.subtract(3, 'hour')); deadline(2, lastDate.subtract(2, 'hour')); deadline(3, lastDate);
  const expected = state().deadlines.find((item) => dayjs(item.deadline_at).isAfter(dayjs()));
  if (!expected) {
    const before = state(); assert.equal((await start()).started, false); assert.deepEqual(state(), before); return;
  }
  const before = state().deadlines;
  const result = await start();
  assert.equal(result.started, true); assert.equal(result.scheduled, false);
  assert.deepEqual(state().deadlines, before);
  assert.deepEqual(sent.at(-1), ['notify', expected.member_id]);
});

test('leave participates in the saved queue ahead of a member on vacation', async () => {
  db.prepare("UPDATE members SET operational_status='LEAVE' WHERE id=1").run();
  db.prepare("UPDATE members SET operational_status='VACATION' WHERE id=2").run();
  db.prepare('DELETE FROM marking_deadlines WHERE member_id=3').run();
  assert.equal((await start()).started, true);
  assert.equal(db.prepare('SELECT member_id FROM marking_turns WHERE active=1').get().member_id, 1);
});

test('missing, expired, reversed or multiple-date schedules write nothing', async () => {
  const initial = state().deadlines;
  const restore = () => { db.exec('DELETE FROM marking_deadlines'); for (const item of initial) deadline(item.member_id, dayjs(item.deadline_at)); };
  for (const modify of [
    () => db.exec('DELETE FROM marking_deadlines'),
    () => { for (const id of [1, 2, 3]) deadline(id, dayjs().subtract(1, 'day').startOf('day').hour(7 + id)); },
    () => deadline(2, dayjs(initial[0].deadline_at).subtract(1, 'hour')),
    () => deadline(3, dayjs(initial[2].deadline_at).add(1, 'day')),
    () => deadline(1, dayjs(initial[0].deadline_at).startOf('day').hour(5))
  ]) {
    restore(); modify(); const before = state();
    assert.equal((await start()).started, false); assert.deepEqual(state(), before); assert.deepEqual(sent, []);
  }
});

test('a running queue, disconnected transport and closed column do not reset the saved schedule', async () => {
  let before = state();
  assert.equal((await start({}, { ...delivery, getStatus: () => ({ status: 'DISCONNECTED' }) })).started, false); assert.deepEqual(state(), before);
  assert.equal((await start({ column: 4 })).started, false); assert.deepEqual(state(), before);
  assert.equal((await start({ column: 7 })).started, false); assert.deepEqual(state(), before);
  await start(); before = state(); const count = sent.length;
  assert.equal((await start()).started, false); assert.deepEqual(state(), before); assert.equal(sent.length, count);
});

test('a publication failure reports the opened queue without pretending the start failed', async () => {
  const result = await start({}, { ...delivery, sendSchedule: async () => { throw new Error('simulated delivery failure'); } });
  assert.equal(result.started, true); assert.equal(result.scheduleSent, false);
  assert.equal(db.prepare('SELECT member_id FROM marking_turns WHERE active=1').get().member_id, 1);
});
