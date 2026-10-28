import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { audit, db, now } from '../database/index.js';

const context = new AsyncLocalStorage();
// Only operational data is reversible. Sessions, identities, permissions,
// message delivery, immutable audit and member-history records are not rewound.
const trackedTables = ['members', 'competencies', 'service_slots', 'assignments', 'capacity_changes',
  'bot_passes', 'marking_turns', 'marking_deadlines', 'schedule_pdf_column_releases',
  'ordinary_rotations', 'wing_month_overrides', 'system_settings'];
const metadata = new Map();
let installed = false;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const settingKeys = ['bot_active_competency_id', 'bot_active_selection_month', 'bot_active_marking_column',
  'bot_marking_round_starts_at', 'automation_last_marking_reminder_at', 'automation_last_monthly_run'];

export function isUndoCommand(value) {
  const text = String(value).trim().replace(/^\/+\s*/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return /^(?:(?:DESFAZER|DESFAZ|DESFACA)(?:\s+(?:(?:A|O)\s+)?(?:ULTIM[AO]\s+)?(?:ACAO|ALTERACAO|MUDANCA|MARCACAO|COMANDO))?|ULTIMA\s+FORMA)[.!?]*$/.test(text);
}

function installRecorder() {
  if (installed) return;
  db.function('whatsapp_command_id', () => context.getStore() ?? null);
  for (const table of trackedTables) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
    if (!columns.length) continue;
    const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (!keys.length) throw new Error(`Tabela sem chave para desfazer: ${table}`);
    metadata.set(table, { columns: columns.map((column) => column.name), keys });
    const json = (alias, names) => `json_object(${names.flatMap((name) => [`'${name}'`, `${alias}.${quote(name)}`]).join(',')})`;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const alias = operation === 'DELETE' ? 'OLD' : 'NEW';
      const filter = table === 'system_settings'
        ? ` AND (${alias}.key IN (${settingKeys.map((key) => `'${key}'`).join(',')}) OR ${alias}.key GLOB 'marking_round_*')` : '';
      // TEMP triggers are connection-local. Other SQLite clients never need the
      // JS function; async context keeps unrelated HTTP/automation writes out.
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${quote(`whatsapp_history_${table}_${operation}`)}
        AFTER ${operation} ON main.${quote(table)} WHEN whatsapp_command_id() IS NOT NULL${filter}
        BEGIN INSERT INTO whatsapp_command_changes(command_id,table_name,key_json,before_json,after_json)
          VALUES (whatsapp_command_id(),'${table}',${json(alias, keys)},
          ${operation === 'INSERT' ? 'NULL' : json('OLD', metadata.get(table).columns)},
          ${operation === 'DELETE' ? 'NULL' : json('NEW', metadata.get(table).columns)}); END;`);
    }
  }
  installed = true;
}

const rowsFor = (id) => db.prepare('SELECT * FROM whatsapp_command_changes WHERE command_id=? ORDER BY id').all(id);
function combinedChanges(rows) {
  const combined = new Map();
  for (const row of rows) {
    const key = `${row.table_name}:${row.key_json}`;
    if (!combined.has(key)) combined.set(key, { ...row });
    else combined.get(key).after_json = row.after_json;
  }
  return [...combined.values()];
}
const parse = (value) => value === null ? null : JSON.parse(value);
const meaningful = (value) => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'updated_at'));

function withChangedMonths(result, changes, fallbackCompetencyId) {
  const ids = new Set();
  const names = new Map();
  for (const change of changes) for (const saved of [parse(change.before_json), parse(change.after_json)].filter(Boolean)) {
    if (saved.competency_id) ids.add(saved.competency_id);
    if (change.table_name === 'competencies') { ids.add(saved.id); names.set(saved.id, saved.name); }
    if (change.table_name === 'assignments') {
      const slot = db.prepare('SELECT competency_id FROM service_slots WHERE id=?').get(saved.service_slot_id);
      if (slot) ids.add(slot.competency_id);
    }
    if (change.table_name === 'system_settings' && saved.key === 'bot_active_competency_id' && saved.value) ids.add(Number(saved.value));
  }
  if (!ids.size && fallbackCompetencyId) ids.add(fallbackCompetencyId);
  const months = [...ids].map((id) => db.prepare('SELECT name FROM competencies WHERE id=?').get(id)?.name ?? names.get(id)).filter(Boolean);
  const text = typeof result === 'string' ? result : result?.type === 'TEXT' ? result.text : null;
  if (!text || !months.length || months.every((month) => text.includes(month))) return result;
  const annotated = `${text}\n\n*Mês alterado: ${months.join('; ')}*`;
  return typeof result === 'string' ? annotated : { ...result, text: annotated };
}

export async function recordWhatsAppCommand({ groupJid, actorMemberId, messageId, commandText, permission = 'SELF',
  reportChangedMonths = false, fallbackCompetencyId = null }, callback) {
  const text = String(commandText).trim().replace(/^\/+\s*/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const query = /^(?:MENU|AJUDA|COMANDOS|MESES|STATUS|MINHAS|HORAS|VAGAS|ESCALA|MES|CRONOGRAMA|CONROGRAMA|MOSTRAR\s+(?:CRONOGRAMA|CONROGRAMA))\b/.test(text)
    && !/^ESCALA\s+(?:ZAP|WHATSAPP)\s/.test(text);
  if (!actorMemberId || isUndoCommand(commandText) || query || context.getStore()) return callback();
  installRecorder();
  const id = Number(db.prepare(`INSERT INTO whatsapp_command_history
    (group_jid,actor_member_id,message_id,command_text,permission,created_at) VALUES (?,?,?,?,?,?)`)
    .run(groupJid, actorMemberId, messageId, String(commandText).slice(0, 2000), permission, now()).lastInsertRowid);
  let result;
  let changes;
  try { result = await context.run(id, callback); }
  finally {
    changes = combinedChanges(rowsFor(id)).filter((row) => !isDeepStrictEqual(meaningful(parse(row.before_json)), meaningful(parse(row.after_json))));
    if (changes.length) {
      db.prepare('UPDATE whatsapp_command_history SET completed_at=? WHERE id=?').run(now(), id);
    } else db.prepare('DELETE FROM whatsapp_command_history WHERE id=?').run(id);
  }
  return reportChangedMonths && changes.length ? withChangedMonths(result, changes, fallbackCompetencyId) : result;
}

class UndoConflict extends Error {}
const conflict = () => { throw new UndoConflict('Essa alteração já recebeu outras mudanças. Não desfiz nada para preservar os dados atuais.'); };

export function undoLastWhatsAppCommand({ groupJid, actorMemberId, panelAdministrator = false, groupAdministrator = false }) {
  installRecorder();
  return context.run(null, () => {
    try {
      return db.transaction(() => {
        const command = db.prepare(`SELECT * FROM whatsapp_command_history WHERE group_jid=? AND actor_member_id=?
          AND completed_at IS NOT NULL AND undone_at IS NULL ORDER BY id DESC LIMIT 1`).get(groupJid, actorMemberId);
        if (db.prepare(`SELECT 1 FROM whatsapp_command_history WHERE group_jid=? AND actor_member_id=?
          AND completed_at IS NULL AND id>? LIMIT 1`).get(groupJid, actorMemberId, command?.id ?? 0)) {
          return { text: 'Seu último comando ainda não terminou ou foi interrompido. Aguarde a resposta dele; se o bot reiniciou durante a operação, confira a escala no painel antes de desfazer.' };
        }
        if (!command) return { text: 'Você não tem alteração para desfazer neste grupo. O histórico vale para comandos feitos após esta atualização.' };
        if ((command.permission === 'PANEL_ADMIN' && !panelAdministrator) || (command.permission === 'GROUP_ADMIN' && !groupAdministrator)) {
          return { text: 'Você não tem mais a permissão necessária para desfazer essa alteração.' };
        }
        const rows = rowsFor(command.id);
        const combined = combinedChanges(rows);
        const competencyIds = new Set();
        const competencyNames = new Map();
        const rememberCompetency = (id, name = null) => {
          competencyIds.add(id);
          const label = name ?? db.prepare('SELECT name FROM competencies WHERE id=?').get(id)?.name;
          if (label) competencyNames.set(id, label);
        };
        const affectedSlots = new Set();
        for (const row of combined) {
          const meta = metadata.get(row.table_name);
          if (!meta) conflict();
          const key = parse(row.key_json);
          const where = meta.keys.map((name) => `${quote(name)}=?`).join(' AND ');
          const current = db.prepare(`SELECT * FROM ${quote(row.table_name)} WHERE ${where}`).get(...meta.keys.map((name) => key[name])) ?? null;
          if (!isDeepStrictEqual(current, parse(row.after_json))) conflict();
          for (const saved of [parse(row.before_json), parse(row.after_json)].filter(Boolean)) {
            if (saved.competency_id) rememberCompetency(saved.competency_id);
            if (row.table_name === 'competencies') rememberCompetency(saved.id, saved.name);
            if (row.table_name === 'service_slots') affectedSlots.add(saved.id);
            if (row.table_name === 'assignments') {
              affectedSlots.add(saved.service_slot_id);
              const slot = db.prepare('SELECT competency_id FROM service_slots WHERE id=?').get(saved.service_slot_id);
              if (slot) rememberCompetency(slot.competency_id);
            }
          }
        }
        for (const row of [...rows].reverse()) {
          const { columns, keys } = metadata.get(row.table_name);
          const key = parse(row.key_json);
          const before = parse(row.before_json);
          const after = parse(row.after_json);
          const where = keys.map((name) => `${quote(name)}=?`).join(' AND ');
          const values = keys.map((name) => key[name]);
          if (!before) db.prepare(`DELETE FROM ${quote(row.table_name)} WHERE ${where}`).run(...values);
          else if (!after) db.prepare(`INSERT INTO ${quote(row.table_name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((name) => before[name]));
          else {
            // Operational commands do not rename primary keys. Refuse unknown
            // future cases rather than restore only part of a compound key.
            if (keys.some((name) => before[name] !== after[name])) conflict();
            db.prepare(`UPDATE ${quote(row.table_name)} SET ${columns.map((name) => `${quote(name)}=?`).join(',')} WHERE ${where}`)
              .run(...columns.map((name) => before[name]), ...values);
          }
        }
        // Dependencies may change without touching the recorded rows (e.g. a
        // later booking in a column we're about to close, or a homologated day).
        for (const id of affectedSlots) {
          const slot = db.prepare('SELECT * FROM service_slots WHERE id=?').get(id);
          if (slot) {
            competencyIds.add(slot.competency_id);
            if (db.prepare("SELECT 1 FROM assignments WHERE service_slot_id=? AND status='CONFIRMED' AND (position_number<1 OR position_number>?)").get(id, slot.current_capacity)) conflict();
            if (slot.status !== 'OPEN' && combined.some((row) => row.table_name === 'assignments'
              && parse(row.before_json)?.service_slot_id === id && !isDeepStrictEqual(parse(row.before_json), parse(row.after_json)))) conflict();
          }
        }
        for (const row of combined.filter((item) => item.table_name === 'assignments')) {
          const restored = parse(row.before_json);
          if (restored?.status !== 'CONFIRMED') continue;
          const member = db.prepare('SELECT * FROM members WHERE id=?').get(restored.member_id);
          if (!member?.active || member.authorization_status !== 'AUTHORIZED'
            || !['ACTIVE', ...(restored.service_type === 'EXTRAORDINARY' ? ['VACATION'] : [])].includes(member.operational_status)) conflict();
          if (restored.service_type === 'EXTRAORDINARY' && !member.hour_limit_exempt) {
            const month = db.prepare('SELECT c.* FROM competencies c JOIN service_slots s ON s.competency_id=c.id WHERE s.id=?').get(restored.service_slot_id);
            const hours = db.prepare(`SELECT COUNT(*)*12 hours FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
              WHERE s.competency_id=? AND a.member_id=? AND a.status='CONFIRMED' AND a.service_type='EXTRAORDINARY'`).get(month.id, member.id).hours;
            if (hours > Math.min(Math.max(Number(member.monthly_hour_limit ?? month.current_hour_limit ?? 192), 12), 192)) conflict();
          }
        }
        if (db.prepare('SELECT COUNT(*) n FROM marking_turns WHERE active=1').get().n > 1) conflict();
        db.prepare('UPDATE whatsapp_command_history SET undone_at=? WHERE id=?').run(now(), command.id);
        audit({ action: 'WHATSAPP_UNDO_COMMAND', entityType: 'WHATSAPP_COMMAND', entityId: command.id,
          before: { command: command.command_text }, after: { actorMemberId, groupJid }, reason: 'Última forma pelo WhatsApp' });
        return { text: `*ÚLTIMA AÇÃO DESFEITA*\n${command.command_text}\n\nOs dados anteriores foram restaurados.`,
          competencyIds: [...competencyIds], competencyNames: [...competencyNames.values()], commandId: command.id };
      })();
    } catch (error) {
      if (error instanceof UndoConflict || String(error.code).startsWith('SQLITE_CONSTRAINT')) {
        return { text: 'Não foi possível desfazer: os dados ou as vagas receberam outras alterações. Nenhuma mudança foi aplicada.' };
      }
      throw error;
    }
  });
}
