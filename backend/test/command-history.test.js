import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-undo-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule, generateSelectedMonthSchedule } = await import('../src/scheduling/monthly.js');
const { recordWhatsAppCommand, undoLastWhatsAppCommand, isUndoCommand } = await import('../src/messaging/command-history.js');
runMigrations();
const stamp = now();
db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES (1,'Teste','undo@example.com','hash','ADMIN',?,?)").run(stamp, stamp);
for (const id of [1, 2, 3]) db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,created_at,updated_at) VALUES (?,'Sgt',?,'CICC',?,?)").run(id, `Teste ${id}`, stamp, stamp);
const { competency } = ensureCompetencySchedule('2030-11-01');
db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp, competency.id);
const slots = db.prepare('SELECT * FROM service_slots WHERE competency_id=? ORDER BY service_date,period').all(competency.id);
const groupJid = 'test@g.us';
let sequence = 0;
const record = (callback, options = {}) => recordWhatsAppCommand({ groupJid, actorMemberId: 1, messageId: `test-${++sequence}`, commandText: 'marcar dia 1 dia', ...options }, callback);
const undo = (options = {}) => undoLastWhatsAppCommand({ groupJid, actorMemberId: 1, ...options });
const add = (slot = slots[0], position = 1, member = 1) => Number(db.prepare(`INSERT INTO assignments(service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
  VALUES (?,?,?,'EXTRAORDINARY','CONFIRMED',?,?,?,?)`).run(slot.id, position, member, `undo-${++sequence}`, stamp, stamp, stamp).lastInsertRowid);
beforeEach(() => {
  db.exec(`DELETE FROM whatsapp_command_history; DELETE FROM assignments; DELETE FROM marking_turns;
    DELETE FROM bot_passes; DELETE FROM schedule_pdf_column_releases; DELETE FROM system_settings;
    UPDATE service_slots SET current_capacity=2,status='OPEN'; UPDATE members SET active=1,operational_status='ACTIVE',monthly_hour_limit=NULL;`);
});
after(() => {
  db.close();
  for (const name of ['test.sqlite','test.sqlite-wal','test.sqlite-shm']) fs.rmSync(path.join(directory,name), { force:true });
  fs.rmdirSync(directory);
});

test('undo aliases recognize accents, slash and action variants without matching ordinary sentences', () => {
  for (const phrase of ['/desfazer', 'desfaz', 'desfaça', 'última forma', 'ultima forma!', '/desfazer ultima acao', 'desfaz a última marcação', 'desfazer último comando', 'desfazer ultima mudança']) assert.equal(isUndoCommand(phrase), true, phrase);
  for (const phrase of ['marcar dia 20', 'minha ultima forma foi essa', 'desfazer dia 20']) assert.equal(isUndoCommand(phrase), false, phrase);
});
test('queries and no-op commands leave the previous action available; undo is sequential', async () => {
  await record(() => add());
  await record(() => add(slots[1]));
  await record(() => null, { commandText: '/status' });
  await record(() => null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_command_history').get().n, 2);
  assert.ok(undo().commandId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 1);
  assert.ok(undo().commandId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 0);
  assert.match(undo().text, /não tem alteração/);
});
test('a multi-row command restores deleted and updated records together', async () => {
  const first = add(), second = add(slots[1], 2, 2);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  await record(() => { db.prepare('DELETE FROM assignments WHERE id=?').run(first); db.prepare("UPDATE assignments SET display_prefix='ATESTADO' WHERE id=?").run(second); });
  assert.ok(undo().commandId);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
});

test('month feedback uses the changed assignments rather than a different fallback month and preserves TEXT metadata', async () => {
  const payload = { type: 'TEXT', text: 'Serviço retirado.', mentions: ['test@s.whatsapp.net'], pdf: { fileName: 'test.pdf' } };
  const id = add();
  const result = await record(() => { db.prepare('DELETE FROM assignments WHERE id=?').run(id); return payload; },
    { reportChangedMonths: true, fallbackCompetencyId: 999999 });
  assert.equal(result.text, `${payload.text}\n\n*Mês alterado: ${competency.name}*`);
  assert.deepEqual(result.mentions, payload.mentions);
  assert.deepEqual(result.pdf, payload.pdf);
  assert.equal(await record(() => 'Nada foi alterado.', { reportChangedMonths: true, fallbackCompetencyId: competency.id }), 'Nada foi alterado.');
  assert.deepEqual(undo().competencyNames, [competency.name]);
});
test('swaps restore unique positions by reversing their intermediate steps', async () => {
  const a = add(), b = add(slots[0], 2, 2);
  await record(() => db.transaction(() => {
    db.prepare('UPDATE assignments SET position_number=-1 WHERE id=?').run(a);
    db.prepare('UPDATE assignments SET position_number=1 WHERE id=?').run(b);
    db.prepare('UPDATE assignments SET position_number=2 WHERE id=?').run(a);
  })());
  assert.ok(undo().commandId);
  assert.deepEqual(db.prepare('SELECT id,position_number FROM assignments ORDER BY id').all(), [{id:a,position_number:1},{id:b,position_number:2}]);
});
test('sender, group and current permissions bound every undo', async () => {
  await record(() => add(), { permission:'PANEL_ADMIN' });
  assert.equal(undo({actorMemberId:2}).commandId, undefined);
  assert.equal(undo({groupJid:'elsewhere@g.us',panelAdministrator:true}).commandId, undefined);
  assert.match(undo().text, /permissão/);
  assert.ok(undo({panelAdministrator:true}).commandId);
});
test('later edits of one affected row prevent all restoration atomically', async () => {
  let id;
  await record(() => { id = add(); add(slots[1]); });
  db.prepare("UPDATE assignments SET display_prefix='outra pessoa editou' WHERE id=?").run(id);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  assert.equal(undo().commandId, undefined);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT undone_at FROM whatsapp_command_history').get().undone_at, null);
});
test('an occupied restored vacancy rolls back every earlier inverse statement', async () => {
  const original = add();
  await record(() => { db.prepare('DELETE FROM assignments WHERE id=?').run(original); add(slots[1]); });
  add(slots[0], 1, 2);
  const before = db.prepare('SELECT * FROM assignments ORDER BY id').all();
  assert.equal(undo().commandId, undefined);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), before);
});
test('a later booking in an opened column prevents closing it through undo', async () => {
  await record(() => db.prepare('UPDATE service_slots SET current_capacity=4 WHERE id=?').run(slots[0].id));
  add(slots[0], 4, 2);
  assert.equal(undo().commandId, undefined);
  assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(slots[0].id).current_capacity, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 1);
});
test('homologation prevents restoring a removed assignment', async () => {
  const id=add();
  await record(() => db.prepare('DELETE FROM assignments WHERE id=?').run(id));
  db.prepare("UPDATE service_slots SET status='HOMOLOGATED' WHERE id=?").run(slots[0].id);
  assert.equal(undo().commandId, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 0);
});
test('undo cannot restore extras for a now inactive member or above a new hour limit', async () => {
  const id=add();
  await record(()=>db.prepare('DELETE FROM assignments WHERE id=?').run(id));
  db.prepare("UPDATE members SET operational_status='LEAVE' WHERE id=1").run();
  assert.equal(undo().commandId,undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);
  db.prepare("UPDATE members SET operational_status='ACTIVE',monthly_hour_limit=12 WHERE id=1").run();
  add(slots[2]);
  assert.equal(undo().commandId,undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n,1);
});
test('undo of a new month preserves it if a later booking depends on that month', async () => {
  let created;
  await record(()=>{created=ensureCompetencySchedule('2031-12-01').competency;db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp,created.id);}, {permission:'PANEL_ADMIN',commandText:'gerar escala 2031-12'});
  const slot=db.prepare('SELECT * FROM service_slots WHERE competency_id=? LIMIT 1').get(created.id);
  add(slot,1,2);
  assert.equal(undo({panelAdministrator:true}).commandId,undefined);
  assert.ok(db.prepare('SELECT id FROM competencies WHERE id=?').get(created.id));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments WHERE service_slot_id=?').get(slot.id).n,1);
});
test('generation can be undone with its slots, ordinários and rotation changes', async () => {
  const rotations = db.prepare('SELECT * FROM ordinary_rotations ORDER BY member_id').all();
  let generated;
  await record(() => { generated = generateSelectedMonthSchedule({year:2032,month:12,userId:1}); }, {permission:'PANEL_ADMIN',commandText:'gerar escala 2032-12'});
  const target = db.prepare('SELECT id FROM competencies WHERE year=2032 AND month=12').get();
  assert.ok(target);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM service_slots WHERE competency_id=?').get(target.id).n);
  assert.ok(undo({panelAdministrator:true}).commandId);
  assert.equal(db.prepare('SELECT id FROM competencies WHERE id=?').get(target.id), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM ordinary_rotations ORDER BY member_id').all(),rotations);
});
test('an in-flight command cannot make undo silently pick an older action', async () => {
  await record(()=>add());
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const pending=record(async()=>{add(slots[1]);await waiting;});
  assert.match(undo().text,/ainda não terminou/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n,2);
  release();await pending;
  assert.ok(undo().commandId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n,1);
});
test('unrelated HTTP writes and simultaneous async commands are never attributed to another sender', async () => {
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const pending=record(async()=>{add();await waiting;add(slots[1]);});
  add(slots[2],1,3); // unrelated write outside the async command context
  await record(()=>add(slots[3],1,2),{actorMemberId:2});
  release();await pending;
  assert.ok(undo().commandId);
  assert.deepEqual(db.prepare('SELECT service_slot_id,member_id FROM assignments ORDER BY id').all(), [{service_slot_id:slots[2].id,member_id:3},{service_slot_id:slots[3].id,member_id:2}]);
});
test('history survives a separate process with a fresh SQLite connection', async () => {
  await record(()=>add());
  const moduleUrl=new URL('../src/messaging/command-history.js',import.meta.url).href;
  const result=execFileSync(process.execPath,['--input-type=module','-e',`const {undoLastWhatsAppCommand}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(undoLastWhatsAppCommand({groupJid:'test@g.us',actorMemberId:1})));`],{env:process.env,encoding:'utf8'});
  assert.ok(JSON.parse(result.trim()).commandId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n,0);
});
