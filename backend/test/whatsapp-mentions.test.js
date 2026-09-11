import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import only after selecting an isolated database. Never use the real roster/session.
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-mentions-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-test-session-secret';
process.env.ADMIN_EMAIL = 'test@example.com';
process.env.ADMIN_INITIAL_PASSWORD = 'isolated-test-password';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule } = await import('../src/scheduling/monthly.js');
const { handleIncomingMessages, parseNaturalChoices } = await import('../src/messaging/whatsapp.js');
runMigrations();

const group = '120000000000001@g.us';
const bot = '5511991111111@s.whatsapp.net';
const sender = '5511992222222@s.whatsapp.net';
const alex = '5511993333333@s.whatsapp.net';
const other = '5511994444444@s.whatsapp.net';
const lid = '214000000000018@lid';
const stamp = now();
const add = db.prepare(`INSERT INTO members (id,rank,operational_name,phone_number,whatsapp_jid,unit_type,created_at,updated_at)
  VALUES (?,'Sgt',?,?,?,'CICC',?,?)`);
add.run(1, 'Remetente', sender.split('@')[0], sender, stamp, stamp);
add.run(18, 'Alex', alex.split('@')[0], alex, stamp, stamp);
add.run(19, 'Outro', other.split('@')[0], other, stamp, stamp);
const futureYear = new Date().getFullYear() + 1;
const { competency } = ensureCompetencySchedule(`${futureYear}-09-01`);
db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp, competency.id);
const setting = db.prepare('INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)');
setting.run('whatsapp_group_jids', JSON.stringify([group]), stamp);
setting.run('bot_active_competency_id', String(competency.id), stamp);

let sequence = 0;
let replies;
let socket;
beforeEach(() => {
  db.exec('DELETE FROM assignments; DELETE FROM processed_messages; DELETE FROM whatsapp_messages; DELETE FROM member_whatsapp_identities;');
  db.prepare("UPDATE members SET active=1,operational_status='ACTIVE',authorization_status='AUTHORIZED'").run();
  replies = [];
  socket = {
    user: { id: bot, lid: '212000000000001@lid' },
    signalRepository: { lidMapping: { getPNForLID: async (value) => value === lid ? alex : null } },
    groupMetadata: async () => ({ participants: [] }),
    sendMessage: async (_group, payload) => { replies.push(payload); return { key: { id: `out-${++sequence}` } }; }
  };
});
after(() => {
  db.close();
  // Remove only this test's known file names inside its own temporary directory.
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) {
    fs.rmSync(path.join(testDirectory, name), { force: true });
  }
  fs.rmdirSync(testDirectory);
});

async function receive(text, mentionedJid = [bot, alex], extraContext = {}) {
  await handleIncomingMessages(socket, { messages: [{
    key: { id: `in-${++sequence}`, remoteJid: group, participant: sender, fromMe: false },
    message: { extendedTextMessage: { text, contextInfo: { mentionedJid, ...extraContext } } }
  }] });
}
function assignedIds() {
  return db.prepare("SELECT member_id FROM assignments WHERE status='CONFIRMED' ORDER BY service_slot_id").all().map(row => row.member_id);
}
const phrase = '@Escalante marque @Alex Bombeiro no dia 20, 24 horas';

test('direct PN mention records both shifts for Alex, never the sender', async () => {
  await receive(`@${bot.split('@')[0]} marque @${alex.split('@')[0]} no dia 20, 24 horas`);
  assert.deepEqual(assignedIds(), [18, 18]);
  assert.match(replies[0].text, /ALEX/);
});
test('direct LID mention resolves the registered phone', async () => {
  await receive(`@${bot.split('@')[0]} marque @${lid.split('@')[0]} no dia 20, 24 horas`, [bot, lid]);
  assert.deepEqual(assignedIds(), [18, 18]);
});
test('an explicit request for Alex takes precedence over a quoted request from sender', async () => {
  await receive(phrase, [bot, alex], { participant: sender, quotedMessage: { conversation: 'dia 20, 24 horas' } });
  assert.deepEqual(assignedIds(), [18, 18]);
});
test('missing target with slash refuses instead of booking sender', async () => {
  await receive('/marcar @Alex Bombeiro dia 20, 24 horas', [bot, '219999999999999@lid']);
  assert.deepEqual(assignedIds(), []);
});
test('multiple targets refuse instead of silently selecting the first', async () => {
  await receive('@Escalante marque @Alex e @Outro dia 20, 24 horas', [bot, alex, other]);
  assert.deepEqual(assignedIds(), []);
});
test('bare dates addressed to bot still book the sender', async () => {
  await receive('@Escalante 20 noite', [bot]);
  assert.deepEqual(assignedIds(), [1]);
});
test('/marcar without a target still books the sender', async () => {
  await receive('/marcar 20 noite', []);
  assert.deepEqual(assignedIds(), [1]);
});
test('the displayed phrase works without target metadata when Alex is unambiguous', async () => {
  await receive(phrase, [bot]);
  assert.deepEqual(assignedIds(), [18, 18]);
});
test('a missing typed target never falls back to the sender', async () => {
  await receive('@Escalante marque @Desconhecido dia 20, 24 horas', [bot]);
  assert.deepEqual(assignedIds(), []);
  assert.match(replies[0].text, /Nenhuma marcação/);
});
test('an unresolved slash target cannot book sender', async () => {
  await receive('/marcar @219999999999999 dia 20, 24 horas', ['219999999999999@lid']);
  assert.deepEqual(assignedIds(), []);
});
test('numeric text fallback looks up PN without inventing LID identities', async () => {
  const before = db.prepare('SELECT whatsapp_jid,phone_number FROM members WHERE id=18').get();
  await receive(`@${bot.split('@')[0]} marque @${alex.split('@')[0]} no dia 20, 24 horas`, [bot]);
  assert.deepEqual(assignedIds(), [18, 18]);
  assert.deepEqual(db.prepare('SELECT whatsapp_jid,phone_number FROM members WHERE id=18').get(), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM member_whatsapp_identities WHERE member_id=18').get().n, 0);
});
test('quoting Alex and only mentioning the bot still books Alex', async () => {
  await receive('@Escalante', [bot], { participant: alex, quotedMessage: { conversation: 'dia 20, 24 horas' } });
  assert.deepEqual(assignedIds(), [18, 18]);
});
test('a new night request overrides the day requested in the quote', async () => {
  await receive('@Escalante marque @Alex dia 21 noite', [bot, alex], {
    participant: sender, quotedMessage: { conversation: 'dia 20, 24 horas' }
  });
  assert.deepEqual(assignedIds(), [18]);
  assert.deepEqual(db.prepare(`SELECT s.service_date,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).get(), { service_date: `${futureYear}-09-21`, period: 'NOTURNO' });
});
test('ephemeral messages follow the same recipient resolution', async () => {
  await handleIncomingMessages(socket, { messages: [{
    key: { id: `in-${++sequence}`, remoteJid: group, participant: sender },
    message: { ephemeralMessage: { message: { extendedTextMessage: {
      text: phrase, contextInfo: { mentionedJid: [bot, alex] }
    } } } }
  }] });
  assert.deepEqual(assignedIds(), [18, 18]);
});
test('repeating the request cannot create a second position for Alex in a shift', async () => {
  await receive(phrase);
  await receive(phrase);
  assert.deepEqual(assignedIds(), [18, 18]);
});
test('an inactive target does not cause booking in sender name', async () => {
  db.prepare('UPDATE members SET active=0 WHERE id=18').run();
  await receive(phrase);
  assert.deepEqual(assignedIds(), []);
  assert.match(replies[0].text, /não permite/);
});
test('a natural self request with only the bot mention remains supported', async () => {
  await receive('@Escalante põe dia 20 noite', [bot]);
  assert.deepEqual(assignedIds(), [1]);
});

for (const [suffix, expectedPeriods] of [
  ['20 , dia', ['DIURNO']],
  ['20, noite', ['NOTURNO']],
  ['20, 24 horas', ['DIURNO', 'NOTURNO']]
]) {
  test(`mentioned member request "dia ${suffix}" saves only the requested shifts`, async () => {
    await receive(`@Escalante marque @Debiloide no dia ${suffix}`, [bot, alex]);
    const saved = db.prepare(`SELECT a.member_id,s.period FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
      ORDER BY s.period`).all();
    assert.deepEqual(saved, expectedPeriods.map(period => ({ member_id: 18, period })));
    if (expectedPeriods.length === 1) assert.doesNotMatch(replies[0].text, /24 horas confirmado/);
  });
}

test('explicit periods take precedence over default 24h in day lists', () => {
  const full = ['DIURNO', 'NOTURNO'];
  for (const [input, expected] of [
    ['dia 20, dia', [{ day: 20, periods: ['DIURNO'] }]],
    ['dia 20,noite', [{ day: 20, periods: ['NOTURNO'] }]],
    ['dia 20 à noite', [{ day: 20, periods: ['NOTURNO'] }]],
    ['dia 20 de dia', [{ day: 20, periods: ['DIURNO'] }]],
    ['dia 20, 24h', [{ day: 20, periods: full }]],
    ['dia 20', [{ day: 20, periods: full }]],
    ['04; 05 noite', [{ day: 4, periods: full }, { day: 5, periods: ['NOTURNO'] }]],
    ['20, 21 noite', [{ day: 20, periods: ['NOTURNO'] }, { day: 21, periods: ['NOTURNO'] }]],
    ['20 e 21 dia', [{ day: 20, periods: ['DIURNO'] }, { day: 21, periods: ['DIURNO'] }]],
    ['20, dia; 21, noite', [{ day: 20, periods: ['DIURNO'] }, { day: 21, periods: ['NOTURNO'] }]]
  ]) assert.deepEqual(parseNaturalChoices(input), expected, input);
});

for (const input of ['20 dia ou noite', '20, 12h', '20 dia; 32 noite', '20 dia; 21 notie', '20/10 noite', '31/09 dia']) {
  test(`uncertain delegated command writes nothing: ${input}`, async () => {
    await receive(`@Escalante marque @Alex ${input}`);
    assert.deepEqual(assignedIds(), []);
    assert.match(replies[0].text, /Nenhuma marcação foi feita/);
  });
}
test('a list with clock times records the right dates, shifts and member', async () => {
  await receive('@Escalante coloque @Alex dia 20 das 07h às 19h; dia 21 das 19h às 07h');
  assert.deepEqual(db.prepare(`SELECT a.member_id,s.service_date,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id ORDER BY s.service_date,s.period`).all(), [
    { member_id: 18, service_date: `${futureYear}-09-20`, period: 'DIURNO' },
    { member_id: 18, service_date: `${futureYear}-09-21`, period: 'NOTURNO' }
  ]);
});
