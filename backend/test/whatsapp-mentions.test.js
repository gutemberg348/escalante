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
db.prepare(`INSERT INTO users (id,name,email,password_hash,role,active,must_change_password,created_at,updated_at)
  VALUES (1,'Administrador de teste','admin-test@example.com','test-hash','ADMIN',1,0,?,?)`).run(stamp, stamp);
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
  db.exec(`DELETE FROM assignments;
    DELETE FROM processed_messages;
    DELETE FROM whatsapp_messages;
    DELETE FROM member_whatsapp_identities;
    DELETE FROM schedule_pdf_column_releases;
    UPDATE service_slots SET current_capacity=2;`);
  db.prepare("UPDATE members SET active=1,operational_status='ACTIVE',authorization_status='AUTHORIZED',ordinary_eligible=1").run();
  setting.run('bot_active_competency_id', String(competency.id), stamp);
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
let assignmentSequence = 0;
function addConfirmedAssignment({ memberId = 18, day = 20, period = 'NOTURNO', serviceType = 'ORDINARY', displayPrefix = null }) {
  const serviceDate = `${futureYear}-09-${String(day).padStart(2, '0')}`;
  const slot = db.prepare('SELECT id FROM service_slots WHERE competency_id=? AND service_date=? AND period=?')
    .get(competency.id, serviceDate, period);
  const occupied = new Set(db.prepare("SELECT position_number FROM assignments WHERE service_slot_id=? AND status='CONFIRMED'")
    .all(slot.id).map((item) => item.position_number));
  const position = [1, 2, 3, 4].find((candidate) => !occupied.has(candidate));
  db.prepare(`INSERT INTO assignments
    (service_slot_id,position_number,member_id,service_type,status,display_prefix,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(slot.id, position, memberId, serviceType, 'CONFIRMED', displayPrefix,
    `TEST-ASSIGNMENT-${++assignmentSequence}`, stamp, stamp, stamp);
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
test('a member excluded from ordinary generation can still use the bot and book an extra shift', async () => {
  db.prepare('UPDATE members SET ordinary_eligible=0 WHERE id=18').run();

  await receive('@Escalante marque @Alex no dia 20 noite');

  assert.deepEqual(assignedIds(), [18]);
  assert.deepEqual(db.prepare('SELECT service_type FROM assignments').all(), [{ service_type: 'EXTRAORDINARY' }]);
});
test('a natural self request with only the bot mention remains supported', async () => {
  await receive('@Escalante põe dia 20 noite', [bot]);
  assert.deepEqual(assignedIds(), [1]);
});

test('a polite 12-hour request using today books only the daytime shift', async () => {
  const current = new Date();
  const currentDate = [
    current.getFullYear(),
    String(current.getMonth() + 1).padStart(2, '0'),
    String(current.getDate()).padStart(2, '0')
  ].join('-');
  const { competency: currentCompetency } = ensureCompetencySchedule(`${currentDate.slice(0, 7)}-01`);
  db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp, currentCompetency.id);
  setting.run('bot_active_competency_id', String(currentCompetency.id), stamp);

  await receive('@Sgt Vieira, por gentileza coloque 12h "dia" hoje?', [bot]);

  assert.deepEqual(db.prepare(`SELECT a.member_id,s.service_date,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).all(), [
    { member_id: 1, service_date: currentDate, period: 'DIURNO' }
  ]);
});

test('direct parenthetical justification never creates a marking when no ordinary assignment exists', async () => {
  await receive('@Escalante @Alex no dia 20, noite (licença)');

  assert.deepEqual(assignedIds(), []);
  assert.match(replies[0].text, /nenhuma escala ordinária encontrada/i);
});

test('/justificar updates the existing ordinary shifts without creating assignments', async () => {
  addConfirmedAssignment({ period: 'DIURNO' });
  addConfirmedAssignment({ period: 'NOTURNO' });

  await receive('/justificar @Alex no dia 20 (afastado)', [alex]);

  assert.deepEqual(db.prepare(`SELECT a.display_prefix,a.service_type,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id ORDER BY s.period`).all(), [
    { display_prefix: 'afastado', service_type: 'ORDINARY', period: 'DIURNO' },
    { display_prefix: 'afastado', service_type: 'ORDINARY', period: 'NOTURNO' }
  ]);
  assert.equal(replies[0].text, `*JUSTIFICATIVA REGISTRADA*\nData: 20/09/${futureYear}\nMilitar: Sgt Alex`);
});

test('bot and military mentions with date, shift and parentheses justify an existing ordinary assignment', async () => {
  addConfirmedAssignment({ period: 'DIURNO' });

  await receive('@Escalante @Alex no dia 20 dia (LICENÇA)', [bot, alex]);

  assert.deepEqual(db.prepare('SELECT member_id,service_type,display_prefix FROM assignments').all(), [
    { member_id: 18, service_type: 'ORDINARY', display_prefix: 'LICENÇA' }
  ]);
  assert.equal(replies[0].text, `*JUSTIFICATIVA REGISTRADA*\nData: 20/09/${futureYear}\nMilitar: Sgt Alex`);
});

test('/marcar with a justification redirects to /justificar without creating a service', async () => {
  await receive('/marcar @Alex no dia 20 (afastado)', [alex]);

  assert.deepEqual(assignedIds(), []);
  assert.match(replies[0].text, /use ´?\*?\/justificar/i);
});

test('/justificar does nothing when the ordinary assignment does not exist', async () => {
  await receive('/justificar @Alex no dia 20 noite (afastado)', [alex]);

  assert.deepEqual(assignedIds(), []);
  assert.match(replies[0].text, /nenhuma escala ordinária encontrada/i);
});

test('/justificar never labels an extraordinary assignment', async () => {
  addConfirmedAssignment({ period: 'NOTURNO', serviceType: 'EXTRAORDINARY' });

  await receive('/justificar @Alex no dia 20 noite (afastado)', [alex]);

  assert.deepEqual(db.prepare('SELECT service_type,display_prefix FROM assignments').all(), [
    { service_type: 'EXTRAORDINARY', display_prefix: null }
  ]);
  assert.match(replies[0].text, /nenhuma escala ordinária encontrada/i);
});

test('a label in a quoted request is applied to the quoted member', async () => {
  addConfirmedAssignment({ period: 'NOTURNO' });
  await receive('@Escalante', [bot], {
    participant: alex,
    quotedMessage: { conversation: 'justificar dia 20 noite (licença médica)' }
  });

  assert.deepEqual(db.prepare(`SELECT a.member_id,a.display_prefix,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).all(), [
    { member_id: 18, display_prefix: 'licença médica', period: 'NOTURNO' }
  ]);
});

test('a new labeled request in a reply targets the quoted member', async () => {
  addConfirmedAssignment({ period: 'NOTURNO' });
  await receive('@Escalante justificar no dia 20 noite (licença)', [bot], {
    participant: alex,
    quotedMessage: { conversation: 'Preciso ficar fora da escala.' }
  });

  assert.deepEqual(db.prepare(`SELECT a.member_id,a.display_prefix,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).all(), [
    { member_id: 18, display_prefix: 'licença', period: 'NOTURNO' }
  ]);
});

test('one message can book two mentioned members in different shifts today', async () => {
  const current = new Date();
  const currentDate = [
    current.getFullYear(),
    String(current.getMonth() + 1).padStart(2, '0'),
    String(current.getDate()).padStart(2, '0')
  ].join('-');
  const { competency: currentCompetency } = ensureCompetencySchedule(`${currentDate.slice(0, 7)}-01`);
  db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp, currentCompetency.id);
  setting.run('bot_active_competency_id', String(currentCompetency.id), stamp);

  await receive('/@1Escalante escalar @Sgt Fragoso hoje 12 horas dia e @Gelson 12 horas noite', [bot, alex, other]);

  assert.deepEqual(db.prepare(`SELECT a.member_id,s.service_date,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id ORDER BY s.period`).all(), [
    { member_id: 18, service_date: currentDate, period: 'DIURNO' },
    { member_id: 19, service_date: currentDate, period: 'NOTURNO' }
  ]);
  assert.match(replies[0].text, /RESULTADO PARA 2 MILITARES/);
});

test('retirar a daytime shift removes only that extra shift from the mentioned member', async () => {
  await receive('@Escalante marque @Alex no dia 20, 24 horas');
  await receive('@Escalante retirar @Alex do dia 20, dia');

  assert.deepEqual(db.prepare(`SELECT a.member_id,a.service_type,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id ORDER BY s.period`).all(), [
    { member_id: 18, service_type: 'EXTRAORDINARY', period: 'NOTURNO' }
  ]);
  assert.match(replies.at(-1).text, /20 dia: serviço extra retirado/i);
});

test('tirar with only a date removes every extra shift on that date', async () => {
  await receive('@Escalante marque @Alex no dia 20, 24 horas');
  await receive('@Escalante tirar @Alex do dia 20');

  assert.deepEqual(assignedIds(), []);
  assert.match(replies.at(-1).text, /20 dia: serviço extra retirado/i);
  assert.match(replies.at(-1).text, /20 noite: serviço extra retirado/i);
});

for (const misspelledRemoval of ['retir', 'exclur', 'remov']) {
  test(`a one-letter removal typo "${misspelledRemoval}" is accepted`, async () => {
    await receive('@Escalante marque @Alex no dia 20 noite');
    await receive(`@Escalante ${misspelledRemoval} @Alex do dia 20 noite`);

    assert.deepEqual(assignedIds(), []);
    assert.match(replies.at(-1).text, /serviço extra retirado/i);
  });
}

test('excluir by date never removes an ordinary service', async () => {
  const slot = db.prepare("SELECT id FROM service_slots WHERE competency_id=? AND service_date=? AND period='DIURNO'")
    .get(competency.id, `${futureYear}-09-20`);
  db.prepare(`INSERT INTO assignments
    (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(slot.id, 1, 18, 'ORDINARY', 'CONFIRMED', 'ORDINARY-PRESERVED', stamp, stamp, stamp);

  await receive('@Escalante marque @Alex do dia 20, noite');
  await receive('@Escalante excluir @Alex do dia 20, 24hrs');

  assert.deepEqual(db.prepare('SELECT member_id,service_type,protocol FROM assignments').all(), [
    { member_id: 18, service_type: 'ORDINARY', protocol: 'ORDINARY-PRESERVED' }
  ]);
  assert.match(replies.at(-1).text, /serviços ordinários foram preservados/i);
});

test('criar is accepted as a synonym for marking another member', async () => {
  await receive('@Escalante crie @Alex no dia 20 noite', [bot, alex]);

  assert.deepEqual(db.prepare(`SELECT a.member_id,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).all(), [
    { member_id: 18, period: 'NOTURNO' }
  ]);
});

test('trocar replaces one extra member and reports the result', async () => {
  await receive('@Escalante marque @Alex no dia 20 noite', [bot, alex]);
  await receive('@Escalante troque @Alex dia 20 noite por @Outro', [bot, alex, other]);

  assert.deepEqual(db.prepare(`SELECT a.member_id,a.service_type,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).all(), [
    { member_id: 19, service_type: 'EXTRAORDINARY', period: 'NOTURNO' }
  ]);
  assert.match(replies.at(-1).text, /TROCA REALIZADA/);
  assert.match(replies.at(-1).text, /Antes: Sgt Alex/);
  assert.match(replies.at(-1).text, /Agora: Sgt Outro/);
});

test('permutar swaps two extra assignments and reports both movements', async () => {
  await receive('@Escalante marque @Alex no dia 20 noite', [bot, alex]);
  await receive('@Escalante marque @Outro no dia 21 dia', [bot, other]);
  await receive('@Escalante permute @Alex dia 20 noite com @Outro dia 21 dia', [bot, alex, other]);

  assert.deepEqual(db.prepare(`SELECT a.member_id,s.service_date,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id ORDER BY a.member_id`).all(), [
    { member_id: 18, service_date: `${futureYear}-09-21`, period: 'DIURNO' },
    { member_id: 19, service_date: `${futureYear}-09-20`, period: 'NOTURNO' }
  ]);
  assert.match(replies.at(-1).text, /PERMUTA REALIZADA/);
  assert.match(replies.at(-1).text, /Sgt Alex/);
  assert.match(replies.at(-1).text, /Sgt Outro/);
});

test('remanejar moves one extra assignment and keeps its parenthetical label', async () => {
  await receive('@Escalante marque @Alex no dia 20 noite', [bot, alex]);
  db.prepare("UPDATE assignments SET display_prefix='licença'").run();
  await receive('@Escalante remaneje @Alex do dia 20 noite para dia 21 dia', [bot, alex]);

  assert.deepEqual(db.prepare(`SELECT a.member_id,a.display_prefix,s.service_date,s.period FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id`).all(), [
    { member_id: 18, display_prefix: 'licença', service_date: `${futureYear}-09-21`, period: 'DIURNO' }
  ]);
  assert.match(replies.at(-1).text, /REMANEJAMENTO REALIZADO/);
  assert.match(replies.at(-1).text, /Antes:/);
  assert.match(replies.at(-1).text, /Agora:/);
});

test('a group exchange command never changes an ordinary assignment', async () => {
  const slot = db.prepare("SELECT id FROM service_slots WHERE competency_id=? AND service_date=? AND period='NOTURNO'")
    .get(competency.id, `${futureYear}-09-20`);
  db.prepare(`INSERT INTO assignments
    (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(slot.id, 1, 18, 'ORDINARY', 'CONFIRMED', 'ORDINARY-NOT-REPLACED', stamp, stamp, stamp);

  await receive('@Escalante troque @Alex dia 20 noite por @Outro', [bot, alex, other]);

  assert.deepEqual(db.prepare('SELECT member_id,service_type,protocol FROM assignments').all(), [
    { member_id: 18, service_type: 'ORDINARY', protocol: 'ORDINARY-NOT-REPLACED' }
  ]);
  assert.match(replies.at(-1).text, /ordinário/i);
});

test('only a group administrator can open a schedule column', async () => {
  await receive('@Escalante abrir 3ª coluna dia 17', [bot]);

  const capacities = db.prepare(`SELECT DISTINCT current_capacity FROM service_slots
    WHERE competency_id=? AND service_date=?`).all(competency.id, `${futureYear}-09-17`);
  assert.deepEqual(capacities, [{ current_capacity: 2 }]);
  assert.match(replies.at(-1).text, /Somente administradores do grupo/i);
});

test('a group administrator can open the fourth column on one date only', async () => {
  socket.groupMetadata = async () => ({ participants: [{ id: sender, admin: 'admin' }] });

  await receive('@Escalante liberar 4ª coluna dia 17', [bot]);

  assert.match(replies.at(-1).text, /4ª COLUNA ABERTA/);
  assert.deepEqual(db.prepare(`SELECT service_date,third_column_open,fourth_column_open
    FROM schedule_pdf_column_releases WHERE competency_id=?`).all(competency.id), [
    { service_date: `${futureYear}-09-17`, third_column_open: 1, fourth_column_open: 1 }
  ]);
  assert.deepEqual(db.prepare(`SELECT service_date,current_capacity FROM service_slots
    WHERE competency_id=? AND service_date IN (?,?) AND period='DIURNO' ORDER BY service_date`)
    .all(competency.id, `${futureYear}-09-17`, `${futureYear}-09-18`), [
    { service_date: `${futureYear}-09-17`, current_capacity: 4 },
    { service_date: `${futureYear}-09-18`, current_capacity: 2 }
  ]);
  assert.match(replies.at(-1).text, /4ª COLUNA ABERTA/);
  assert.match(replies.at(-1).text, new RegExp(`Data: 17/09/${futureYear}`));
  assert.doesNotMatch(replies.at(-1).text, /fila|antiguidade/i);
});

test('a group administrator can open the fourth column on the whole month except selected days', async () => {
  socket.groupMetadata = async () => ({ participants: [{ id: sender, admin: 'admin' }] });

  await receive('@Escalante abrir 4ª coluna exceto dias 17 e 18', [bot]);

  assert.match(replies.at(-1).text, /exceto: 17\/09\/\d{4}, 18\/09\/\d{4}/i);
  assert.doesNotMatch(replies.at(-1).text, /fila|antiguidade/i);
  assert.deepEqual(db.prepare(`SELECT service_date,current_capacity FROM service_slots
    WHERE competency_id=? AND service_date IN (?,?,?) AND period='DIURNO' ORDER BY service_date`)
    .all(competency.id, `${futureYear}-09-16`, `${futureYear}-09-17`, `${futureYear}-09-18`), [
    { service_date: `${futureYear}-09-16`, current_capacity: 4 },
    { service_date: `${futureYear}-09-17`, current_capacity: 2 },
    { service_date: `${futureYear}-09-18`, current_capacity: 2 }
  ]);
});

test('closing an occupied column warns first and only deletes after EXCLUA', async () => {
  socket.groupMetadata = async () => ({ participants: [{ id: sender, admin: 'superadmin' }] });
  const serviceDate = `${futureYear}-09-17`;
  const slot = db.prepare(`SELECT id FROM service_slots WHERE competency_id=? AND service_date=? AND period='DIURNO'`)
    .get(competency.id, serviceDate);
  db.prepare(`INSERT INTO schedule_pdf_column_releases
    (competency_id,service_date,third_column_open,fourth_column_open,updated_by,updated_at)
    VALUES (?,?,1,1,1,?)`).run(competency.id, serviceDate, stamp);
  db.prepare('UPDATE service_slots SET current_capacity=4 WHERE competency_id=? AND service_date=?').run(competency.id, serviceDate);
  db.prepare(`INSERT INTO assignments
    (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,4,?,'EXTRAORDINARY','CONFIRMED',?,?,?,?)`).run(slot.id, 18, 'COLUMN-4-TEST', stamp, stamp, stamp);

  await receive('@Escalante fechar 4ª coluna dia 17', [bot]);

  assert.equal(db.prepare('SELECT COUNT(*) total FROM assignments').get().total, 1);
  assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(slot.id).current_capacity, 4);
  assert.match(replies.at(-1).text, /NÃO FOI FECHADA/);
  assert.match(replies.at(-1).text, /EXCLUA/);

  await receive('@Escalante fechar 4ª coluna dia 17 EXCLUA', [bot]);

  assert.equal(db.prepare('SELECT COUNT(*) total FROM assignments').get().total, 0);
  assert.equal(db.prepare('SELECT current_capacity FROM service_slots WHERE id=?').get(slot.id).current_capacity, 3);
  assert.match(replies.at(-1).text, /4ª COLUNA FECHADA/);
  assert.match(replies.at(-1).text, /1 marcação\(ões\) excluída/);
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
