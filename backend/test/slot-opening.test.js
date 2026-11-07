import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import express from 'express';

// Exercise real HTTP handlers and PDF generation against an isolated database.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-slot-opening-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule } = await import('../src/scheduling/monthly.js');
const { default: routes } = await import('../src/modules/service-slots/routes.js');
runMigrations();
const stamp = now();
db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES (1,'Teste','opening@example.com','hash','ADMIN',?,?)").run(stamp, stamp);
db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,created_at,updated_at) VALUES (1,'Sgt','Teste','CICC',?,?)").run(stamp, stamp);
db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,created_at,updated_at) VALUES (2,'Sgt','Outro','CICC',?,?)").run(stamp, stamp);
const { competency } = ensureCompetencySchedule('2031-11-01');
const { competency: otherMonth } = ensureCompetencySchedule('2031-12-01');
db.prepare('UPDATE competencies SET generated_at=?').run(stamp);
const slot = db.prepare("SELECT * FROM service_slots WHERE competency_id=? AND service_date='2031-11-13' AND period='DIURNO'").get(competency.id);
const night = db.prepare("SELECT * FROM service_slots WHERE competency_id=? AND service_date=? AND period='NOTURNO'").get(competency.id, slot.service_date);
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' }; next(); });
app.use('/slots', routes);
app.use((error, req, res, next) => res.status(error.name === 'ZodError' ? 400 : 500).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/slots`;
const open = async (position = 3, role = 'ADMIN', id = slot.id, body = { competencyId: competency.id }) => {
  const response = await fetch(`${url}/${id}/positions/${position}/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
};
const close = async (position = 3, role = 'ADMIN', id = slot.id, body = { competencyId: competency.id }) => {
  const response = await fetch(`${url}/${id}/positions/${position}/close`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
};
const slots = () => db.prepare('SELECT * FROM service_slots ORDER BY id').all();
beforeEach(() => {
  db.exec("DELETE FROM assignments; DELETE FROM audit_logs; DELETE FROM schedule_pdf_column_releases; UPDATE service_slots SET current_capacity=2,status='OPEN',homologated_at=NULL; UPDATE competencies SET status='OPEN';");
  db.prepare('UPDATE competencies SET generated_at=?').run(stamp);
  db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,2,1,'ORDINARY','CONFIRMED','opening-test',?,?,?)`).run(slot.id, stamp, stamp, stamp);
});
after(async () => {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, name), { force: true });
  fs.rmdirSync(directory);
});

for (const role of ['ADMIN', 'SCHEDULER']) test(`${role} opens only the selected date, shift and column, preserving assignments`, async () => {
  const before = slots();
  const assignments = db.prepare('SELECT * FROM assignments').all();
  const result = await open(3, role);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.openedPositions, [3]);
  assert.equal(result.data.competencyName, competency.name);
  assert.equal(result.data.item.current_capacity, 3);
  assert.deepEqual(slots().filter((item) => item.id !== slot.id), before.filter((item) => item.id !== slot.id));
  assert.deepEqual(db.prepare('SELECT * FROM assignments').all(), assignments);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schedule_pdf_column_releases').get().n, 0);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='MANUAL_SLOT_POSITION_OPEN'").get();
  assert.equal(JSON.parse(audit.before_json).current_capacity, 2);
  assert.equal(JSON.parse(audit.after_json).current_capacity, 3);
  const managed = await fetch(`${url}/manage?competency_id=${competency.id}`).then((r) => r.json());
  assert.equal(managed.items.find((item) => item.id === slot.id).current_capacity, 3);
  assert.equal(managed.items.find((item) => item.id === night.id).current_capacity, 2);
});

test('opening the fourth column includes the third only in that shift and repeats never close columns', async () => {
  const before = slots();
  assert.deepEqual((await open(4)).data.openedPositions, [3, 4]);
  const opened = slots();
  assert.deepEqual((await open(3)).data.openedPositions, []);
  assert.deepEqual((await open(4)).data.openedPositions, []);
  assert.deepEqual(slots(), opened);
  assert.deepEqual(opened.filter((item) => item.id !== slot.id), before.filter((item) => item.id !== slot.id));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='MANUAL_SLOT_POSITION_OPEN'").get().n, 1);
});

test('other roles and invalid or mismatched requests cannot open a vacancy', async () => {
  const before = slots();
  for (const role of ['SYSTEM_OPERATOR', 'APPROVING_AUTHORITY']) assert.equal((await open(3, role)).status, 403);
  for (const position of [0, 1, 2, 5, 'invalid']) assert.equal((await open(position)).status, 400);
  assert.equal((await open(3, 'ADMIN', 999999)).status, 404);
  for (const body of [{}, { competencyId: '1' }, { competencyId: competency.id, current_capacity: 4 }]) assert.equal((await open(3, 'ADMIN', slot.id, body)).status, 400);
  assert.equal((await open(3, 'ADMIN', slot.id, { competencyId: otherMonth.id })).status, 409);
  assert.deepEqual(slots(), before);
});

test('closed or homologated slots and ungenerated or homologated months reject opening', async () => {
  for (const statement of [
    "UPDATE service_slots SET status='CLOSED' WHERE id=?",
    "UPDATE service_slots SET status='OPEN',homologated_at='2031-11-01' WHERE id=?"
  ]) {
    db.prepare(statement).run(slot.id);
    assert.equal((await open()).status, 409);
    assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(slot.id).current_capacity, 2);
  }
  db.prepare("UPDATE service_slots SET status='OPEN',homologated_at=NULL WHERE id=?").run(slot.id);
  db.prepare("UPDATE competencies SET status='HOMOLOGATED' WHERE id=?").run(competency.id);
  assert.equal((await open()).status, 409);
  db.prepare("UPDATE competencies SET status='OPEN',generated_at=NULL WHERE id=?").run(competency.id);
  assert.equal((await open()).status, 409);
});

// PDFKit emits text as hexadecimal strings inside compressed content streams.
// Count actual labels in the rendered document without altering its layout.
const pdfLabels = async () => {
  const response = await fetch(`${url}/pdf?competency_id=${competency.id}`);
  assert.equal(response.status, 200);
  const pdf = Buffer.from(await response.arrayBuffer()).toString('latin1');
  return [...pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap((match) => {
    try { return [...inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1').matchAll(/<([0-9a-f]+)>/gi)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')); }
    catch { return []; }
  }).join('');
};

test('the PDF opens only one cell and day-wide controls report columns open in both shifts', async () => {
  const before = await pdfLabels();
  assert.ok(before.includes('TRANCADA'));
  const count = (text, word) => text.split(word).length - 1;
  await open(3);
  const after = await pdfLabels();
  assert.equal(count(after, 'TRANCADA'), count(before, 'TRANCADA') - 1);
  assert.equal(count(after, 'VAGA'), count(before, 'VAGA') + 1);
  let dayColumns = await fetch(`${url}/pdf-columns?competency_id=${competency.id}`).then((r) => r.json());
  assert.deepEqual(dayColumns.item.items.find((item) => item.serviceDate === slot.service_date).openColumns, [1, 2]);
  await open(3, 'ADMIN', night.id);
  dayColumns = await fetch(`${url}/pdf-columns?competency_id=${competency.id}`).then((r) => r.json());
  assert.deepEqual(dayColumns.item.items.find((item) => item.serviceDate === slot.service_date).openColumns, [1, 2, 3]);
});

test('day-wide opening and closing still apply to both shifts after an individual opening', async () => {
  await open(4);
  for (const openColumns of [[1, 2, 3, 4], [1, 2]]) {
    const response = await fetch(`${url}/pdf-columns`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competencyId: competency.id, items: [{ serviceDate: slot.service_date, openColumns }] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(db.prepare('SELECT DISTINCT current_capacity FROM service_slots WHERE competency_id=? AND service_date=?').all(competency.id, slot.service_date), [{ current_capacity: openColumns.length }]);
  }
});

for (const role of ['ADMIN', 'SCHEDULER']) test(`${role} closes only an empty cell in the selected shift, preserving assignments and other dates`, async () => {
  await open(4);
  await open(4, 'ADMIN', night.id);
  const before = slots();
  const assignments = db.prepare('SELECT * FROM assignments').all();
  const result = await close(4, role);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.closedPositions, [4]);
  assert.equal(result.data.item.current_capacity, 3);
  assert.equal(result.data.competencyName, competency.name);
  assert.deepEqual(slots().filter((item) => item.id !== slot.id), before.filter((item) => item.id !== slot.id));
  assert.deepEqual(db.prepare('SELECT * FROM assignments').all(), assignments);
  assert.deepEqual((await close(4, role)).data.closedPositions, []);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='MANUAL_SLOT_POSITION_CLOSE'").get();
  assert.equal(JSON.parse(audit.before_json).current_capacity, 4);
  assert.equal(JSON.parse(audit.after_json).current_capacity, 3);
  await open(4);
  assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(slot.id).current_capacity, 4);
});

test('closing the third also closes the empty fourth, leaving the other shift open', async () => {
  await open(4);
  await open(4, 'ADMIN', night.id);
  const result = await close(3);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.closedPositions, [3, 4]);
  assert.equal(result.data.item.current_capacity, 2);
  assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(night.id).current_capacity, 4);
});

test('a booking made before confirming prevents closing it or any column it depends on, with no partial writes', async () => {
  for (const position of [3, 4]) {
    await open(4);
    db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
      VALUES (?,?,2,'EXTRAORDINARY','CONFIRMED',?,?,?,?)`).run(slot.id, position, `occupied-${position}`, stamp, stamp, stamp);
    const before = slots();
    const assignments = db.prepare('SELECT * FROM assignments ORDER BY id').all();
    const result = await close(position);
    assert.equal(result.status, 409);
    assert.match(result.data.message, /vagas vazias/);
    assert.equal((await close(3)).status, 409);
    assert.deepEqual(slots(), before);
    assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), assignments);
    db.prepare("DELETE FROM assignments WHERE protocol=?").run(`occupied-${position}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='MANUAL_SLOT_POSITION_CLOSE'").get().n, 0);
});

test('closing the empty fourth preserves an occupied third and ignores cancelled assignments', async () => {
  await open(4);
  db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,3,2,'EXTRAORDINARY','CONFIRMED','keep-third',?,?,?)`).run(slot.id, stamp, stamp, stamp);
  db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,4,1,'EXTRAORDINARY','CANCELLED','old-fourth',?,?,?)`).run(slot.id, stamp, stamp, stamp);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  assert.equal((await close(4)).status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
});

test('close enforces permissions, month, column range and slot/month state', async () => {
  await open(4);
  const before = slots();
  for (const role of ['SYSTEM_OPERATOR', 'APPROVING_AUTHORITY']) assert.equal((await close(4, role)).status, 403);
  for (const position of [0, 1, 2, 5, 'invalid']) assert.equal((await close(position)).status, 400);
  assert.equal((await close(4, 'ADMIN', 999999)).status, 404);
  for (const body of [{}, { competencyId: '1' }, { competencyId: competency.id, deleteOccupied: true }]) assert.equal((await close(4, 'ADMIN', slot.id, body)).status, 400);
  assert.equal((await close(4, 'ADMIN', slot.id, { competencyId: otherMonth.id })).status, 409);
  assert.deepEqual(slots(), before);
  db.prepare("UPDATE service_slots SET status='CLOSED' WHERE id=?").run(slot.id);
  assert.equal((await close(4)).status, 409);
  db.prepare("UPDATE service_slots SET status='OPEN',homologated_at=? WHERE id=?").run(stamp, slot.id);
  assert.equal((await close(4)).status, 409);
  db.prepare('UPDATE service_slots SET homologated_at=NULL WHERE id=?').run(slot.id);
  db.prepare("UPDATE competencies SET status='HOMOLOGATED' WHERE id=?").run(competency.id);
  assert.equal((await close(4)).status, 409);
  db.prepare("UPDATE competencies SET status='OPEN',generated_at=NULL WHERE id=?").run(competency.id);
  assert.equal((await close(4)).status, 409);
  assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(slot.id).current_capacity, 4);
});

test('the PDF restores only the closed cell label while the other shift stays open', async () => {
  await open(4);
  await open(4, 'ADMIN', night.id);
  const before = await pdfLabels();
  await close(4);
  const after = await pdfLabels();
  const count = (text, word) => text.split(word).length - 1;
  assert.equal(count(after, 'TRANCADA'), count(before, 'TRANCADA') + 1);
  assert.equal(count(after, 'VAGA'), count(before, 'VAGA') - 1);
  assert.equal(count(after, 'Sgt Teste'), count(before, 'Sgt Teste'));
});
