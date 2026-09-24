import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { audit, db, now } from '../database/index.js';
import { buildSchedulePdf } from './schedule-pdf.js';
import { parseMarkingRequest } from './marking-choices.js';
import { applyVacationToCompetency, vacationImpact } from '../scheduling/member-status.js';
import { regenerateOrdinaryAssignments } from '../scheduling/monthly.js';
export { parseNaturalChoices } from './marking-choices.js';

const authDirectory = path.resolve(path.dirname(env.DATABASE_PATH), 'whatsapp-auth');
const commandHandlerVersion = 'mentions-v10-member-status';
const connection = {
  socket: null, saveCreds: null, status: 'DISCONNECTED', qrDataUrl: null, qrIssued: false,
  phoneNumber: null, error: null, reconnectTimer: null, reconnectAttempts: 0,
  manualDisconnect: false, lastConnectedAt: null, lastDisconnectCode: null
};
const readSetting = (key) => db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value ?? '';
const writeSetting = (key, value, userId) => db.prepare(`INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(key, value, userId, now());
const isManualConnectionStop = () => readSetting('whatsapp_manual_stop') === '1';
const periodLabel = (period) => period === 'DIURNO' ? 'Dia' : 'Noite';
const operationalLabel = { ACTIVE: 'Ativo', VACATION: 'Férias', LEAVE: 'Licença', AWAY: 'Afastado', INACTIVE: 'Desativado' };
const authorizationLabel = { AUTHORIZED: 'Autorizado', PENDING: 'Pendente', SUSPENDED: 'Suspenso', NOT_AUTHORIZED: 'Não autorizado' };
const markingWeekdayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
// Horário diário em que uma rodada programada do cronograma começa.
// Altere somente este valor caso a regra deixe de ser 06h.
const markingRoundStartHour = 6;
const pendingVacationSettingKey = 'bot_pending_vacation_confirmation';

function configuredGroupJids() {
  const legacyGroup = readSetting('whatsapp_group_jid');
  try {
    const saved = JSON.parse(readSetting('whatsapp_group_jids') || '[]');
    if (Array.isArray(saved)) {
      const groups = [...new Set(saved.filter((jid) => typeof jid === 'string' && jid.endsWith('@g.us')))];
      if (groups.length) return groups;
    }
  } catch { /* A configuração antiga de um único grupo continua válida. */ }
  return legacyGroup?.endsWith('@g.us') ? [legacyGroup] : [];
}

function publicStatus() {
  const active = activeCompetency();
  return {
    status: connection.status,
    qrDataUrl: connection.qrDataUrl,
    phoneNumber: connection.phoneNumber,
    error: connection.error,
    hasSession: hasStoredWhatsAppSession(),
    reconnectAttempts: connection.reconnectAttempts,
    lastConnectedAt: connection.lastConnectedAt,
    lastDisconnectCode: connection.lastDisconnectCode,
    configuredNumber: readSetting('whatsapp_target_number'),
    groupJid: configuredGroupJids()[0] ?? '',
    groupJids: configuredGroupJids(),
    activeCompetencyId: active?.id ?? null,
    activeCompetencyName: active?.name ?? null
  };
}

function hasStoredWhatsAppSession() {
  const credentialsPath = path.join(authDirectory, 'creds.json');
  if (!fs.existsSync(credentialsPath)) return false;
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    // Em versões recentes do Baileys, "registered" pode continuar falso mesmo
    // depois do vínculo, enquanto me/account/chaves já foram persistidos. A
    // presença dessas credenciais é a fonte confiável para restaurar a sessão.
    return Boolean(credentials?.registered || (
      credentials?.me?.id && credentials?.account && credentials?.noiseKey &&
      credentials?.signedIdentityKey && credentials?.advSecretKey
    ));
  } catch {
    return false;
  }
}

export function getWhatsAppStatus() { return publicStatus(); }
export function setActiveWhatsAppCompetency(competencyId, userId = null) {
  const competency = db.prepare('SELECT * FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(competencyId);
  if (!competency) throw new Error('Selecione um mês que já foi gerado.');
  writeSetting('bot_active_competency_id', String(competency.id), userId);
  return competency;
}

export function saveWhatsAppSettings({ targetNumber, groupJid, groupJids, activeCompetencyId, userId }) {
  const normalizedGroups = [...new Set((Array.isArray(groupJids) ? groupJids : [groupJid])
    .filter((jid) => typeof jid === 'string' && jid.endsWith('@g.us')))];
  writeSetting('whatsapp_target_number', targetNumber ?? '', userId);
  // Mantém a chave antiga para instalações já configuradas e grava a lista nova.
  writeSetting('whatsapp_group_jid', normalizedGroups[0] ?? '', userId);
  writeSetting('whatsapp_group_jids', JSON.stringify(normalizedGroups), userId);
  if (activeCompetencyId) setActiveWhatsAppCompetency(activeCompetencyId, userId);
  return publicStatus();
}

function clearReconnectTimer() {
  if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;
}

function scheduleReconnect(message, delay = null) {
  if (connection.manualDisconnect || isManualConnectionStop()) {
    connection.status = 'DISCONNECTED';
    return;
  }
  clearReconnectTimer();
  connection.reconnectAttempts += 1;
  const retryDelay = delay ?? Math.min(1_500 * (2 ** Math.min(connection.reconnectAttempts - 1, 5)), 45_000);
  connection.status = 'RECONNECTING';
  connection.error = `${message} Nova tentativa em ${Math.ceil(retryDelay / 1000)}s.`;
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    if (connection.manualDisconnect || connection.socket || isManualConnectionStop()) return;
    connection.status = 'DISCONNECTED';
    connectWhatsApp({ automatic: true }).catch((error) => scheduleReconnect(`Falha ao reconectar: ${error.message}`));
  }, retryDelay);
  connection.reconnectTimer.unref?.();
}

export async function connectWhatsApp({ automatic = false } = {}) {
  if (connection.status === 'CONNECTING' || connection.status === 'WAITING_QR' || connection.status === 'CONNECTED') return publicStatus();
  if (!automatic) clearReconnectTimer();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20 || !globalThis.crypto?.subtle) {
    connection.status = 'ERROR';
    connection.error = 'O conector WhatsApp exige Node 20+. Execute este projeto com Volta e Node 20.19.0.';
    return publicStatus();
  }
  connection.manualDisconnect = false;
  connection.status = 'CONNECTING'; connection.error = null; connection.qrDataUrl = null; connection.qrIssued = false;
  writeSetting('whatsapp_auto_connect', '1', null);
  writeSetting('whatsapp_manual_stop', '0', null);
  try {
    fs.mkdirSync(authDirectory, { recursive: true });
    const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason, fetchLatestWaWebVersion } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
    const isRegistered = () => Boolean(state.creds.registered);
    connection.saveCreds = saveCreds;
    const latestVersion = await fetchLatestWaWebVersion().catch(() => null);
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.windows('Escala'),
      ...(latestVersion?.version ? { version: latestVersion.version } : {}),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      retryRequestDelayMs: 1_000,
      syncFullHistory: false
    });
    connection.socket = socket;
    socket.ev.on('creds.update', () => saveCreds().catch((error) => { connection.error = `Não foi possível salvar a sessão: ${error.message}`; }));
    socket.ev.on('connection.update', (update) => { handleConnectionUpdate(socket, update, DisconnectReason, isRegistered).catch((error) => { scheduleReconnect(`Falha na conexão WhatsApp: ${error.message}`); }); });
    socket.ev.on('messages.upsert', (event) => { handleIncomingMessages(socket, event).catch((error) => { console.error('Falha ao processar mensagem WhatsApp:', error); }); });
    return publicStatus();
  } catch (error) {
    connection.socket = null;
    connection.saveCreds = null;
    if (hasStoredWhatsAppSession() && !connection.manualDisconnect) scheduleReconnect(`Falha ao conectar: ${error.message}`);
    else { connection.status = 'ERROR'; connection.error = error.message; }
    return publicStatus();
  }
}

async function handleConnectionUpdate(socket, { connection: stateName, qr, lastDisconnect }, DisconnectReason, isRegistered) {
  if (connection.socket !== socket) return;
  if (qr) { connection.status = 'WAITING_QR'; connection.qrIssued = true; connection.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300, color: { dark: '#123f59', light: '#ffffff' } }); }
  if (stateName === 'open') {
    clearReconnectTimer();
    connection.status = 'CONNECTED'; connection.qrDataUrl = null; connection.qrIssued = false; connection.error = null;
    connection.phoneNumber = socket.user?.id?.split(':')[0]?.split('@')[0] ?? null;
    connection.reconnectAttempts = 0; connection.lastConnectedAt = now(); connection.lastDisconnectCode = null;
    writeSetting('whatsapp_auto_connect', '1', null);
    console.info(JSON.stringify({ event: 'whatsapp_ready', handlerVersion: commandHandlerVersion, pid: process.pid }));
  }
  if (stateName === 'close') {
    const qrWasIssued = connection.qrIssued;
    await connection.saveCreds?.().catch(() => {});
    connection.socket = null; connection.saveCreds = null; connection.qrDataUrl = null; connection.qrIssued = false;
    const code = lastDisconnect?.error?.output?.statusCode;
    connection.lastDisconnectCode = code ?? null;
    if (connection.manualDisconnect || isManualConnectionStop()) {
      connection.status = 'DISCONNECTED'; connection.error = null; return;
    }
    const wasRegistering = !isRegistered() && !hasStoredWhatsAppSession();
    if (code === DisconnectReason.restartRequired) {
      scheduleReconnect('O WhatsApp solicitou a renovação da conexão.', 700);
      return;
    }
    if (code === DisconnectReason.loggedOut) {
      // Somente "Trocar aparelho / novo QR" pode remover a sessão persistida.
      scheduleReconnect('O WhatsApp recusou temporariamente a sessão salva. As credenciais foram preservadas.');
      return;
    }
    if (wasRegistering) {
      writeSetting('whatsapp_auto_connect', '0', null);
      connection.status = 'ERROR';
      connection.error = qrWasIssued
        ? 'O vínculo do QR Code não foi concluído pelo WhatsApp. Gere um novo QR e tente novamente.'
        : 'O WhatsApp recusou o registro antes de gerar o QR Code. Clique em “Gerar novo QR Code” para tentar novamente.';
      return;
    }
    scheduleReconnect('Conexão interrompida.');
  }
}

function unwrapMessageContent(content) {
  let current = content;
  for (let depth = 0; depth < 5; depth += 1) {
    const nested = current?.ephemeralMessage?.message
      ?? current?.viewOnceMessage?.message
      ?? current?.viewOnceMessageV2?.message
      ?? current?.viewOnceMessageV2Extension?.message
      ?? current?.documentWithCaptionMessage?.message
      ?? current?.editedMessage?.message;
    if (!nested) break;
    current = nested;
  }
  return current;
}

function textFromContent(rawContent) {
  const content = unwrapMessageContent(rawContent);
  return content?.conversation
    ?? content?.extendedTextMessage?.text
    ?? content?.imageMessage?.caption
    ?? content?.videoMessage?.caption
    ?? content?.documentMessage?.caption
    ?? '';
}

function textFromMessage(message) {
  return textFromContent(message.message);
}

function messageContextInfo(message) {
  const content = unwrapMessageContent(message.message);
  return content?.extendedTextMessage?.contextInfo
    ?? content?.imageMessage?.contextInfo
    ?? content?.videoMessage?.contextInfo
    ?? content?.documentMessage?.contextInfo
    ?? null;
}

function jidAccount(jid) {
  return typeof jid === 'string' ? jid.split('@')[0].split(':')[0] : '';
}

function botAccounts(socket) {
  const accounts = [
    socket.user?.id,
    socket.user?.lid,
    connection.phoneNumber,
    readSetting('whatsapp_target_number')
  ].map(jidAccount).filter(Boolean);
  return new Set(accounts.flatMap((account) => phoneVariants(account)));
}

function mentionsBot(socket, message) {
  const context = messageContextInfo(message);
  if (!context) return false;
  const accounts = botAccounts(socket);
  return Boolean(context.mentionedJid?.some((jid) => accounts.has(jidAccount(jid))));
}

function isAddressedToBot(socket, message, body) {
  if (body.startsWith('/')) return true;
  const normalized = body.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['COMANDOS', 'MENU', 'AJUDA'].includes(normalized)) return true;
  const context = messageContextInfo(message);
  if (!context) return false;
  const accounts = botAccounts(socket);
  if (mentionsBot(socket, message)) return true;
  if (context.participant && accounts.has(jidAccount(context.participant))) return true;
  if (context.stanzaId) {
    return Boolean(db.prepare(`SELECT 1 FROM whatsapp_messages WHERE message_id=? AND direction='OUTBOUND'`).get(context.stanzaId));
  }
  return false;
}

function quotedMemberRequest(socket, message) {
  const context = messageContextInfo(message);
  const quotedBody = textFromContent(context?.quotedMessage).trim();
  if (!quotedBody || !context?.participant) return null;
  const accounts = botAccounts(socket);
  const quotedParticipants = [
    context.participant,
    context.participantAlt,
    context.participantPn,
    context.senderPn
  ].filter(Boolean);
  const quotedFromBot = quotedParticipants.some((jid) => accounts.has(jidAccount(jid)))
    || Boolean(context.stanzaId && db.prepare(`SELECT 1 FROM whatsapp_messages
      WHERE message_id=? AND direction='OUTBOUND'`).get(context.stanzaId));
  if (quotedFromBot) return null;
  return {
    body: quotedBody,
    key: {
      remoteJid: message.key.remoteJid,
      participant: context.participant,
      participantAlt: context.participantAlt,
      participantPn: context.participantPn,
      senderPn: context.senderPn,
      remoteJidAlt: context.remoteJidAlt
    }
  };
}

function withoutBotMention(body) {
  return body.replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

function withoutBotMentionPreservingLines(body) {
  return body.replace(/@\S+/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeMentionLabel(value) {
  return String(value ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

export function memberMentionedByName(body, excludedMemberId = null) {
  const normalizedBody = normalizeMentionLabel(body);
  const members = db.prepare('SELECT * FROM members').all();
  const matches = members.filter((member) => {
    if (member.id === excludedMemberId) return false;
    const labels = [member.full_name, member.operational_name, `${member.rank} ${member.operational_name}`]
      .map(normalizeMentionLabel)
      .filter((label) => label.length >= 3);
    return labels.some((label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`@${escaped}(?=\\s|[,.;:]|$)`).test(normalizedBody);
    });
  });
  return matches.length === 1 ? matches[0] : null;
}

async function mentionedMember(socket, message) {
  const botIds = botAccounts(socket);
  const mentioned = [...new Set(messageContextInfo(message)?.mentionedJid ?? [])]
    .filter((jid) => !botIds.has(jidAccount(jid)));
  const matches = new Map();
  const targets = [];
  let unresolved = false;
  for (const jid of mentioned) {
    const resolved = await resolveMemberIdentityWithMapping(socket, {
      participant: jid,
      remoteJid: message.key.remoteJid
    });
    if (resolved.member) {
      matches.set(resolved.member.id, resolved.member);
      targets.push({ jid, member: resolved.member });
    }
    else unresolved = true;
  }
  if (mentioned.length) {
    // Structured mentions identify the actual contact. Never substitute a name
    // from the text if that contact could not be identified.
    return {
      required: true, source: 'MENTION',
      targets: unresolved ? [] : targets.filter((target, index, items) => items.findIndex((item) => item.member.id === target.member.id) === index),
      member: !unresolved && matches.size === 1 ? [...matches.values()][0] : null,
      error: unresolved ? 'Não identifiquei o contato marcado no efetivo. Nenhuma marcação foi feita.'
        : matches.size !== 1 ? 'Informe um dia e turno para cada militar marcado. Nenhuma marcação foi feita.' : null
    };
  }
  const body = textFromMessage(message);
  const textAccounts = [...new Set([...body.matchAll(/@(\d{10,20})(?!\d)/g)].map((match) => match[1]))]
    .filter((account) => !botIds.has(account));
  // When metadata is missing, numeric tokens can refer to PN or LID. Look up
  // both without registering guessed identities or changing phone numbers.
  for (const account of textAccounts) {
    const candidates = db.prepare(`SELECT DISTINCT m.* FROM members m
      LEFT JOIN member_whatsapp_identities i ON i.member_id=m.id
      WHERE m.whatsapp_jid IN (?,?) OR i.jid IN (?,?)`).all(
      `${account}@s.whatsapp.net`, `${account}@lid`, `${account}@s.whatsapp.net`, `${account}@lid`);
    for (const phone of phoneVariants(account)) {
      const candidate = db.prepare('SELECT * FROM members WHERE phone_number=?').get(phone);
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) unresolved = true;
    for (const candidate of candidates) matches.set(candidate.id, candidate);
  }
  if (textAccounts.length) return {
    required: true, source: 'TEXT_ACCOUNT',
    targets: [],
    member: !unresolved && matches.size === 1 ? [...matches.values()][0] : null,
    error: unresolved || matches.size !== 1 ? 'Não identifiquei um único militar marcado. Nenhuma marcação foi feita.' : null
  };
  const textMentions = body.match(/@\S+/g) ?? [];
  const named = memberMentionedByName(body);
  const required = textMentions.length >= 2 || Boolean(named)
    || (withoutBotMention(body).startsWith('/') && textMentions.length > 0);
  return { required, source: required ? 'TEXT_NAME' : 'SELF', targets: [], member: named,
    error: required && !named ? 'Não identifiquei um único militar marcado. Selecione o contato usando @. Nenhuma marcação foi feita.' : null };
}

const delegatedMarkingPattern = /\b(?:COLOCA|COLOCAR|COLOQUE|POE|POR|PONHA|BOTA|BOTAR|BOTE|MARCA|MARCAR|MARQUE|ESCALA|ESCALAR|INCLUA|ADICIONA|ADICIONAR|CRIA|CRIAR|CRIE)\b/;
const isDelegatedMarkingText = (body) => delegatedMarkingPattern.test(normalizeMentionLabel(body));
const delegatedRemovalActions = [
  'RETIRA', 'RETIRAR', 'RETIRE', 'TIRA', 'TIRAR', 'TIRE',
  'EXCLUI', 'EXCLUIR', 'EXCLUA', 'REMOVE', 'REMOVER', 'REMOVA',
  'APAGA', 'APAGAR', 'APAGUE'
];

function differsByAtMostOneCharacter(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let differences = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return differences + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function delegatedRemovalAction(body) {
  const normalized = normalizeMentionLabel(body);
  const words = [...normalized.matchAll(/\b[A-Z]{3,}\b/g)];
  return words.find((match) => delegatedRemovalActions.some((action) =>
    match[0] === action || differsByAtMostOneCharacter(match[0], action))) ?? null;
}

const isDelegatedRemovalText = (body) => Boolean(delegatedRemovalAction(body));
function removeDelegatedRemovalAction(body) {
  const match = delegatedRemovalAction(body);
  if (!match) return body;
  return `${body.slice(0, match.index)} ${body.slice(match.index + match[0].length)}`;
}
const assignmentChangePattern = /\b(?:TROCA|TROCAR|TROQUE|SUBSTITUI|SUBSTITUIR|SUBSTITUA|PERMUTA|PERMUTAR|PERMUTE|REMANEJA|REMANEJAR|REMANEJE)\b/;
const remaneuverPattern = /\b(?:REMANEJA|REMANEJAR|REMANEJE)\b/;
const isAssignmentChangeText = (body) => assignmentChangePattern.test(normalizeMentionLabel(body));

function parseActiveMarkingRequest(text) {
  const competency = activeCompetency();
  return parseMarkingRequest(text, {
    month: competency?.month,
    year: competency?.year,
    today: dayjs().format('YYYY-MM-DD')
  });
}

const columnOpenActionPattern = /\b(?:ABRIR|ABRA|ABRE|LIBERAR|LIBERE|LIBERA|DESTRANCAR|DESTRANQUE)\b/;
const columnCloseActionPattern = /\b(?:FECHAR|FECHE|FECHA|TRANCAR|TRANQUE|TRANCA)\b/;
const columnAfterNumberPattern = /\b(?:(?:3|4)\s*(?:A|ª)?|TERCEIRA|QUARTA)\s*(?:COLUNA|POSICAO)(?=\s|[,.]|$)/;
const columnBeforeNumberPattern = /\b(?:COLUNA|POSICAO)\s*(?:(?:3|4)\s*(?:A|ª)?|TERCEIRA|QUARTA)(?=\s|[,.]|$)/;
const markingScheduleWordPattern = /\b(?:CRONOGRAMA|CONROGRAMA|CRONOGAMA|CRONOGRMA)\b/;
const markingScheduleStartPattern = /\b(?:INICIAR|INICIE|INICIA|INICIANDO|INICIO|REINICIAR|REINICIE|REINICIA|COMECA|COMECAR|COMECE|COMECANDO|RECOMECA|RECOMECAR|RECOMECE|DAR\s+INICIO)\b/;

function parseMarkingScheduleCommand(value) {
  const normalized = normalizeMentionLabel(value);
  if (!markingScheduleWordPattern.test(normalized)) return null;
  return { action: markingScheduleStartPattern.test(normalized) ? 'START' : 'SHOW' };
}

function parseMarkingScheduleStartDetails(value, competency) {
  const normalized = normalizeMentionLabel(value).replace(/[ªº]/g, 'A');
  const columnMatch = normalized.match(/\b([234])\s*A?\s*(?:COLUNA|POSICAO)\b/);
  if (!columnMatch) return { error: 'Informe a coluna. Exemplo: *iniciar cronograma dia 25/10/2026, 2ª coluna*.' };
  const completeDate = normalized.match(/\b([0-3]?\d)\/(0?\d|1[0-2])\/(20\d{2})\b/);
  const shortDate = !completeDate ? normalized.match(/\b([0-3]?\d)\/(0?\d|1[0-2])\b/) : null;
  const dayOnly = !completeDate && !shortDate ? normalized.match(/\bDIA\s+([0-3]?\d)\b/) : null;
  if (!completeDate && !shortDate && !dayOnly) {
    return { error: 'Informe a data de início. Exemplo: *iniciar cronograma dia 25/10/2026, 2ª coluna*.' };
  }
  const day = Number(completeDate?.[1] ?? shortDate?.[1] ?? dayOnly?.[1]);
  const month = Number(completeDate?.[2] ?? shortDate?.[2] ?? competency.month);
  const year = Number(completeDate?.[3] ?? competency.year);
  const date = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  const canonical = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  if (!date.isValid() || date.format('DD/MM/YYYY') !== canonical) return { error: `A data ${canonical} é inválida.` };
  if (month !== competency.month || year !== competency.year) return { error: `A data precisa pertencer a ${competency.name}.` };
  const startsAt = date.startOf('day').hour(markingRoundStartHour).minute(0).second(0).millisecond(0);
  if (date.endOf('day').isBefore(dayjs())) return { error: 'A data de início já passou.' };
  return { column: Number(columnMatch[1]), date: date.format('YYYY-MM-DD'), startsAt, error: null };
}

const memberStatusManagementPattern = /\b(?:COLOCA|COLOCAR|COLOQUE|POE|POR|PONHA|DEIXA|DEIXAR|DEIXE|MUDA|MUDAR|MUDE|ALTERA|ALTERAR|ALTERE)\b/;

export function parseMemberStatusCommand(value) {
  const original = String(value ?? '');
  if (/[()]/.test(original)) return null;
  const normalized = normalizeMentionLabel(original).replace(/^\/+/, '').trim();
  if (!normalized) return null;
  const keepExtras = /\b(?:NAO\s+(?:RETIRAR|REMOVER|EXCLUIR|APAGAR)|MANTER|MANTENHA|PRESERVAR|PRESERVE)\s+(?:OS?\s+)?EXTRAS?\b/.test(normalized);
  const removeExtras = !keepExtras && /\b(?:RETIRAR|RETIRE|REMOVER|REMOVA|EXCLUIR|EXCLUA|APAGAR|APAGUE)\s+(?:OS?\s+)?EXTRAS?\b/.test(normalized);
  const extraAction = keepExtras ? 'KEEP' : removeExtras ? 'REMOVE' : null;
  const statusText = normalized.replace(/\b(?:(?:NAO\s+)?(?:RETIRAR|RETIRE|REMOVER|REMOVA|EXCLUIR|EXCLUA|APAGAR|APAGUE)|MANTER|MANTENHA|PRESERVAR|PRESERVE)\s+(?:OS?\s+)?EXTRAS?\b/g, ' ').replace(/\s+/g, ' ').trim();
  const directStatus = /^(?:DE\s+)?(?:FERIAS|LICENCA|AFASTAD[OA]|ATIV[OA]|INATIV[OA]|DESATIVAD[OA])(?:\s+POR\s+FAVOR)?$/.test(statusText);
  const managementAction = memberStatusManagementPattern.test(statusText);
  const explicitAction = /\b(?:AFASTAR|AFASTE|ATIVAR|ATIVE|REATIVAR|REATIVE|DESATIVAR|DESATIVE)\b/.test(statusText);
  if (!directStatus && !managementAction && !explicitAction) return null;

  if (/\b(?:DESATIVAR|DESATIVE|DESATIVAD[OA]|INATIV[OA])\b/.test(statusText)) return { status: 'INACTIVE' };
  if (/\b(?:REATIVAR|REATIVE|ATIVAR|ATIVE|ATIV[OA])\b/.test(statusText)) return { status: 'ACTIVE' };
  if (/\bFERIAS\b/.test(statusText)) return extraAction ? { status: 'VACATION', extraAction } : { status: 'VACATION' };
  if (/\bLICENCA\b/.test(statusText)) return { status: 'LEAVE' };
  if (/\b(?:AFASTAR|AFASTE|AFASTAD[OA])\b/.test(statusText)) return { status: 'AWAY' };
  return null;
}

function parseVacationConfirmation(value) {
  const normalized = normalizeMentionLabel(value).replace(/^\/+/, '').trim();
  if (/^(?:RETIRAR|RETIRE|REMOVER|REMOVA|EXCLUIR|EXCLUA|APAGAR|APAGUE)(?:\s+(?:OS?\s+)?EXTRAS?)?$/.test(normalized)) return 'REMOVE';
  if (/^(?:MANTER|MANTENHA|PRESERVAR|PRESERVE|NAO\s+(?:RETIRAR|REMOVER|EXCLUIR|APAGAR))(?:\s+(?:OS?\s+)?EXTRAS?)?$/.test(normalized)) return 'KEEP';
  return null;
}

const schedulePlanStartPattern = /\bA\s+MARCACAO\s+(?:PODE\s+)?(?:INICIAR|COMECAR)\s+AGORA\b/;
const schedulePlanRowPattern = /^\s*(\d+)\s*[.)-]\s*(.+?)\s*[—–-]\s*(?:AT[EÉ]\s+)?(\d{1,2})(?:[:Hh](\d{2}))?\s*[Hh]?\s*$/i;

export function parseMarkingSchedulePlan(value) {
  const text = String(value ?? '').trim();
  const normalized = normalizeMentionLabel(text);
  const heading = normalized.match(/\bESCALA\s+DE\s+([A-Z]+)(?:\s+DE\s+(20\d{2}))?/);
  if (!heading || !schedulePlanStartPattern.test(normalized)) return null;
  const month = commandMonthNames.indexOf(heading[1]) + 1;
  const columnMatch = normalized.match(/\b([234])\s*(?:A|ª)?\s+COLUNA\b/);
  if (!month) return { error: 'Não reconheci o mês informado no cronograma.' };
  if (!columnMatch) return { error: 'Informe no cronograma se a fila é da 2ª, 3ª ou 4ª coluna.' };

  let currentDate = null;
  const entries = [];
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const dateMatch = line.match(/\b([0-3]?\d)\/(0?\d|1[0-2])\/(20\d{2})\b/);
    if (dateMatch) {
      const candidate = dayjs(`${dateMatch[3]}-${String(Number(dateMatch[2])).padStart(2, '0')}-${String(Number(dateMatch[1])).padStart(2, '0')}`);
      if (!candidate.isValid() || candidate.format('DD/MM/YYYY') !== `${String(Number(dateMatch[1])).padStart(2, '0')}/${String(Number(dateMatch[2])).padStart(2, '0')}/${dateMatch[3]}`) {
        return { error: `A data ${dateMatch[0]} é inválida.` };
      }
      currentDate = candidate.format('YYYY-MM-DD');
    }
    const row = line.match(schedulePlanRowPattern);
    if (!row) continue;
    if (!currentDate) return { error: `Informe a data antes do militar ${row[2].trim()}.` };
    const hour = Number(row[3]);
    const minute = Number(row[4] ?? 0);
    if (hour > 23 || minute > 59) return { error: `O horário informado para ${row[2].trim()} é inválido.` };
    const deadline = dayjs(`${currentDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
    entries.push({ number: Number(row[1]), name: row[2].trim(), deadlineAt: deadline.toISOString() });
  }
  if (!entries.length) return { error: 'Não encontrei a lista numerada de militares e horários no cronograma.' };
  if (entries.some((entry, index) => entry.number !== index + 1)) return { error: 'A numeração do cronograma deve começar em 1 e seguir sem pular números.' };
  const scheduleDates = new Set(entries.map((entry) => dayjs(entry.deadlineAt).format('YYYY-MM-DD')));
  if (scheduleDates.size !== 1) return { error: 'O cronograma deve terminar no mesmo dia em que começou. Para outro dia, envie um novo cronograma com data e coluna.' };
  const firstDeadline = dayjs(entries[0].deadlineAt);
  if (firstDeadline.month() + 1 !== month) return { error: 'O mês do título não corresponde à primeira data do cronograma.' };
  return { month, year: firstDeadline.year(), column: Number(columnMatch[1]), entries, error: null };
}

function parseColumnCommand(value) {
  const normalized = normalizeMentionLabel(value);
  const openMatch = normalized.match(columnOpenActionPattern);
  const closeMatch = normalized.match(columnCloseActionPattern);
  const actionMatch = openMatch ?? closeMatch;
  const columnMatch = normalized.match(columnAfterNumberPattern) ?? normalized.match(columnBeforeNumberPattern);
  if (!actionMatch || !columnMatch) return null;
  const column = /(?:4|QUARTA)/.test(columnMatch[0]) ? 4 : 3;
  const forceDelete = /\bEXCLUA\b/.test(normalized);
  const selection = normalized
    .replace(actionMatch[0], ' ')
    .replace(columnMatch[0], ' ')
    .replace(/\b(?:EXCLUA|NO|NA|DO|DA|MES|INTEIRO|TODA|TODO)\b/g, ' ');
  const exceptMatch = selection.match(/\bEXCETO\b/);
  const dateSelection = exceptMatch
    ? selection.slice((exceptMatch.index ?? 0) + exceptMatch[0].length)
    : selection;
  const parsed = parseActiveMarkingRequest(dateSelection);
  const parsedDays = [...new Set(parsed.choices.map((choice) => choice.day))];
  return {
    action: openMatch ? 'OPEN' : 'CLOSE',
    column,
    forceDelete,
    days: exceptMatch ? [] : parsedDays,
    excludedDays: exceptMatch ? parsedDays : [],
    error: parsed.error || (exceptMatch && !parsedDays.length ? 'Informe quais dias devem ficar de fora.' : null)
  };
}

async function senderIsGroupAdministrator(socket, message) {
  try {
    const metadata = await socket.groupMetadata(message.key.remoteJid);
    const context = messageContextInfo(message) ?? {};
    const senderAccounts = new Set([
      message.key.participant, message.key.participantAlt, message.key.participantPn,
      context.participant, context.participantAlt, context.participantPn
    ].filter(Boolean).map(jidAccount));
    const participant = metadata?.participants?.find((item) =>
      [item.id, item.lid, item.phoneNumber].filter(Boolean).some((jid) => senderAccounts.has(jidAccount(jid))));
    return ['admin', 'superadmin'].includes(String(participant?.admin ?? '').toLowerCase());
  } catch {
    return false;
  }
}

async function applyColumnCommand(request, requestedBy) {
  if (request.error) return request.error;
  const competency = activeCompetency();
  if (!competency) return 'Não há mês ativo para alterar as colunas.';
  const monthDates = db.prepare(`SELECT DISTINCT service_date FROM service_slots
    WHERE competency_id=? ORDER BY service_date`).all(competency.id).map((row) => row.service_date);
  const selectedDays = new Set(request.days);
  const excludedDays = new Set(request.excludedDays);
  const targetDates = request.excludedDays.length
    ? monthDates.filter((date) => !excludedDays.has(Number(dayjs(date).format('D'))))
    : request.days.length
      ? monthDates.filter((date) => selectedDays.has(Number(dayjs(date).format('D'))))
      : monthDates;
  if (!targetDates.length) return 'Não encontrei a data informada no mês ativo.';

  const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
  if (!administrator) return 'Administrador do sistema não encontrado.';
  const placeholders = targetDates.map(() => '?').join(',');
  const newCapacity = request.column === 4 ? 3 : 2;
  const assignmentsToRemove = request.action === 'CLOSE'
    ? db.prepare(`SELECT a.id,a.position_number,m.rank,m.operational_name,s.service_date,s.period
        FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id JOIN members m ON m.id=a.member_id
        WHERE s.competency_id=? AND s.service_date IN (${placeholders})
          AND a.status='CONFIRMED' AND a.position_number>? ORDER BY s.service_date,s.period,a.position_number`)
      .all(competency.id, ...targetDates, newCapacity)
    : [];
  const excludedDescription = monthDates
    .filter((date) => excludedDays.has(Number(dayjs(date).format('D'))))
    .map((date) => dayjs(date).format('DD/MM/YYYY'));
  const dateDescription = request.excludedDays.length
    ? `Exceto: ${excludedDescription.join(', ')}`
    : request.days.length
      ? `${targetDates.length === 1 ? 'Data' : 'Datas'}: ${targetDates.map((date) => dayjs(date).format('DD/MM/YYYY')).join(', ')}`
      : '';
  const canonicalDates = request.excludedDays.length
    ? `exceto dias ${request.excludedDays.join(', ')}`
    : request.days.length
      ? `dia ${targetDates.map((date) => Number(dayjs(date).format('D'))).join(', ')}`
      : 'no mês inteiro';

  if (assignmentsToRemove.length && !request.forceDelete) {
    const affected = assignmentsToRemove.slice(0, 12).map((assignment) =>
      `• ${dayjs(assignment.service_date).format('DD/MM')} ${periodLabel(assignment.period)}, ${assignment.position_number}ª posição: ${assignment.rank} ${assignment.operational_name}`);
    if (assignmentsToRemove.length > affected.length) affected.push(`• e mais ${assignmentsToRemove.length - affected.length} marcação(ões)`);
    return `⚠️ *${request.column}ª COLUNA NÃO FOI FECHADA*

Existem ${assignmentsToRemove.length} marcação(ões) na(s) posição(ões) que serão fechadas.

${affected.join('\n')}

Para excluir essas marcações e fechar, envie:
*@Escalante fechar ${request.column}ª coluna ${canonicalDates} EXCLUA*`;
  }

  const previous = new Map(db.prepare(`SELECT service_date,third_column_open,fourth_column_open
    FROM schedule_pdf_column_releases WHERE competency_id=?`).all(competency.id).map((row) => [row.service_date, row]));
  const resultingColumns = [];
  db.transaction(() => {
    if (request.action === 'CLOSE' && request.forceDelete) {
      const remove = db.prepare('DELETE FROM assignments WHERE id=?');
      for (const assignment of assignmentsToRemove) remove.run(assignment.id);
    }
    const save = db.prepare(`INSERT INTO schedule_pdf_column_releases
      (competency_id,service_date,third_column_open,fourth_column_open,updated_by,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(competency_id,service_date) DO UPDATE SET
      third_column_open=excluded.third_column_open,fourth_column_open=excluded.fourth_column_open,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
    const removeRelease = db.prepare('DELETE FROM schedule_pdf_column_releases WHERE competency_id=? AND service_date=?');
    const updateCapacity = db.prepare(`UPDATE service_slots SET current_capacity=?,updated_at=?
      WHERE competency_id=? AND service_date=?`);
    const stamp = now();
    for (const serviceDate of targetDates) {
      const before = previous.get(serviceDate);
      let third = Boolean(before?.third_column_open || before?.fourth_column_open);
      let fourth = Boolean(before?.fourth_column_open);
      if (request.action === 'OPEN') {
        if (request.column === 3) third = true;
        else { third = true; fourth = true; }
      } else if (request.column === 4) fourth = false;
      else { third = false; fourth = false; }
      const capacity = fourth ? 4 : third ? 3 : 2;
      if (third || fourth) save.run(competency.id, serviceDate, Number(third), Number(fourth), administrator.id, stamp);
      else removeRelease.run(competency.id, serviceDate);
      updateCapacity.run(capacity, stamp, competency.id, serviceDate);
      resultingColumns.push({ serviceDate, third, fourth, capacity });
    }
  })();
  audit({ userId: administrator.id, action: `WHATSAPP_${request.action}_COLUMN`, entityType: 'SCHEDULE_PDF', entityId: competency.id,
    before: { assignmentsToRemove }, after: { column: request.column, dates: targetDates, excludedDays: request.excludedDays, resultingColumns },
    reason: `Solicitado no grupo por ${requestedBy.rank} ${requestedBy.operational_name}` });

  const removed = assignmentsToRemove.length && request.forceDelete
    ? `\n${assignmentsToRemove.length} marcação(ões) excluída(s).`
    : '';
  return `*${request.column}ª COLUNA ${request.action === 'OPEN' ? 'ABERTA' : 'FECHADA'}*
${dateDescription}${removed}`.trim();
}

function extractDisplayPrefix(value) {
  const text = String(value ?? '');
  const matches = [...text.matchAll(/\(([^()]*)\)/g)];
  if (!matches.length) return { text, displayPrefix: null, error: null };
  if (matches.length > 1) return { text, displayPrefix: null, error: 'Informe somente uma observação entre parênteses por militar.' };
  const displayPrefix = matches[0][1].trim().replace(/\s+/g, ' ').replace(/\|/g, '/');
  if (!displayPrefix || displayPrefix.length > 40) {
    return { text, displayPrefix: null, error: 'A observação entre parênteses deve ter de 1 a 40 caracteres.' };
  }
  return {
    text: `${text.slice(0, matches[0].index)} ${text.slice(matches[0].index + matches[0][0].length)}`,
    displayPrefix,
    error: null
  };
}

function multiTargetSegments(socket, message, body, targets) {
  const structuredMentions = messageContextInfo(message)?.mentionedJid ?? [];
  const writtenMentions = [...body.matchAll(/@\S+/g)];
  if (writtenMentions.length !== structuredMentions.length) return null;
  const targetsByAccount = new Map(targets.map((target) => [jidAccount(target.jid), target.member]));
  const anchors = [];
  structuredMentions.forEach((jid, index) => {
    const member = targetsByAccount.get(jidAccount(jid));
    const mention = writtenMentions[index];
    if (member && mention) anchors.push({ member, start: mention.index, end: mention.index + mention[0].length });
  });
  if (anchors.length !== targets.length) return null;
  return anchors.map((anchor, index) => ({
    member: anchor.member,
    text: body.slice(anchor.end, anchors[index + 1]?.start ?? body.length)
  }));
}

async function assignMultipleMentionedMembers(socket, message, body, targets) {
  const segments = multiTargetSegments(socket, message, body, targets);
  if (!segments) return 'Não consegui separar o pedido de cada militar. Nenhuma marcação foi feita. Informe o turno logo depois de cada contato marcado.';

  const planned = [];
  let inheritedDay = null;
  for (const segment of segments) {
    const decorated = extractDisplayPrefix(segment.text);
    if (decorated.error) return `${decorated.error} Nenhuma marcação foi feita.`;
    let parsed = parseActiveMarkingRequest(decorated.text);
    // Em "@Fragoso hoje dia e @Gelson noite", o segundo trecho herda a
    // mesma data. A herança só é aceita quando o trecho anterior tem um dia.
    if ((parsed.error || !parsed.choices.length) && inheritedDay) {
      const inherited = parseActiveMarkingRequest(`${inheritedDay} ${decorated.text}`);
      if (!inherited.error && inherited.choices.length) parsed = inherited;
    }
    if (parsed.error || !parsed.choices.length) {
      return `Não entendi o dia e o turno de *${segment.member.rank} ${segment.member.operational_name}*. Nenhuma marcação foi feita. Coloque o pedido logo após cada militar.`;
    }
    const days = [...new Set(parsed.choices.map((choice) => choice.day))];
    inheritedDay = days.length === 1 ? days[0] : null;
    planned.push({ member: segment.member, choices: parsed.choices, displayPrefix: decorated.displayPrefix });
  }

  const results = [];
  const mentions = [];
  for (const item of planned) {
    const result = await assignNaturalChoices(item.member, item.choices, { displayPrefix: item.displayPrefix });
    if (result?.type === 'TEXT') {
      results.push(`*${item.member.rank.toUpperCase()} ${item.member.operational_name.toUpperCase()}*\n${result.text}`);
      mentions.push(...(result.mentions ?? []));
    } else {
      results.push(`*${item.member.rank.toUpperCase()} ${item.member.operational_name.toUpperCase()}*\n${result}`);
    }
  }
  return { type: 'TEXT', text: `*RESULTADO PARA ${planned.length} MILITARES*\n\n${results.join('\n\n')}`, mentions: [...new Set(mentions)] };
}

function logOutboundMessage(socket, result, remoteJid, body) {
  db.prepare(`INSERT OR IGNORE INTO whatsapp_messages
    (message_id,remote_jid,sender_jid,direction,body,created_at) VALUES (?,?,?,?,?,?)`)
    .run(result?.key?.id ?? `OUT-${Date.now()}`, remoteJid, socket.user?.id ?? null, 'OUTBOUND', String(body ?? '').slice(0, 2000), now());
}

export async function handleIncomingMessages(socket, { messages }) {
  for (const message of messages) {
    if (!message.message || message.key.fromMe || message.key.remoteJid === 'status@broadcast') continue;
    const remoteJid = message.key.remoteJid;
    const messageId = message.key.id;
    const body = textFromMessage(message).trim();
    if (!remoteJid?.endsWith('@g.us') || !messageId || !body) continue;
    if (!configuredGroupJids().includes(remoteJid)) continue;
    // Aprende silenciosamente o vínculo PN/LID dos participantes. Mensagens comuns
    // continuam sem interpretação e sem resposta até alguém chamar o bot.
    const originalIdentity = resolveMemberIdentity(message.key);
    if (!isAddressedToBot(socket, message, body)) continue;
    const directText = withoutBotMention(body);
    const directMultilineText = withoutBotMentionPreservingLines(body);
    const directSelection = parseMarkingRequest(directText);
    const directChoices = directSelection.choices;
    const directTarget = await mentionedMember(socket, message);
    const columnRequest = parseColumnCommand(directText);
    const markingScheduleRequest = parseMarkingScheduleCommand(directText);
    const markingSchedulePlan = parseMarkingSchedulePlan(directMultilineText);
    const memberStatusRequest = parseMemberStatusCommand(directText);
    const vacationConfirmation = parseVacationConfirmation(directText);
    const groupAdministrator = columnRequest || markingScheduleRequest?.action === 'START' || markingSchedulePlan || memberStatusRequest || vacationConfirmation
      ? await senderIsGroupAdministrator(socket, message)
      : false;
    const multiTargetRequest = directTarget.targets?.length > 1 && isDelegatedMarkingText(directText);
    const quotedCandidate = quotedMemberRequest(socket, message);
    const hasDirectMarkingRequest = directChoices.length > 0 || Boolean(directSelection.error)
      || isDelegatedMarkingText(directText) || isDelegatedRemovalText(directText) || isAssignmentChangeText(directText)
      || Boolean(memberStatusRequest) || Boolean(vacationConfirmation);
    // Ao responder a mensagem de um militar, um pedido novo sem outro @militar
    // usa o autor citado como alvo. Um @militar explícito continua prioritário.
    const quotedTargetIdentity = !directTarget.required && hasDirectMarkingRequest && quotedCandidate
      ? await resolveMemberIdentityWithMapping(socket, quotedCandidate.key)
      : null;
    // A new command takes precedence over a quoted message. Quoting a request
    // and only calling the bot still delegates to the original author.
    const hasDirectRequest = directTarget.required || directChoices.length > 0 || Boolean(directSelection.error)
      || directText.startsWith('/') || isDelegatedMarkingText(directText) || isDelegatedRemovalText(directText)
      || isAssignmentChangeText(directText) || Boolean(markingSchedulePlan) || Boolean(memberStatusRequest) || Boolean(vacationConfirmation);
    const quotedRequest = hasDirectRequest ? null : quotedCandidate;
    const effectiveBody = quotedRequest?.body ?? body;
    const explicitSlash = effectiveBody.startsWith('/');
    const commandText = markingSchedulePlan && !quotedRequest
      ? directMultilineText
      : withoutBotMention(effectiveBody);
    const identity = quotedRequest
      ? await resolveMemberIdentityWithMapping(socket, quotedRequest.key)
      : (originalIdentity.member ? originalIdentity : await resolveMemberIdentityWithMapping(socket, message.key));
    const targetMember = quotedRequest ? null : (directTarget.member ?? quotedTargetIdentity?.member ?? null);
    const quotedTargetMissing = Boolean(quotedTargetIdentity && !quotedTargetIdentity.member);
    const senderJid = identity.senderJid;
    if (!senderJid) continue;
    const processedMessageId = messageId;
    const processed = db.prepare('INSERT OR IGNORE INTO processed_messages (message_id,sender_jid,received_at,processed_at) VALUES (?,?,?,?)').run(processedMessageId, senderJid, now(), now());
    if (!processed.changes) continue;
    console.info(JSON.stringify({ event: 'whatsapp_command', handlerVersion: commandHandlerVersion, pid: process.pid,
      messageId, senderMemberId: originalIdentity.member?.id ?? null,
      targetMemberId: quotedRequest ? identity.member?.id ?? null : targetMember?.id ?? (directTarget.required ? null : identity.member?.id ?? null),
      targetMemberIds: directTarget.targets?.length > 1 ? directTarget.targets.map((target) => target.member.id) : undefined,
      source: quotedRequest ? 'QUOTE' : quotedTargetIdentity ? 'QUOTE_TARGET' : directTarget.source,
      rejected: Boolean((!quotedRequest && directTarget.error && !multiTargetRequest && !isAssignmentChangeText(directText)) || quotedTargetMissing) }));
    db.prepare('INSERT OR IGNORE INTO whatsapp_messages (message_id,remote_jid,sender_jid,direction,body,created_at) VALUES (?,?,?,?,?,?)')
      .run(processedMessageId, remoteJid, senderJid, 'INBOUND', effectiveBody.slice(0, 2000), now());
    const reply = identity.member
      ? isAssignmentChangeText(directText)
        ? await changeExtraAssignment(socket, message, body, directText,
          directTarget.targets?.length ? directTarget.targets : targetMember ? [{ member: targetMember }] : [], identity.member)
      : multiTargetRequest
        ? await assignMultipleMentionedMembers(socket, message, body, directTarget.targets)
        : quotedTargetMissing
        ? 'O autor da mensagem citada não está cadastrado no efetivo. Nenhuma marcação foi feita.'
        : !quotedRequest && directTarget.error
        ? directTarget.error
        : await executeCommand(identity.member, commandText, {
          explicitSlash,
          targetMember,
          requiresTarget: !quotedRequest && (directTarget.required || Boolean(quotedTargetIdentity)),
          groupAdministrator,
          groupJid: remoteJid
        })
      : quotedRequest
        ? 'O autor da mensagem citada não está cadastrado no efetivo.'
        : 'Seu telefone não está cadastrado no efetivo. Peça ao escalante para preencher seu número no painel.';
    if (reply?.type === 'TEXT') {
      const sent = await socket.sendMessage(remoteJid, { text: reply.text, mentions: reply.mentions ?? [] }, { quoted: message });
      logOutboundMessage(socket, sent, remoteJid, reply.text);
      if (reply.pdf) {
        const document = await socket.sendMessage(remoteJid, {
          document: reply.pdf.buffer,
          mimetype: 'application/pdf',
          fileName: reply.pdf.fileName,
          caption: `Escala de ${reply.pdf.competencyName}.`
        });
        logOutboundMessage(socket, document, remoteJid, `Escala de ${reply.pdf.competencyName}.`);
      }
    } else if (reply?.type === 'PDF') {
      const sent = await socket.sendMessage(remoteJid, { document: reply.buffer, mimetype: 'application/pdf', fileName: reply.fileName, caption: `Escala de ${reply.competencyName}.` }, { quoted: message });
      logOutboundMessage(socket, sent, remoteJid, `Escala de ${reply.competencyName}.`);
    } else if (reply) {
      const sent = await socket.sendMessage(remoteJid, { text: reply }, { quoted: message });
      logOutboundMessage(socket, sent, remoteJid, reply);
    }
  }
}

function jidCandidates(key) {
  return [...new Set([
    key.participant,
    key.participantAlt,
    key.participantPn,
    key.senderPn,
    key.remoteJid?.endsWith('@g.us') ? null : key.remoteJid,
    key.remoteJidAlt
  ].filter((jid) => typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))))];
}

function phoneFromJid(jid) {
  if (!jid?.endsWith('@s.whatsapp.net')) return null;
  const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return phone.length >= 10 ? phone : null;
}

export function phoneVariants(phoneNumber) {
  if (!phoneNumber) return [];
  const variants = new Set([phoneNumber]);
  if (phoneNumber.startsWith('55') && phoneNumber.length === 13 && phoneNumber[4] === '9') {
    variants.add(`${phoneNumber.slice(0, 4)}${phoneNumber.slice(5)}`);
  }
  if (phoneNumber.startsWith('55') && phoneNumber.length === 12) {
    variants.add(`${phoneNumber.slice(0, 4)}9${phoneNumber.slice(4)}`);
  }
  return [...variants];
}

function resolveMemberIdentity(key) {
  const candidates = jidCandidates(key);
  const phoneJid = candidates.find((jid) => jid.endsWith('@s.whatsapp.net')) ?? null;
  const phoneNumber = phoneFromJid(phoneJid);
  let member = null;
  const findByJid = db.prepare('SELECT * FROM members WHERE whatsapp_jid=?');
  const findByIdentity = db.prepare(`SELECT m.* FROM member_whatsapp_identities i JOIN members m ON m.id=i.member_id WHERE i.jid=?`);
  for (const jid of candidates) {
    member = findByJid.get(jid) ?? findByIdentity.get(jid);
    if (member) break;
  }
  if (!member && phoneNumber) {
    const findByPhone = db.prepare('SELECT * FROM members WHERE phone_number=?');
    for (const candidate of phoneVariants(phoneNumber)) {
      member = findByPhone.get(candidate);
      if (member) break;
    }
  }
  if (member) {
    const register = db.prepare(`INSERT OR IGNORE INTO member_whatsapp_identities (member_id,jid,phone_number,source,verified_at) VALUES (?,?,?,?,?)`);
    for (const jid of candidates) register.run(member.id, jid, phoneNumber, 'MESSAGE', now());
    if (phoneJid && member.whatsapp_jid !== phoneJid) {
      db.prepare('UPDATE members SET whatsapp_jid=?,updated_at=? WHERE id=?').run(phoneJid, now(), member.id);
      member = { ...member, whatsapp_jid: phoneJid };
    }
    if (!member.phone_number && phoneNumber) {
      db.prepare('UPDATE members SET phone_number=?,updated_at=? WHERE id=?').run(phoneNumber, now(), member.id);
      member = { ...member, phone_number: phoneNumber };
    }
  }
  return { member, senderJid: phoneJid ?? candidates[0] ?? key.participant ?? key.remoteJid, phoneNumber };
}

async function resolveMemberIdentityWithMapping(socket, key) {
  const direct = resolveMemberIdentity(key);
  if (direct.member) return direct;
  const lid = jidCandidates(key).find((jid) => jid.endsWith('@lid'));
  if (!lid) return direct;

  let phoneJid = null;
  try {
    phoneJid = await socket.signalRepository?.lidMapping?.getPNForLID?.(lid);
  } catch { /* O metadado do grupo abaixo ainda pode fornecer o telefone. */ }
  if (!phoneJid && key.remoteJid?.endsWith('@g.us')) {
    try {
      const metadata = await socket.groupMetadata(key.remoteJid);
      const participant = metadata?.participants?.find((item) => item.id === lid || item.lid === lid);
      phoneJid = participant?.phoneNumber
        ?? (participant?.id?.endsWith('@s.whatsapp.net') ? participant.id : null);
    } catch { /* Sem mapeamento disponível; mantém o resultado original. */ }
  }
  if (!phoneJid?.endsWith('@s.whatsapp.net')) return direct;
  return resolveMemberIdentity({ ...key, participantPn: phoneJid, participantAlt: lid });
}

export async function discoverMemberWhatsAppJid(memberId) {
  const member = db.prepare('SELECT id,phone_number,whatsapp_jid FROM members WHERE id=?').get(memberId);
  if (!member?.phone_number || !connection.socket || connection.status !== 'CONNECTED' || typeof connection.socket.onWhatsApp !== 'function') return member ?? null;
  const candidates = phoneVariants(member.phone_number).map((phone) => `${phone}@s.whatsapp.net`);
  const found = await connection.socket.onWhatsApp(...candidates);
  const match = found?.find((item) => item?.exists && typeof (item.jid ?? item.pn ?? item.lid) === 'string');
  const phoneJid = [match?.jid, match?.pn].find((jid) => jid?.endsWith('@s.whatsapp.net')) ?? null;
  const lidJid = match?.lid?.endsWith('@lid') ? match.lid : null;
  const preferredJid = phoneJid ?? member.whatsapp_jid;
  if (!phoneJid && !lidJid) return member;
  db.transaction(() => {
    if (preferredJid) db.prepare('UPDATE members SET whatsapp_jid=?,updated_at=? WHERE id=?').run(preferredJid, now(), member.id);
    const register = db.prepare(`INSERT OR IGNORE INTO member_whatsapp_identities
      (member_id,jid,phone_number,source,verified_at) VALUES (?,?,?,?,?)`);
    for (const jid of [phoneJid, lidJid].filter(Boolean)) register.run(member.id, jid, member.phone_number, 'DISCOVERY', now());
  })();
  return db.prepare('SELECT id,phone_number,whatsapp_jid FROM members WHERE id=?').get(member.id);
}

function commandMenu() {
  return `*ESCALA - COMO USAR*

O bot responde de cinco formas:

1. Com atalho: */vagas*
2. Marcando o bot: *quero ver as vagas*
3. Respondendo uma mensagem dele naturalmente:
   *04; 05 noite*
4. Respondendo à mensagem de outro participante e marcando o bot.
   O pedido citado será executado para o autor original.
5. Marcando o bot e o militar que receberá a vaga:
   *@Escalante coloque @militar dia 12 à noite*
   *@Escalante marque @militar dia 12, 24 horas*
   Para dois: *@Escalante escalar @militar1 hoje dia e @militar2 noite*

Para retirar somente serviços extras:
   *@Escalante retirar @militar do dia 19, dia*
   *@Escalante excluir @militar do dia 19, 24h*
Aceita retirar, tirar, excluir, remover ou apagar e tolera erro de uma letra nesses verbos.
Quando informar apenas o dia, todos os extras desse militar no dia serão retirados.

Para ajustar somente serviços extras:
   *Trocar militar:* @Escalante troque @militar1 dia 17 noite por @militar2
   *Permutar horários:* @Escalante permute @militar1 dia 17 noite com @militar2 dia 20 dia
   *Remanejar:* @Escalante remaneje @militar1 do dia 17 noite para dia 20 dia
Cada lado da troca deve informar somente um turno. O bot mostra o antes e o depois.

Para justificar uma escala ordinária que já existe:
   *@Escalante @militar hoje dia (afastado)*
   *@Escalante @militar dia 17 noite (licença)*
   */justificar @militar hoje dia (afastado)*
   */justificar @militar dia 17 noite (licença)*
O texto entre parênteses aparece depois do nome. Se a escala ordinária não existir para o militar naquele horário, nada será criado.

Quando informar somente o dia, o sistema marca dia e noite (24 horas).

Exemplos de dias e turnos:
*20 dia* ou *20 D* — 07h às 19h.
*20 noite* ou *20 N* — 19h às 07h.
*20 24h* — dia e noite.
*20 e 21 noite* — as duas noites.
*20 dia; 21 noite* — um turno diferente em cada dia.
Também aceita vírgula: *dia 20, dia*.
*12h* sozinho não define o turno: informe dia ou noite.
Também entende a data atual: *12h dia hoje* ou *hoje à noite*.

Outros atalhos:
*/status* - consulta seu cadastro
*/minhas* - suas marcações
*/horas @pessoa* - horas e horários confirmados de um militar
*/cronograma* - mostra a ordem e o horário limite de cada militar
*@Escalante iniciar cronograma dia 25/10/2026 2ª coluna* - programa a fila (somente administrador do grupo)
*/escala* - recebe a escala em PDF
*/meses* - mostra os meses gerados e qual está ativo
*/escala 10/2026* - troca o mês ativo e envia o novo PDF
*/gerar-proximo-mes* - mostra o aviso antes de gerar
*/confirmar-gerar-proximo-mes* - confirma a geração e publica o PDF
*/cancelar 125* - cancela uma marcação
*/passo a vez* - não marca nesta rodada

Comandos para administradores do grupo:
*@Escalante coloque @militar de férias* - altera para férias
Também aceita *licença*, *afastado*, *ativo* e *desativado*.
*@Escalante abrir 3ª coluna* - abre no mês inteiro
*@Escalante abrir 4ª coluna dia 17* - abre somente nessa data
*@Escalante abrir 4ª coluna exceto dias 17 e 18* - abre nos demais dias
*@Escalante fechar 4ª coluna dia 17* - fecha se a posição estiver vazia
Se houver marcações, o bot não fecha e pede uma confirmação terminada em *EXCLUA*.

Envie */comandos* ou apenas *comandos* para ver esta lista.`;
}

const commandMonthNames = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

function findGeneratedCompetency(selector) {
  const normalized = selector.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const competencies = db.prepare('SELECT * FROM competencies WHERE generated_at IS NOT NULL ORDER BY year,month').all();
  if (/PROXIM[OA]/.test(normalized)) {
    const active = activeCompetency();
    const activeIndex = active ? active.year * 12 + active.month : dayjs().year() * 12 + dayjs().month() + 1;
    return competencies.find((item) => item.year * 12 + item.month > activeIndex) ?? null;
  }
  let month = null;
  let year = null;
  const numeric = normalized.match(/\b(0?[1-9]|1[0-2])\s*[\/-]\s*(20\d{2})\b/);
  const iso = normalized.match(/\b(20\d{2})\s*-\s*(0?[1-9]|1[0-2])\b/);
  if (numeric) { month = Number(numeric[1]); year = Number(numeric[2]); }
  else if (iso) { year = Number(iso[1]); month = Number(iso[2]); }
  else {
    month = commandMonthNames.findIndex((name) => normalized.includes(name)) + 1 || null;
    year = Number(normalized.match(/\b20\d{2}\b/)?.[0]) || null;
  }
  if (!month) return null;
  if (year) return competencies.find((item) => item.year === year && item.month === month) ?? null;
  const currentIndex = dayjs().year() * 12 + dayjs().month() + 1;
  return competencies.find((item) => item.month === month && item.year * 12 + item.month >= currentIndex)
    ?? [...competencies].reverse().find((item) => item.month === month)
    ?? null;
}

function generatedCompetenciesMessage() {
  const active = activeCompetency();
  const items = db.prepare('SELECT id,name FROM competencies WHERE generated_at IS NOT NULL ORDER BY year DESC,month DESC LIMIT 18').all();
  if (!items.length) return 'Nenhum mês foi gerado ainda.';
  return `*MESES GERADOS*\n\n${items.map((item) => `${item.id === active?.id ? '✅' : '•'} ${item.name}${item.id === active?.id ? ' — ativa no /escala' : ''}`).join('\n')}\n\nPara trocar e enviar o PDF:\n*/escala 10/2026*`;
}

async function activateCompetencyFromGroup(selector, member) {
  const competency = findGeneratedCompetency(selector);
  if (!competency) return `Não encontrei esse mês entre as escalas geradas. Envie */meses* para consultar.`;
  setActiveWhatsAppCompetency(competency.id, null);
  audit({ action: 'BOT_ACTIVE_COMPETENCY_CHANGE', entityType: 'COMPETENCY', entityId: competency.id, after: competency, reason: `Alterada pelo grupo por ${member.rank} ${member.operational_name}` });
  const pdf = await schedulePdfMessage();
  return {
    type: 'TEXT',
    text: `*MÊS DA ESCALA ALTERADO*\n\nAgora o comando */escala* enviará *${competency.name}*.`,
    mentions: [],
    pdf: pdf?.type === 'PDF' ? pdf : null
  };
}

async function generateNextMonthFromGroup() {
  const { sendMonthlyOpening } = await import('./automation.js');
  const result = await sendMonthlyOpening({ force: true, advance: true });
  if (!result.sent) return result.reason || 'Não foi possível gerar o próximo mês.';
  const generation = result.generation;
  return `*PRÓXIMO MÊS GERADO*\n\n*${result.competency.name}*\n${generation.ordinaryDutyDays} serviços ordinários programados no ciclo 1x4.\n${generation.assignmentsCreated} turnos ordinários novos.\n${generation.skippedMembers.length} integrantes ignorados por situação ou autorização.\n${generation.unavailableDays.length} serviços não preenchidos por indisponibilidade.\n${generation.conflictDays.length} conflitos para revisão no painel.\n\nO PDF foi publicado no grupo. As marcações restantes serão extras.`;
}

function nextMonthGenerationWarning() {
  const latest = db.prepare('SELECT year,month FROM competencies WHERE generated_at IS NOT NULL ORDER BY year DESC,month DESC LIMIT 1').get();
  const current = dayjs().startOf('month');
  const latestDate = latest ? dayjs(`${latest.year}-${String(latest.month).padStart(2, '0')}-01`) : current;
  const target = (latestDate.isAfter(current, 'month') ? latestDate : current).add(1, 'month');
  const monthName = commandMonthNames[target.month()];
  return `⚠️ *CONFIRMAR GERAÇÃO DO PRÓXIMO MÊS*\n\nSerá criada a escala de *${monthName} de ${target.year()}* com o ciclo ordinário 1x4.\n\n• O mês atual não será apagado.\n• O novo PDF será publicado nos grupos.\n• O novo mês passará a ser usado pelo comando /escala.\n• A fila de marcação poderá ser iniciada.\n\nPara continuar, envie exatamente:\n*/confirmar-gerar-proximo-mes*\n\nPara desistir, não envie a confirmação.`;
}

const normalizeRosterLabel = (value) => normalizeMentionLabel(value).replace(/[^A-Z0-9]+/g, ' ').trim();

async function saveAndStartMarkingSchedulePlan(plan, requestedBy) {
  if (plan.error) return plan.error;
  const competency = db.prepare(`SELECT * FROM competencies
    WHERE year=? AND month=? AND generated_at IS NOT NULL`).get(plan.year, plan.month);
  if (!competency) return `A escala de ${String(plan.month).padStart(2, '0')}/${plan.year} ainda não foi gerada.`;
  if (plan.column > 2) {
    const opened = db.prepare(`SELECT 1 FROM service_slots
      WHERE competency_id=? AND current_capacity>=? LIMIT 1`).get(competency.id, plan.column);
    if (!opened) return `A ${plan.column}ª coluna ainda não está aberta. Abra a coluna antes de iniciar este cronograma.`;
  }
  const members = db.prepare(`SELECT id,rank,operational_name,seniority_position
    FROM members WHERE seniority_position IS NOT NULL AND active=1
      AND operational_status='ACTIVE' AND authorization_status='AUTHORIZED'
    ORDER BY seniority_position`).all();
  const memberByLabel = new Map();
  for (const member of members) {
    const label = normalizeRosterLabel(`${member.rank} ${member.operational_name}`);
    if (memberByLabel.has(label)) return `Existem militares com nomes iguais na Antiguidade: ${member.rank} ${member.operational_name}.`;
    memberByLabel.set(label, member);
  }
  const scheduled = [];
  const usedMembers = new Set();
  for (const [index, entry] of plan.entries.entries()) {
    const member = memberByLabel.get(normalizeRosterLabel(entry.name));
    if (!member) return `Não encontrei *${entry.name}* na Antiguidade exatamente como informado.`;
    if (usedMembers.has(member.id)) return `O militar *${member.rank} ${member.operational_name}* aparece mais de uma vez no cronograma.`;
    if (index && member.seniority_position <= scheduled[index - 1].member.seniority_position) {
      return `A ordem está diferente da Antiguidade. O militar *${member.rank} ${member.operational_name}* precisa respeitar a ordem dos nomes enviados.`;
    }
    usedMembers.add(member.id);
    scheduled.push({ member, deadlineAt: entry.deadlineAt });
  }
  for (let index = 0; index < scheduled.length; index += 1) {
    const deadline = new Date(scheduled[index].deadlineAt);
    if (deadline <= new Date()) return `O horário de *${scheduled[index].member.rank} ${scheduled[index].member.operational_name}* já passou.`;
    if (index && deadline <= new Date(scheduled[index - 1].deadlineAt)) {
      return `O horário de *${scheduled[index].member.rank} ${scheduled[index].member.operational_name}* precisa ser posterior ao militar anterior.`;
    }
  }
  const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
  if (!administrator) return 'Administrador do sistema não encontrado.';
  const stamp = now();
  db.transaction(() => {
    db.prepare(`DELETE FROM marking_deadlines WHERE member_id IN (
      SELECT id FROM members WHERE seniority_position IS NOT NULL AND active=1
        AND operational_status='ACTIVE' AND authorization_status='AUTHORIZED'
    )`).run();
    const save = db.prepare(`INSERT INTO marking_deadlines (member_id,deadline_at,updated_by,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET
      deadline_at=excluded.deadline_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
    for (const item of scheduled) save.run(item.member.id, item.deadlineAt, administrator.id, stamp);
  })();
  audit({ userId: administrator.id, action: 'WHATSAPP_IMPORT_MARKING_SCHEDULE', entityType: 'COMPETENCY', entityId: competency.id,
    after: { column: plan.column, deadlines: scheduled.map((item) => ({ memberId: item.member.id, deadlineAt: item.deadlineAt })) },
    reason: `Cronograma enviado no grupo por ${requestedBy.rank} ${requestedBy.operational_name}` });
  const { startColumnMarkingRound } = await import('./automation.js');
  const startsAt = dayjs(plan.entries[0].deadlineAt).startOf('day').hour(markingRoundStartHour).minute(0).second(0).millisecond(0);
  const result = await startColumnMarkingRound({ competencyId: competency.id, column: plan.column,
    userId: administrator.id, reason: `WHATSAPP_IMPORTED_SCHEDULE_BY_${requestedBy.id}`, rebaseDeadlines: false,
    startsAt: startsAt.toISOString() });
  if (!result.started) return `Horários do cronograma salvos, mas a fila não foi iniciada: ${result.reason}`;
  if (result.scheduled) {
    return `*CRONOGRAMA PROGRAMADO*\n${competency.name} — ${plan.column}ª coluna.\nInício: ${startsAt.format('DD/MM/YYYY [às] HH:mm')}.\n\nA fila vale somente para essa data e coluna. Ao terminar, a marcação ficará livre.`;
  }
  return `*CRONOGRAMA INICIADO*\n${competency.name} — ${plan.column}ª coluna.\n\nA fila vale somente para essa data e coluna. Ao terminar, a marcação ficará livre.`;
}

async function executeCommand(member, rawBody, { explicitSlash = false, targetMember = null, requiresTarget = false, groupAdministrator = false, groupJid = null } = {}) {
  if (requiresTarget && !targetMember) return 'Não identifiquei o militar marcado. Nenhuma marcação foi feita.';
  const commandBody = rawBody.trim().replace(/^\/+/, '').trim();
  const decoratedRequest = extractDisplayPrefix(commandBody);
  if (decoratedRequest.error) return decoratedRequest.error;
  const normalized = decoratedRequest.text.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const [command, argument] = normalized.split(/\s+/, 2);
  if (['MENU', 'AJUDA', 'COMANDOS'].includes(command)) return commandMenu();
  if (command === 'MESES') return generatedCompetenciesMessage();
  const vacationConfirmation = parseVacationConfirmation(commandBody);
  if (vacationConfirmation) {
    if (!groupAdministrator) return 'Somente administradores do grupo podem confirmar a alteração para férias.';
    return confirmPendingVacation(vacationConfirmation, member, groupJid);
  }
  const parseSelection = parseActiveMarkingRequest;
  const columnRequest = parseColumnCommand(commandBody);
  if (columnRequest) {
    if (!groupAdministrator) return 'Somente administradores do grupo podem abrir ou fechar colunas.';
    return applyColumnCommand(columnRequest, member);
  }
  const markingSchedulePlan = parseMarkingSchedulePlan(rawBody);
  if (markingSchedulePlan) {
    if (!groupAdministrator) return 'Somente administradores do grupo podem preencher horários e iniciar a fila pelo cronograma.';
    return saveAndStartMarkingSchedulePlan(markingSchedulePlan, member);
  }
  const memberStatusRequest = parseMemberStatusCommand(commandBody);
  if (memberStatusRequest) {
    if (!groupAdministrator) return 'Somente administradores do grupo podem alterar a situação de um militar.';
    if (!targetMember || !requiresTarget) return 'Marque um militar. Exemplo: *@Escalante coloque @militar de férias*.';
    return changeMemberOperationalStatus(targetMember, memberStatusRequest.status, member, memberStatusRequest.extraAction ?? null, groupJid);
  }
  if (['JUSTIFICAR', 'JUSTIFICA', 'JUSTIFIQUE'].includes(command)) {
    const justifiedMember = targetMember ?? (!requiresTarget ? member : null);
    if (!justifiedMember) return 'Marque o militar cuja escala será justificada. Exemplo: */justificar @militar hoje dia (afastado)*.';
    if (!decoratedRequest.displayPrefix) return 'Escreva a justificativa entre parênteses. Exemplo: */justificar @militar hoje dia (afastado)*.';
    const selection = decoratedRequest.text.replace(/^\s*JUSTIFI(?:CAR|CA|QUE)\b/i, ' ');
    const parsed = parseSelection(selection);
    if (parsed.error) return parsed.error;
    if (!parsed.choices.length) return 'Informe o dia e, se desejar, o turno da escala ordinária que será justificada.';
    return justifyOrdinaryAssignments(justifiedMember, parsed.choices, decoratedRequest.displayPrefix, member);
  }
  if (decoratedRequest.displayPrefix) {
    const isBareOrdinaryJustification = targetMember && requiresTarget
      && !isDelegatedMarkingText(normalized)
      && !isDelegatedRemovalText(normalized)
      && !isAssignmentChangeText(normalized);
    if (isBareOrdinaryJustification) {
      const parsed = parseSelection(decoratedRequest.text);
      if (parsed.error) return parsed.error;
      if (!parsed.choices.length) return 'Informe o dia e, se desejar, o turno da escala ordinária que será justificada.';
      return justifyOrdinaryAssignments(targetMember, parsed.choices, decoratedRequest.displayPrefix, member);
    }
    return 'Uma justificativa não cria marcação. Use */justificar @militar dia e turno (motivo)* para alterar uma escala ordinária já existente. Nada foi criado.';
  }
  const delegatedRemoval = isDelegatedRemovalText(normalized);
  if (delegatedRemoval) {
    const selection = removeDelegatedRemovalAction(normalized);
    const parsed = parseSelection(selection);
    if (parsed.error) return parsed.error;
    if (!parsed.choices.length) return `Informe o dia e, se desejar, o turno que será retirado de *${(targetMember ?? member).rank} ${(targetMember ?? member).operational_name}*. Exemplo: *retirar @militar do dia 19, noite*.`;
    return removeExtraNaturalChoices(targetMember ?? member, parsed.choices, member);
  }
  const delegatedAction = isDelegatedMarkingText(normalized);
  const delegatedSelection = parseSelection(normalized);
  if (targetMember && (delegatedAction || (requiresTarget && (delegatedSelection.choices.length > 0 || delegatedSelection.error)))) {
    if (delegatedSelection.error) return delegatedSelection.error;
    const choices = delegatedSelection.choices;
    if (!choices.length) return `Informe o dia e o turno de *${targetMember.rank} ${targetMember.operational_name}*. Exemplo: *coloque @militar dia 12 à noite* ou *dia 12, 24 horas*.`;
    const result = await assignNaturalChoices(targetMember, choices, { displayPrefix: decoratedRequest.displayPrefix });
    const heading = `*MARCAÇÃO PARA ${targetMember.rank.toUpperCase()} ${targetMember.operational_name.toUpperCase()}*`;
    return result?.type === 'TEXT'
      ? { ...result, text: `${heading}\n\n${result.text}` }
      : `${heading}\n\n${result}`;
  }
  const competencySwitch = normalized.match(/^(?:ESCALA|MES|USAR[-\s]+ESCALA|ATIVAR[-\s]+ESCALA)\s+(.+)$/);
  if (competencySwitch) return activateCompetencyFromGroup(competencySwitch[1], member);
  if (command === 'CONFIRMAR-GERAR-PROXIMO-MES') return generateNextMonthFromGroup();
  if (command === 'GERAR-PROXIMO-MES' || /^(?:GERAR|CRIAR)\s+(?:(?:A|O)\s+)?(?:LISTA|ESCALA)(?:\s+DO)?\s+PROXIMO\s+MES$/.test(normalized)) {
    return nextMonthGenerationWarning();
  }
  if (command === 'STATUS' || /\bMEU STATUS\b/.test(normalized)) return `*${member.rank} ${member.operational_name}*\nSituação: ${operationalLabel[member.operational_status] ?? member.operational_status}\nAutorização: ${authorizationLabel[member.authorization_status] ?? member.authorization_status}`;
  const markingScheduleRequest = parseMarkingScheduleCommand(normalized);
  if (markingScheduleRequest?.action === 'START') {
    if (!groupAdministrator) return 'Somente administradores do grupo podem iniciar ou reiniciar a fila do cronograma.';
    const competency = activeCompetency();
    if (!competency) return 'Não há mês ativo para iniciar o cronograma.';
    const details = parseMarkingScheduleStartDetails(commandBody, competency);
    if (details.error) return details.error;
    if (details.column > 2) {
      const opened = db.prepare(`SELECT 1 FROM service_slots WHERE competency_id=? AND current_capacity>=? LIMIT 1`)
        .get(competency.id, details.column);
      if (!opened) return `A ${details.column}ª coluna ainda não está aberta.`;
    }
    const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
    if (!administrator) return 'Administrador do sistema não encontrado.';
    const { startColumnMarkingRound } = await import('./automation.js');
    const result = await startColumnMarkingRound({
      competencyId: competency.id,
      column: details.column,
      userId: administrator.id,
      reason: `WHATSAPP_SCHEDULE_START_BY_${member.id}`,
      startsAt: details.startsAt.toISOString(),
      deadlineDate: details.date
    });
    if (!result.started) return `Não foi possível iniciar o cronograma: ${result.reason}`;
    return result.scheduled
      ? `*CRONOGRAMA PROGRAMADO*\n${competency.name} — ${details.column}ª coluna.\nInício: ${details.startsAt.format('DD/MM/YYYY [às] HH:mm')}.\n\nA fila vale somente para essa data e coluna. Ao terminar, a marcação ficará livre.`
      : `*CRONOGRAMA INICIADO*\n${competency.name} — ${details.column}ª coluna.\n\nA fila vale somente para essa data e coluna. Ao terminar, a marcação ficará livre.`;
  }
  if (markingScheduleRequest?.action === 'SHOW') {
    return await buildMarkingSchedule() ?? 'Não há cronograma completo cadastrado na Antiguidade.';
  }
  if (command === 'VAGAS' || /\b(?:VER|MOSTRAR|MOSTRA|QUERO VER)\s+(?:AS\s+)?VAGAS\b/.test(normalized)) return vacanciesWithPdf(member);
  if (command === 'MINHAS' || /\bMINHAS\s+(?:MARCACOES|ESCALAS)\b/.test(normalized)) return memberAssignmentsMessage(member);
  if (command === 'HORAS' || /^VER\s+HORAS\b/.test(normalized)) {
    if (!targetMember) return 'Marque o militar na mensagem. Exemplo: */horas @pessoa*.';
    return memberHoursMessage(targetMember);
  }
  if (command === 'ESCALA' || /\b(?:MANDA|MANDAR|ENVIA|ENVIAR)\s+(?:A\s+)?ESCALA\b/.test(normalized)) return schedulePdfMessage();
  if (normalized.includes('PASSO A VEZ') || normalized.includes('PASSAR A VEZ')) return registerPass(member);
  const cancellation = normalized.match(/\bCANCELAR?\s+#?(\d+)\b/);
  if (cancellation) return cancelMemberAssignment(member, cancellation[1]);
  if (command === 'MARCAR') {
    const selection = normalized.slice('MARCAR'.length).trim();
    const parsed = parseSelection(selection);
    if (parsed.error) return parsed.error;
    const choices = parsed.choices;
    if (choices.length) return assignNaturalChoices(member, choices, { displayPrefix: decoratedRequest.displayPrefix });
    const result = assignMemberToSlot(member, selection);
    return result.startsWith('Marcação confirmada') ? resultWithNextTurn(member, result) : result;
  }
  const parsed = parseSelection(normalized);
  if (parsed.error) return parsed.error;
  const choices = parsed.choices;
  if (choices.length) return assignNaturalChoices(member, choices, { displayPrefix: decoratedRequest.displayPrefix });
  if (command === 'CANCELAR') return cancelMemberAssignment(member, argument);
  return explicitSlash ? 'Comando não reconhecido. Envie /menu para ver os comandos disponíveis.' : null;
}

export function activeCompetency() {
  const currentIndex = dayjs().year() * 12 + dayjs().month() + 1;
  const configuredId = Number(readSetting('bot_active_competency_id'));
  let configured = null;
  if (Number.isInteger(configuredId) && configuredId > 0) {
    configured = db.prepare('SELECT * FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(configuredId) ?? null;
    const configuredIndex = configured ? configured.year * 12 + configured.month : 0;
    if (configured && configuredIndex >= currentIndex) return configured;
  }
  const automatic = db.prepare(`SELECT * FROM competencies WHERE generated_at IS NOT NULL
    AND (year * 12 + month)>=? ORDER BY year,month LIMIT 1`).get(currentIndex) ?? null;
  if (automatic) {
    if (automatic.id !== configuredId) writeSetting('bot_active_competency_id', String(automatic.id), null);
    return automatic;
  }
  return configured ?? db.prepare(`SELECT * FROM competencies WHERE generated_at IS NOT NULL ORDER BY year DESC,month DESC LIMIT 1`).get() ?? null;
}

function pendingMarkingRoundStart() {
  const value = readSetting('bot_marking_round_starts_at');
  if (!value) return null;
  const start = dayjs(value);
  return start.isValid() && start.isAfter(dayjs()) ? start : null;
}

function markingRoundWaitingMessage(start = pendingMarkingRoundStart()) {
  return start ? `A fila de marcação começará em *${start.format('DD/MM/YYYY [às] HH:mm')}*.` : null;
}

function currentMarkingTurn() {
  return db.prepare(`SELECT t.id,t.member_id,t.deadline_at,t.created_by,m.rank,m.operational_name,m.seniority_position,m.phone_number,m.whatsapp_jid
    FROM marking_turns t JOIN members m ON m.id=t.member_id
    WHERE t.active=1 ORDER BY t.created_at DESC LIMIT 1`).get() ?? null;
}

async function mentionJidForMember(member) {
  const identity = db.prepare(`SELECT jid FROM member_whatsapp_identities
    WHERE member_id=? AND source IN ('MESSAGE','DISCOVERY','MANUAL')
      AND jid LIKE '%@s.whatsapp.net'
    ORDER BY CASE source WHEN 'MESSAGE' THEN 0 WHEN 'DISCOVERY' THEN 1 ELSE 2 END,id LIMIT 1`).get(member.id);
  if (identity?.jid) return identity.jid;
  try {
    const discovered = await discoverMemberWhatsAppJid(member.id);
    return discovered?.whatsapp_jid ?? null;
  } catch {
    return null;
  }
}

export async function buildMarkingSchedule({ competencyId = null, column = null, started = false, startsAt = null } = {}) {
  const competency = competencyId
    ? db.prepare('SELECT * FROM competencies WHERE id=?').get(competencyId)
    : activeCompetency();
  if (!competency) return null;
  const members = db.prepare(`SELECT m.id,m.rank,m.operational_name,m.seniority_position,m.phone_number,m.whatsapp_jid,d.deadline_at
    FROM members m JOIN marking_deadlines d ON d.member_id=m.id
    WHERE m.seniority_position IS NOT NULL AND m.active=1 AND m.operational_status='ACTIVE'
      AND m.authorization_status='AUTHORIZED' ORDER BY m.seniority_position`).all();
  if (!members.length) return null;
  const activeColumn = Number(column || readSetting('bot_active_marking_column') || 2);
  const sections = [];
  let currentDate = null;
  for (const [index, member] of members.entries()) {
    const deadline = dayjs(member.deadline_at);
    const dateKey = deadline.format('YYYY-MM-DD');
    if (dateKey !== currentDate) {
      currentDate = dateKey;
      sections.push(`*${markingWeekdayNames[deadline.day()]} — ${deadline.format('DD/MM/YYYY')}*${sections.length ? '' : `\n*${activeColumn}ª coluna*`}`);
    }
    const timeLabel = deadline.minute() === 0 ? deadline.format('HH[h]') : deadline.format('HH[h]mm');
    sections.push(`${index + 1}. ${member.rank} ${member.operational_name} — até ${timeLabel}`);
  }
  const monthName = String(competency.name).split(/\s+de\s+/i)[0].toUpperCase();
  const scheduledStart = startsAt && dayjs(startsAt).isAfter(dayjs()) ? dayjs(startsAt) : null;
  const heading = started
    ? scheduledStart
      ? `*ESCALA DE ${monthName}*\n\n*A marcação iniciará em ${scheduledStart.format('DD/MM/YYYY [às] HH:mm')}*`
      : `*ESCALA DE ${monthName}*\n\n*A marcação pode iniciar agora*`
    : `*CRONOGRAMA DA ESCALA DE ${monthName}*`;
  return {
    type: 'TEXT',
    text: `${heading}\n\n${sections.join('\n\n')}${started ? '\n\n*REGRA DA RODADA*\nEsta fila vale somente para a data e coluna informadas. Ao terminar o último militar, a marcação fica livre.' : ''}`,
    mentions: [],
    competency,
    column: activeColumn
  };
}

export async function sendMarkingSchedule(options = {}) {
  if (connection.status !== 'CONNECTED') return { sent: false, reason: 'WhatsApp desconectado.' };
  const schedule = await buildMarkingSchedule(options);
  if (!schedule) return { sent: false, reason: 'Não há cronograma completo cadastrado na Antiguidade.' };
  await sendWhatsAppText(schedule.text, { mentions: schedule.mentions });
  return { sent: true, column: schedule.column, competencyName: schedule.competency.name };
}

async function turnAnnouncement(change, reason) {
  if (!change) return null;
  if (!change.next) {
    if (change.needsSchedule) {
      return { type: 'TEXT', text: `*CRONOGRAMA PENDENTE*\n\nA vez de *${change.previous.rank} ${change.previous.operational_name}* foi encerrada, mas o próximo militar não possui data e horário cadastrados. O escalante deve ajustar a página Antiguidade.`, mentions: [] };
    }
    return { type: 'TEXT', text: '*RODADA DE MARCAÇÃO ENCERRADA*\n\nA fila desta data terminou. A marcação agora está livre para os militares ativos e autorizados. Outra data ou coluna só começará com um novo comando do administrador.', mentions: [] };
  }
  return buildMarkingReminder(change.next);
}

function advanceMarkingTurn(expectedMemberId) {
  const previous = currentMarkingTurn();
  if (!previous || previous.member_id !== expectedMemberId) return null;
  const next = db.prepare(`SELECT m.id,m.rank,m.operational_name,m.seniority_position,m.phone_number,m.whatsapp_jid,d.deadline_at
    FROM members m JOIN marking_deadlines d ON d.member_id=m.id
    WHERE m.seniority_position>? AND m.active=1 AND m.operational_status='ACTIVE'
      AND m.authorization_status='AUTHORIZED'
    ORDER BY m.seniority_position LIMIT 1`).get(previous.seniority_position);
  const nextDeadline = next?.deadline_at ?? null;
  const nextIsSameDay = Boolean(next && nextDeadline
    && dayjs(nextDeadline).format('YYYY-MM-DD') === dayjs(previous.deadline_at).format('YYYY-MM-DD'));
  const stamp = now();
  const changed = db.transaction(() => {
    const closed = db.prepare('UPDATE marking_turns SET active=0,closed_at=? WHERE id=? AND active=1').run(stamp, previous.id);
    if (!closed.changes) return false;
    if (nextIsSameDay) {
      db.prepare('INSERT INTO marking_turns (member_id,deadline_at,active,created_by,created_at) VALUES (?,?,1,?,?)')
        .run(next.id, nextDeadline, previous.created_by, stamp);
    }
    return true;
  })();
  if (!changed) return null;
  return { previous, next: nextIsSameDay ? { ...next, deadline_at: nextDeadline } : null, needsSchedule: Boolean(next && !nextDeadline) };
}

async function resultWithNextTurn(member, text, reason = 'MARKED') {
  const change = advanceMarkingTurn(member.id);
  const announcement = await turnAnnouncement(change, reason);
  if (!announcement) return text;
  writeSetting('automation_last_marking_reminder_at', now(), null);
  return { ...announcement, text: `${text}\n\n${announcement.text}` };
}

function readPendingVacation() {
  try {
    const pending = JSON.parse(readSetting(pendingVacationSettingKey) || 'null');
    return pending && Number.isInteger(Number(pending.memberId)) ? pending : null;
  } catch {
    return null;
  }
}

function clearPendingVacation(userId = null) {
  writeSetting(pendingVacationSettingKey, '', userId);
}

async function confirmPendingVacation(extraAction, requestedBy, groupJid) {
  const pending = readPendingVacation();
  if (!pending) return 'Não há uma confirmação de férias pendente. Envie primeiro *@Escalante férias @Militar*.';
  if (pending.groupJid && groupJid && pending.groupJid !== groupJid) return 'Essa confirmação de férias pertence a outro grupo.';
  if (!pending.expiresAt || !dayjs(pending.expiresAt).isAfter(dayjs())) {
    clearPendingVacation();
    return 'A confirmação de férias expirou. Envie novamente *@Escalante férias @Militar*.';
  }
  const competency = activeCompetency();
  if (!competency || Number(pending.competencyId) !== Number(competency.id)) {
    clearPendingVacation();
    return 'A escala selecionada mudou. Envie novamente *@Escalante férias @Militar*.';
  }
  const targetMember = db.prepare('SELECT * FROM members WHERE id=?').get(Number(pending.memberId));
  if (!targetMember) {
    clearPendingVacation();
    return 'O militar da confirmação pendente não foi encontrado.';
  }
  clearPendingVacation();
  return changeMemberOperationalStatus(targetMember, 'VACATION', requestedBy, extraAction, groupJid);
}

async function changeMemberOperationalStatus(targetMember, status, requestedBy, extraAction = null, groupJid = null) {
  const current = db.prepare('SELECT * FROM members WHERE id=?').get(targetMember.id);
  if (!current) return 'Militar não encontrado no efetivo.';
  const administrator = db.prepare(`SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1`).get();
  if (!administrator) return 'Administrador do sistema não encontrado.';
  const competency = activeCompetency();
  const vacationAssignments = status === 'VACATION' && competency
    ? vacationImpact({ memberId: current.id, competencyId: competency.id })
    : { ordinaryAssignments: 0, extraordinaryAssignments: 0 };
  if (vacationAssignments.extraordinaryAssignments && !extraAction) {
    writeSetting(pendingVacationSettingKey, JSON.stringify({
      memberId: current.id,
      competencyId: competency.id,
      groupJid,
      expiresAt: dayjs().add(30, 'minute').toISOString()
    }), administrator.id);
    return `⚠️ *CONFIRME AS FÉRIAS DE ${current.rank.toUpperCase()} ${current.operational_name.toUpperCase()}*

Na escala selecionada (${competency.name}), esse militar possui ${vacationAssignments.extraordinaryAssignments} serviço(s) extra(s).

Para remover os ordinários e também os extras, responda:
*RETIRAR*

Para remover somente os ordinários e manter os extras, responda:
*MANTER*

Nada foi alterado ainda. A confirmação vale por 30 minutos.`;
  }
  if (status === 'VACATION') clearPendingVacation(administrator.id);
  const active = status === 'INACTIVE' ? 0 : 1;
  const stamp = now();
  const vacationResult = status === 'VACATION' && competency
    ? applyVacationToCompetency({
      memberId: current.id,
      competencyId: competency.id,
      extraAction,
      userId: administrator.id,
      reason: `Férias aplicadas pelo WhatsApp por ${requestedBy.rank} ${requestedBy.operational_name}`
    })
    : null;
  db.transaction(() => {
    db.prepare('UPDATE members SET operational_status=?,active=?,updated_at=? WHERE id=?')
      .run(status, active, stamp, current.id);
    const history = db.prepare(`INSERT INTO member_history
      (member_id,field_name,old_value,new_value,changed_by,reason,changed_at) VALUES (?,?,?,?,?,?,?)`);
    if (current.operational_status !== status) {
      history.run(current.id, 'operational_status', current.operational_status, status, administrator.id,
        `Alterado pelo WhatsApp por ${requestedBy.rank} ${requestedBy.operational_name}`, stamp);
    }
    if (Number(current.active) !== active) {
      history.run(current.id, 'active', String(current.active), String(active), administrator.id,
        `Alterado pelo WhatsApp por ${requestedBy.rank} ${requestedBy.operational_name}`, stamp);
    }
  })();
  audit({
    userId: administrator.id,
    action: 'WHATSAPP_MEMBER_OPERATIONAL_STATUS_CHANGE',
    entityType: 'MEMBER',
    entityId: current.id,
    before: { operationalStatus: current.operational_status, active: current.active },
    after: {
      operationalStatus: status,
      active,
      competencyId: competency?.id ?? null,
      removedOrdinaryAssignments: vacationResult?.ordinaryAssignmentsRemoved ?? 0,
      removedExtraordinaryAssignments: vacationResult?.extraordinaryAssignmentsRemoved ?? 0,
      keptExtraordinaryAssignments: vacationResult?.extraordinaryAssignmentsKept ?? 0
    },
    reason: `Alterado pelo WhatsApp por ${requestedBy.rank} ${requestedBy.operational_name}`
  });
  const reactivationGeneration = status === 'ACTIVE' && current.operational_status !== 'ACTIVE' && competency
    ? regenerateOrdinaryAssignments({
      competencyId: competency.id,
      userId: administrator.id,
      reason: `Escala regerada após retorno de ${current.rank} ${current.operational_name} ao status Ativo pelo WhatsApp`
    })
    : null;
  const vacationSummary = status === 'VACATION'
    ? `\nOrdinários removidos: ${vacationResult?.ordinaryAssignmentsRemoved ?? 0}.`
      + `\nExtras ${extraAction === 'REMOVE' ? 'removidos' : 'mantidos'}: ${vacationAssignments.extraordinaryAssignments}.`
    : '';
  const reactivationSummary = reactivationGeneration
    ? `\nA escala ordinária de ${competency.name} foi regerada. Os extras foram preservados.`
    : '';
  const response = `*SITUAÇÃO ATUALIZADA*\n${current.rank} ${current.operational_name}: ${operationalLabel[status]}.${vacationSummary}${reactivationSummary}`;
  const result = status === 'ACTIVE' ? response : await resultWithNextTurn(current, response, 'STATUS_CHANGED');
  if ((status !== 'VACATION' && !reactivationGeneration) || !competency) return result;
  const pdf = await schedulePdfMessage();
  return typeof result === 'string'
    ? { type: 'TEXT', text: result, mentions: [], pdf: pdf?.type === 'PDF' ? pdf : null }
    : { ...result, pdf: pdf?.type === 'PDF' ? pdf : null };
}

export async function notifyCurrentMarkingTurn() {
  if (pendingMarkingRoundStart()) return false;
  const turn = currentMarkingTurn();
  if (!turn) return false;
  const reminder = await buildMarkingReminder({ ...turn, id: turn.member_id });
  await sendWhatsAppText(reminder.text, { mentions: reminder.mentions });
  if (reminder.pdf) await sendWhatsAppDocument(reminder.pdf);
  writeSetting('automation_last_marking_reminder_at', now(), null);
  return true;
}

export async function advanceExpiredMarkingTurn() {
  if (connection.status !== 'CONNECTED') return false;
  if (pendingMarkingRoundStart()) return false;
  const turn = currentMarkingTurn();
  if (!turn || !dayjs(turn.deadline_at).isBefore(dayjs())) return false;
  const announcement = await turnAnnouncement(advanceMarkingTurn(turn.member_id), 'EXPIRED');
  if (!announcement) return false;
  await sendWhatsAppText(announcement.text, { mentions: announcement.mentions });
  if (announcement.pdf) await sendWhatsAppDocument(announcement.pdf);
  writeSetting('automation_last_marking_reminder_at', now(), null);
  return true;
}

function legacyMarkingTurnMessage() {
  const turn = currentMarkingTurn();
  if (!turn) return '*QUEM ESTÁ NA VEZ*\nNenhuma vez está aberta no momento.';
  return `*QUEM ESTÁ NA VEZ*\n${turn.rank} ${turn.operational_name}`;
}

function markingTurnMessage() {
  const turn = currentMarkingTurn();
  if (!turn) return '*QUEM ESTÁ NA VEZ*\nNenhuma vez está aberta no momento.';
  return `*PRAZO PARA MARCAR*\n${turn.rank} ${turn.operational_name} pode marcar até *${dayjs(turn.deadline_at).format('DD/MM [às] HH:mm')}*.\n\n*AGORA É A VEZ DE*\n${turn.rank} ${turn.operational_name}`;
}

function slotRows(competencyId, { onlyAvailable = false } = {}) {
  return db.prepare(`SELECT s.id,s.service_date,s.period,s.is_majorado,s.current_capacity,s.status,s.homologated_at,s.homologation_deadline,
      COUNT(a.id) AS confirmed_count,
      (SELECT GROUP_CONCAT(name, ' | ') FROM (SELECT m2.rank || ' ' || m2.operational_name || COALESCE(' (' || NULLIF(TRIM(a2.display_prefix),'') || ')', '') AS name FROM assignments a2 JOIN members m2 ON m2.id=a2.member_id WHERE a2.service_slot_id=s.id AND a2.status='CONFIRMED' ORDER BY a2.position_number)) AS members
    FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
    WHERE s.competency_id=? GROUP BY s.id
    ${onlyAvailable ? "HAVING s.status='OPEN' AND s.homologated_at IS NULL AND confirmed_count<s.current_capacity" : ''}
    ORDER BY s.service_date, CASE s.period WHEN 'DIURNO' THEN 0 ELSE 1 END`).all(competencyId).map((row) => ({
      ...row, confirmed_count: Number(row.confirmed_count), available_positions: row.current_capacity - Number(row.confirmed_count),
      members: row.members ? row.members.split(' | ') : []
    }));
}

export function availableSlotsMessage(member = null, { personLabel = null } = {}) {
  const competency = activeCompetency();
  if (!competency) return 'Não há uma competência com horários cadastrados.';
  const rows = slotRows(competency.id);
  if (!rows.length) return 'Não há horários cadastrados nesta competência.';
  const memberId = member?.member_id ?? member?.id;
  const markedSlotIds = memberId ? new Set(db.prepare(`SELECT a.service_slot_id FROM assignments a
    JOIN service_slots s ON s.id=a.service_slot_id
    WHERE a.member_id=? AND a.status='CONFIRMED' AND s.competency_id=?`).all(memberId, competency.id).map((row) => row.service_slot_id)) : new Set();
  const available = (slot) => slot.status === 'OPEN' && !slot.homologated_at && slot.available_positions > 0;
  const joinDays = (days) => {
    const unique = [...new Set(days)].sort((a, b) => Number(a) - Number(b));
    if (!unique.length) return '';
    if (unique.length === 1) return unique[0];
    return `${unique.slice(0, -1).join(', ')} e ${unique.at(-1)}`;
  };
  const vacancyText = (majorado) => {
    const byDate = new Map();
    for (const slot of rows.filter((row) => Boolean(row.is_majorado) === majorado && available(row) && !markedSlotIds.has(row.id))) {
      const periods = byDate.get(slot.service_date) ?? new Set();
      periods.add(slot.period);
      byDate.set(slot.service_date, periods);
    }
    const both = []; const day = []; const night = [];
    for (const [date, periods] of byDate) {
      const label = dayjs(date).format('DD');
      if (periods.has('DIURNO') && periods.has('NOTURNO')) both.push(label);
      else if (periods.has('DIURNO')) day.push(label);
      else if (periods.has('NOTURNO')) night.push(label);
    }
    const lines = [];
    if (both.length) lines.push(`${joinDays(both)} — dia e noite.`);
    if (day.length) lines.push(`${joinDays(day)} — somente dia.`);
    if (night.length) lines.push(`${joinDays(night)} — somente noite.`);
    return lines.join('\n') || 'Nenhuma disponível.';
  };
  const turn = currentMarkingTurn();
  const deadline = turn?.deadline_at
    ? dayjs(turn.deadline_at).format('DD/MM [às] HH:mm')
    : dayjs(`${rows[0].service_date}T07:00:00`).subtract(1, 'day').format('DD/MM [às] HH:mm');
  const person = personLabel ?? (member ? `${member.rank} ${member.operational_name}` : 'Militar');
  return `⏰ *${person}.*

Vagas normais:

${vacancyText(false)}

Vagas majoradas:

${vacancyText(true)}

Prazo: até dia ${deadline}.

O Sr. pode responder assim:

“04; 05 noite”

Informar somente o dia significa *dia e noite (24 horas)*.

Se não desejar marcar agora, responda:

“PASSO A VEZ”.`;
}

export async function buildMarkingReminder(turn) {
  const jid = await mentionJidForMember(turn);
  const personLabel = jid
    ? `@${jidAccount(jid)} — ${turn.rank} ${turn.operational_name}`
    : `${turn.rank} ${turn.operational_name}`;
  const pdf = await schedulePdfMessage();
  return {
    type: 'TEXT',
    text: availableSlotsMessage(turn, { personLabel }),
    mentions: jid ? [jid] : [],
    pdf: pdf?.type === 'PDF' ? pdf : null
  };
}

async function vacanciesWithPdf(member) {
  const pdf = await schedulePdfMessage();
  return {
    type: 'TEXT',
    text: availableSlotsMessage(member),
    mentions: [],
    pdf: pdf?.type === 'PDF' ? pdf : null
  };
}

function justifyOrdinaryAssignments(targetMember, choices, displayPrefix, requestedBy) {
  const competency = activeCompetency();
  if (!competency) return 'Não há competência ativa para registrar a justificativa.';
  const rows = slotRows(competency.id);
  let updated = 0;

  db.transaction(() => {
    for (const choice of choices) {
      const daySlots = rows.filter((row) => Number(dayjs(row.service_date).format('D')) === choice.day);
      for (const period of choice.periods) {
        const slot = daySlots.find((row) => row.period === period);
        if (!slot) continue;
        const assignment = db.prepare(`SELECT * FROM assignments
          WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' AND service_type='ORDINARY'`).get(slot.id, targetMember.id);
        if (!assignment) continue;
        db.prepare('UPDATE assignments SET display_prefix=?,updated_at=? WHERE id=?')
          .run(displayPrefix, now(), assignment.id);
        audit({ action: 'BOT_ORDINARY_JUSTIFICATION', entityType: 'ASSIGNMENT', entityId: assignment.id,
          before: assignment, after: db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment.id),
          reason: `Justificativa registrada por ${requestedBy.rank} ${requestedBy.operational_name}` });
        updated += 1;
      }
    }
  })();

  const requestedDates = [...new Set(choices.map((choice) =>
    `${String(choice.day).padStart(2, '0')}/${String(competency.month).padStart(2, '0')}/${competency.year}`))];
  const summary = `*JUSTIFICATIVA ${updated ? 'REGISTRADA' : 'NÃO REGISTRADA'}*
Data: ${requestedDates.join(', ')}
Militar: ${targetMember.rank} ${targetMember.operational_name}`;
  return updated ? summary : `${summary}
Nenhuma escala ordinária encontrada nessa data e turno.`;
}

function parseSingleChangeChoice(value, { optional = false } = {}) {
  const decorated = extractDisplayPrefix(String(value ?? '').replace(/\b(?:POR|PARA|COM)\s*$/i, ' '));
  if (decorated.error) return { error: decorated.error };
  const parsed = parseActiveMarkingRequest(decorated.text);
  if (parsed.error) return { error: parsed.error };
  if (!parsed.choices.length && optional) return { choice: null };
  if (parsed.choices.length !== 1 || parsed.choices[0].periods.length !== 1) {
    return { error: 'Informe exatamente um dia e um turno em cada lado da troca. Exemplo: dia 17 noite.' };
  }
  return { choice: parsed.choices[0] };
}

function changeSlot(choice) {
  const competency = activeCompetency();
  if (!competency) return null;
  return db.prepare(`SELECT * FROM service_slots
    WHERE competency_id=? AND CAST(strftime('%d',service_date) AS INTEGER)=? AND period=?`).get(
    competency.id, choice.day, choice.periods[0]);
}

function extraAssignment(member, slot) {
  if (!slot) return null;
  return db.prepare(`SELECT * FROM assignments
    WHERE member_id=? AND service_slot_id=? AND status='CONFIRMED' AND service_type='EXTRAORDINARY'`).get(member.id, slot.id);
}

function changeDescription(member, slot) {
  return `${member.rank} ${member.operational_name} — ${dayjs(slot.service_date).format('DD/MM/YYYY')} ${periodLabel(slot.period)}`;
}

function destinationError(member, slot, ignoredAssignmentId = null) {
  if (!slot) return 'O horário de destino não existe no mês ativo.';
  if (!eligible(member)) return `${member.rank} ${member.operational_name} não está ativo e autorizado para marcação.`;
  if (slot.status !== 'OPEN' || slot.homologated_at) return 'O horário de destino está fechado ou homologado.';
  if (slot.service_date < dayjs().format('YYYY-MM-DD')) return 'Não é possível alterar um horário já iniciado.';
  const unavailable = db.prepare(`SELECT 1 FROM unavailabilities
    WHERE member_id=? AND status='ACTIVE' AND starts_at<=? AND ends_at>=? LIMIT 1`).get(member.id, slot.ends_at, slot.starts_at);
  if (unavailable) return `${member.rank} ${member.operational_name} possui indisponibilidade no destino.`;
  const duplicate = db.prepare(`SELECT 1 FROM assignments
    WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' AND id<>?`).get(slot.id, member.id, ignoredAssignmentId ?? -1);
  return duplicate ? `${member.rank} ${member.operational_name} já está marcado no horário de destino.` : null;
}

function ensureExtraSource(member, choice) {
  const slot = changeSlot(choice);
  if (!slot) return { error: 'O horário de origem não existe no mês ativo.' };
  if (slot.service_date < dayjs().format('YYYY-MM-DD')) return { error: 'Não é possível alterar um horário já iniciado.' };
  const assignment = extraAssignment(member, slot);
  if (!assignment) {
    const ordinary = db.prepare(`SELECT 1 FROM assignments
      WHERE member_id=? AND service_slot_id=? AND status='CONFIRMED' AND service_type='ORDINARY'`).get(member.id, slot.id);
    return { error: ordinary
      ? 'Esse serviço é ordinário e não pode ser alterado pelo grupo.'
      : `${member.rank} ${member.operational_name} não possui serviço extra nesse horário.` };
  }
  return { slot, assignment };
}

function replaceExtraMember(requestedBy, sourceMember, targetMember, sourceChoice) {
  if (sourceMember.id === targetMember.id) return 'Informe dois militares diferentes para realizar a troca.';
  const source = ensureExtraSource(sourceMember, sourceChoice);
  if (source.error) return source.error;
  const invalidDestination = destinationError(targetMember, source.slot, source.assignment.id);
  if (invalidDestination) return invalidDestination;
  const before = { ...source.assignment };
  db.prepare('UPDATE assignments SET member_id=?,display_prefix=NULL,updated_at=? WHERE id=?')
    .run(targetMember.id, now(), source.assignment.id);
  audit({ action: 'BOT_EXTRA_REPLACE', entityType: 'ASSIGNMENT', entityId: source.assignment.id,
    before, after: db.prepare('SELECT * FROM assignments WHERE id=?').get(source.assignment.id),
    reason: `Troca solicitada por ${requestedBy.rank} ${requestedBy.operational_name}` });
  return `*TROCA REALIZADA*

Antes: ${changeDescription(sourceMember, source.slot)}
Agora: ${changeDescription(targetMember, source.slot)}

Somente o serviço extra informado foi alterado.`;
}

function moveExtraAssignment(requestedBy, member, sourceChoice, targetChoice) {
  const source = ensureExtraSource(member, sourceChoice);
  if (source.error) return source.error;
  const targetSlot = changeSlot(targetChoice);
  if (!targetSlot) return 'O horário de destino não existe no mês ativo.';
  if (source.slot.id === targetSlot.id) return 'Origem e destino são o mesmo horário. Nenhuma alteração foi feita.';
  const invalidDestination = destinationError(member, targetSlot, source.assignment.id);
  if (invalidDestination) return invalidDestination;
  const occupied = new Set(db.prepare(`SELECT position_number FROM assignments
    WHERE service_slot_id=? AND status='CONFIRMED'`).all(targetSlot.id).map((item) => Number(item.position_number)));
  const targetPosition = source.assignment.position_number <= targetSlot.current_capacity
    && !occupied.has(source.assignment.position_number)
    ? source.assignment.position_number
    : Array.from({ length: Number(targetSlot.current_capacity) }, (_, index) => index + 1)
      .find((position) => !occupied.has(position));
  if (!targetPosition) return 'O horário de destino não possui vaga livre.';
  const before = { ...source.assignment };
  db.prepare('UPDATE assignments SET service_slot_id=?,position_number=?,updated_at=? WHERE id=?')
    .run(targetSlot.id, targetPosition, now(), source.assignment.id);
  audit({ action: 'BOT_EXTRA_MOVE', entityType: 'ASSIGNMENT', entityId: source.assignment.id,
    before, after: db.prepare('SELECT * FROM assignments WHERE id=?').get(source.assignment.id),
    reason: `Remanejamento solicitado por ${requestedBy.rank} ${requestedBy.operational_name}` });
  return `*REMANEJAMENTO REALIZADO*

${member.rank} ${member.operational_name}
Antes: ${dayjs(source.slot.service_date).format('DD/MM/YYYY')} ${periodLabel(source.slot.period)}
Agora: ${dayjs(targetSlot.service_date).format('DD/MM/YYYY')} ${periodLabel(targetSlot.period)}

A posição de destino é ${targetPosition}.`;
}

function swapExtraAssignments(requestedBy, firstMember, firstChoice, secondMember, secondChoice) {
  if (firstMember.id === secondMember.id) return 'Informe dois militares diferentes para realizar a permuta.';
  const first = ensureExtraSource(firstMember, firstChoice);
  if (first.error) return first.error;
  const second = ensureExtraSource(secondMember, secondChoice);
  if (second.error) return second.error;
  if (first.slot.id === second.slot.id) return 'Os dois militares já estão no mesmo horário. Nenhuma permuta foi necessária.';
  const firstDestinationError = destinationError(firstMember, second.slot, first.assignment.id);
  if (firstDestinationError) return firstDestinationError;
  const secondDestinationError = destinationError(secondMember, first.slot, second.assignment.id);
  if (secondDestinationError) return secondDestinationError;

  const stamp = now();
  db.transaction(() => {
    db.prepare('UPDATE assignments SET position_number=?,updated_at=? WHERE id=?')
      .run(-first.assignment.id, stamp, first.assignment.id);
    db.prepare('UPDATE assignments SET service_slot_id=?,position_number=?,updated_at=? WHERE id=?')
      .run(first.slot.id, first.assignment.position_number, stamp, second.assignment.id);
    db.prepare('UPDATE assignments SET service_slot_id=?,position_number=?,updated_at=? WHERE id=?')
      .run(second.slot.id, second.assignment.position_number, stamp, first.assignment.id);
  })();
  audit({ action: 'BOT_EXTRA_SWAP', entityType: 'ASSIGNMENT',
    entityId: `${first.assignment.id},${second.assignment.id}`,
    before: { first: first.assignment, second: second.assignment },
    after: {
      first: db.prepare('SELECT * FROM assignments WHERE id=?').get(first.assignment.id),
      second: db.prepare('SELECT * FROM assignments WHERE id=?').get(second.assignment.id)
    }, reason: `Permuta solicitada por ${requestedBy.rank} ${requestedBy.operational_name}` });
  return `*PERMUTA REALIZADA*

${firstMember.rank} ${firstMember.operational_name}:
${dayjs(first.slot.service_date).format('DD/MM/YYYY')} ${periodLabel(first.slot.period)} → ${dayjs(second.slot.service_date).format('DD/MM/YYYY')} ${periodLabel(second.slot.period)}

${secondMember.rank} ${secondMember.operational_name}:
${dayjs(second.slot.service_date).format('DD/MM/YYYY')} ${periodLabel(second.slot.period)} → ${dayjs(first.slot.service_date).format('DD/MM/YYYY')} ${periodLabel(first.slot.period)}

Somente os dois serviços extras informados foram permutados.`;
}

async function changeExtraAssignment(socket, message, body, directText, targets, requestedBy) {
  if (!activeCompetency()) return 'Não há competência ativa para realizar a alteração.';
  const normalized = normalizeMentionLabel(directText);
  const isRemaneuver = remaneuverPattern.test(normalized);
  if (targets.length === 1) {
    const parts = normalized.split(/\bPARA\b/);
    if (parts.length !== 2) {
      return 'Para remanejar, use: *@Escalante remaneje @militar do dia 17 noite para dia 20 dia*.';
    }
    const source = parseSingleChangeChoice(parts[0]);
    if (source.error) return source.error;
    const destination = parseSingleChangeChoice(parts[1]);
    if (destination.error) return destination.error;
    return moveExtraAssignment(requestedBy, targets[0].member, source.choice, destination.choice);
  }
  if (targets.length !== 2 || targets.some((target) => !target.member || !target.jid)) {
    return isRemaneuver
      ? 'Marque um militar e informe a origem e o destino do remanejamento.'
      : 'Marque os dois militares da troca. Nenhuma alteração foi feita.';
  }
  const segments = multiTargetSegments(socket, message, body, targets);
  if (!segments) return 'Não consegui separar os dois militares e seus horários. Nenhuma alteração foi feita.';
  const first = parseSingleChangeChoice(segments[0].text);
  if (first.error) return first.error;
  const second = parseSingleChangeChoice(segments[1].text, { optional: true });
  if (second.error) return second.error;
  if (!second.choice) {
    if (/\b(?:PERMUTA|PERMUTAR|PERMUTE)\b/.test(normalized)) {
      return 'Na permuta, informe também o dia e o turno do segundo militar.';
    }
    return replaceExtraMember(requestedBy, segments[0].member, segments[1].member, first.choice);
  }
  return swapExtraAssignments(requestedBy, segments[0].member, first.choice, segments[1].member, second.choice);
}

function removeExtraNaturalChoices(targetMember, choices, requestedBy) {
  const competency = activeCompetency();
  if (!competency) return 'Não há uma competência ativa para retirada.';
  const rows = slotRows(competency.id);
  const responses = [];
  const today = dayjs().format('YYYY-MM-DD');

  db.transaction(() => {
    for (const choice of choices) {
      const daySlots = rows.filter((row) => Number(dayjs(row.service_date).format('D')) === choice.day);
      for (const period of choice.periods) {
        const label = `${String(choice.day).padStart(2, '0')} ${period === 'DIURNO' ? 'dia' : 'noite'}`;
        const slot = daySlots.find((row) => row.period === period);
        if (!slot) {
          responses.push(`${label}: horário inexistente nesta competência.`);
          continue;
        }
        if (slot.service_date < today) {
          responses.push(`${label}: não é possível retirar um horário já iniciado.`);
          continue;
        }
        const assignments = db.prepare(`SELECT * FROM assignments
          WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' AND service_type='EXTRAORDINARY'`).all(slot.id, targetMember.id);
        if (!assignments.length) {
          responses.push(`${label}: nenhum serviço extra encontrado.`);
          continue;
        }
        for (const assignment of assignments) {
          db.prepare("DELETE FROM assignments WHERE id=? AND service_type='EXTRAORDINARY'").run(assignment.id);
          audit({
            action: 'BOT_DELEGATED_EXTRA_REMOVAL',
            entityType: 'ASSIGNMENT',
            entityId: assignment.id,
            before: assignment,
            reason: `Retirada pelo WhatsApp solicitada por ${requestedBy.rank} ${requestedBy.operational_name}`
          });
        }
        responses.push(`${label}: serviço extra retirado.`);
      }
    }
  })();

  return `*RETIRADA PARA ${targetMember.rank.toUpperCase()} ${targetMember.operational_name.toUpperCase()}*\n\n${responses.join('\n')}\n\nSomente serviços extras foram retirados. Serviços ordinários foram preservados.`;
}


async function assignNaturalChoices(member, choices, { displayPrefix = null } = {}) {
  const competency = activeCompetency();
  if (!competency) return 'Não há uma competência ativa para marcação.';
  const turn = currentMarkingTurn();
  if (turn && turn.member_id !== member.id) {
    return `Aguarde a sua vez. Agora é a vez de *${turn.rank} ${turn.operational_name}*.`;
  }
  const rows = slotRows(competency.id);
  const responses = [];
  let confirmed = false;
  for (const choice of choices) {
    const isFullDay = choice.periods.includes('DIURNO') && choice.periods.includes('NOTURNO');
    const daySlots = rows.filter((row) => Number(dayjs(row.service_date).format('D')) === choice.day);
    if (isFullDay && member.unit_type === 'CICC') {
      const result = assignFullDayWithBasePreference(member, daySlots, displayPrefix);
      const label = String(choice.day).padStart(2, '0');
      if (result.error) {
        responses.push(`${label}: ${result.error}`);
      } else {
        confirmed = confirmed || result.created > 0;
        responses.push(`${label}: 24 horas confirmado.${result.replaced > 0 ? ' Marcação parcial anterior substituída.' : ''}`);
      }
      continue;
    }
    for (const period of choice.periods) {
      const slot = daySlots.find((row) => row.period === period);
      const label = `${String(choice.day).padStart(2, '0')} ${period === 'DIURNO' ? 'dia' : 'noite'}`;
      if (!slot) { responses.push(`${label}: não existe nesta competência.`); continue; }
      const result = assignMemberToSlot(member, slot.id, displayPrefix);
      if (result.startsWith('Marcação confirmada')) confirmed = true;
      responses.push(result.startsWith('Marcação confirmada') ? `${label}: confirmado.` : `${label}: ${result}`);
    }
  }
  const message = `*RESULTADO DA MARCAÇÃO*\n\n${responses.join('\n')}\n\nResponda *minhas marcações* para conferir ou use /escala para receber o PDF.`;
  return confirmed ? await resultWithNextTurn(member, message) : message;
}

async function registerPass(member) {
  const waitingMessage = markingRoundWaitingMessage();
  if (waitingMessage) return waitingMessage;
  const competency = activeCompetency();
  if (!competency) return 'Não há uma rodada de marcação ativa.';
  const turn = currentMarkingTurn();
  if (turn && dayjs(turn.deadline_at).isBefore(dayjs())) {
    const announcement = await turnAnnouncement(advanceMarkingTurn(turn.member_id), 'EXPIRED');
    return announcement ?? `O prazo da vez de *${turn.rank} ${turn.operational_name}* já encerrou.`;
  }
  if (turn && turn.member_id !== member.id) return `A vez de marcação é de *${turn.rank} ${turn.operational_name}*. Aguarde a sua vez.`;
  db.prepare(`INSERT INTO bot_passes (competency_id,member_id,passed_at) VALUES (?,?,?)
    ON CONFLICT(competency_id,member_id) DO UPDATE SET passed_at=excluded.passed_at`).run(competency.id, member.id, now());
  audit({ memberId: member.id, action: 'BOT_PASS', entityType: 'COMPETENCY', entityId: competency.id, reason: 'Passou a vez pelo WhatsApp' });
  const message = `Passo a vez registrado para *${competency.name}*.`;
  return turn ? await resultWithNextTurn(member, message, 'PASSED') : message;
}

async function schedulePdfMessage() {
  const competency = activeCompetency();
  if (!competency) return 'Não há escala cadastrada para gerar o PDF.';
  const buffer = await buildSchedulePdf({ competency, slots: slotRows(competency.id) });
  return { type: 'PDF', buffer, competencyName: competency.name, fileName: `escala-${competency.year}-${String(competency.month).padStart(2, '0')}.pdf`, caption: `Escala de ${competency.name}.` };
}

function memberAssignmentsMessage(member) {
  const competency = activeCompetency();
  const rows = db.prepare(`SELECT s.id,s.service_date,s.period,a.service_type FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE a.member_id=? AND a.status='CONFIRMED' AND s.service_date>=? ORDER BY s.service_date,s.period LIMIT 20`).all(member.id, dayjs().format('YYYY-MM-DD'));
  const monthHours = competency ? Number(db.prepare(`SELECT COUNT(a.id)*12 AS hours FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE a.member_id=? AND a.status='CONFIRMED' AND a.service_type='EXTRAORDINARY' AND s.competency_id=?`).get(member.id, competency.id).hours || 0) : 0;
  const hourLimit = memberHourLimit(member, competency);
  if (!rows.length) return `Você não possui marcações futuras.\n\n*HORAS EXTRAS NO MÊS:* ${hourSummary(monthHours, hourLimit)}`;
  const firstId = rows[0].id;
  return `*SUAS MARCAÇÕES*\n\n${rows.map((slot) => `ID ${slot.id} — ${dayjs(slot.service_date).format('DD/MM/YYYY')} | ${periodLabel(slot.period)} | 12h | ${slot.service_type === 'ORDINARY' ? 'Ordinário' : 'Extra'}`).join('\n')}\n\n*HORAS EXTRAS NO MÊS:* ${hourSummary(monthHours, hourLimit)}\n\nPara retirar, responda:\n*cancelar ${firstId}*\n\nTambém funciona: /cancelar ${firstId}. Troque ${firstId} pelo ID desejado.`;
}

function memberHoursMessage(member) {
  const competency = activeCompetency();
  if (!competency) return 'Não há mês de escala ativo para consultar as horas.';
  const rows = db.prepare(`SELECT s.service_date,s.period FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
    WHERE a.member_id=? AND a.status='CONFIRMED' AND a.service_type='EXTRAORDINARY'
      AND s.competency_id=? ORDER BY s.service_date,s.period`).all(member.id, competency.id);
  const markedHours = rows.length * 12;
  const hourLimit = memberHourLimit(member, competency);
  const slotsByDate = new Map();
  for (const slot of rows) {
    const periods = slotsByDate.get(slot.service_date) ?? [];
    periods.push(slot.period);
    slotsByDate.set(slot.service_date, periods);
  }
  const slots = rows.length
    ? [...slotsByDate.entries()].map(([date, periods]) => {
      const fullDay = periods.includes('DIURNO') && periods.includes('NOTURNO');
      return `${dayjs(date).format('DD/MM')} — ${fullDay ? '24h' : `${periodLabel(periods[0])} (12h)`}`;
    }).join('\n')
    : 'Nenhum horário confirmado neste mês.';
  return `*HORAS EXTRAS — ${member.rank} ${member.operational_name}*\n\n*Mês:* ${competency.name}\n*Horas extras:* ${hourSummary(markedHours, hourLimit)}\n\n*SERVIÇOS EXTRAS CONFIRMADOS*\n${slots}`;
}

function eligible(member) {
  return member.active === 1 && member.operational_status === 'ACTIVE' && member.authorization_status === 'AUTHORIZED';
}

function memberHourLimit(member, competency) {
  const settings = member.monthly_hour_limit !== undefined && member.hour_limit_exempt !== undefined
    ? member
    : db.prepare('SELECT monthly_hour_limit,hour_limit_exempt FROM members WHERE id=?').get(member.id);
  if (Number(settings?.hour_limit_exempt) === 1) return null;
  const configured = settings?.monthly_hour_limit;
  return Math.min(Math.max(Number(configured ?? competency?.current_hour_limit ?? 192), 12), 192);
}

function hourSummary(markedHours, hourLimit) {
  return hourLimit === null ? 'Não contabilizadas (sem limite)' : `${markedHours}h / ${hourLimit}h`;
}

function assignFullDayWithBasePreference(member, rawSlots, displayPrefix = null) {
  if (!eligible(member)) return { error: 'Sua situação atual não permite marcação.' };
  const waitingMessage = markingRoundWaitingMessage();
  if (waitingMessage) return { error: waitingMessage };
  const slots = ['DIURNO', 'NOTURNO'].map((period) => rawSlots.find((slot) => slot.period === period));
  if (slots.some((slot) => !slot)) return { error: 'não existem os dois turnos nesta competência.' };
  const turn = currentMarkingTurn();
  if (turn && dayjs(turn.deadline_at).isBefore(dayjs())) return { error: 'seu prazo de marcação encerrou.' };
  if (turn && turn.member_id !== member.id) return { error: 'aguarde a sua vez.' };

  return db.transaction(() => {
    const detailedSlots = slots.map((slot) => db.prepare(`SELECT * FROM service_slots WHERE id=?`).get(slot.id));
    if (detailedSlots.some((slot) => slot.status !== 'OPEN' || slot.homologated_at)) return { error: 'o dia completo não está disponível.' };
    if (detailedSlots.some((slot) => slot.service_date < dayjs().format('YYYY-MM-DD'))) return { error: 'não é possível marcar um horário já iniciado.' };

    const ownAssignments = detailedSlots.map((slot) => db.prepare(`SELECT * FROM assignments
      WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED'`).get(slot.id, member.id));

    for (const slot of detailedSlots) {
      const unavailable = db.prepare(`SELECT 1 FROM unavailabilities
        WHERE member_id=? AND status='ACTIVE' AND starts_at<=? AND ends_at>=? LIMIT 1`)
        .get(member.id, slot.ends_at, slot.starts_at);
      if (unavailable) return { error: 'você possui indisponibilidade para esta data.' };
    }

    const forcedPosition = ownAssignments.find(Boolean)?.position_number ?? null;
    if (ownAssignments.filter(Boolean).some((assignment) => assignment.position_number !== forcedPosition)) {
      return { error: 'suas marcações deste dia estão em posições diferentes; procure o escalante.' };
    }
    const maxPosition = Math.min(...detailedSlots.map((slot) => Number(slot.current_capacity)));
    const candidatePositions = forcedPosition
      ? (forcedPosition <= maxPosition ? [forcedPosition] : [])
      : Array.from({ length: maxPosition }, (_, index) => index + 1);
    const assignmentsBySlot = new Map(detailedSlots.map((slot) => [
      slot.id,
      db.prepare(`SELECT a.*,m.rank,m.operational_name,m.unit_type
        FROM assignments a JOIN members m ON m.id=a.member_id
        WHERE a.service_slot_id=? AND a.status='CONFIRMED'`).all(slot.id)
    ]));
    let selected = null;

    for (const position of candidatePositions) {
      const occupants = detailedSlots.map((slot) => assignmentsBySlot.get(slot.id).find((assignment) => assignment.position_number === position) ?? null);
      const replaceable = occupants.every((occupant, slotIndex) => {
        if (!occupant || occupant.member_id === member.id) return true;
        if (occupant.unit_type !== 'CICC') return false;
        const oppositeSlot = detailedSlots[slotIndex === 0 ? 1 : 0];
        const hasOtherHalf = db.prepare(`SELECT 1 FROM assignments
          WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED' LIMIT 1`).get(oppositeSlot.id, occupant.member_id);
        return !hasOtherHalf;
      });
      if (!replaceable) continue;
      const replacements = occupants.filter((occupant) => occupant && occupant.member_id !== member.id);
      const requesterAlreadyOccupiesPosition = occupants.some((occupant) => occupant?.member_id === member.id);
      const emptyPositions = occupants.filter((occupant) => !occupant).length;
      // A preferência de 24h só pode trocar uma única marcação parcial quando
      // o outro turno da mesma coluna está vazio. Nunca remove duas pessoas
      // que já estejam preenchendo Dia e Noite.
      if (replacements.length > 1) continue;
      if (replacements.length === 1 && (requesterAlreadyOccupiesPosition || emptyPositions !== 1)) continue;
      if (!selected || replacements.length < selected.replacements.length) selected = { position, occupants, replacements };
    }
    if (!selected) {
      return { error: 'não há uma coluna completa livre. Uma marcação de 12h só pode ser substituída quando o outro turno da mesma coluna estiver vazio.' };
    }

    for (const replaced of selected.replacements) {
      db.prepare('DELETE FROM assignments WHERE id=?').run(replaced.id);
      audit({
        action: 'BOT_FULL_DAY_PREFERENCE',
        entityType: 'ASSIGNMENT',
        entityId: replaced.id,
        before: replaced,
        after: { replacedByMemberId: member.id },
        reason: 'Marcação de 24h da Base CICC substituiu marcação parcial de 12h'
      });
    }

    const stamp = now();
    let inserted = 0;
    for (const slot of detailedSlots) {
      if (ownAssignments.find((assignment) => assignment?.service_slot_id === slot.id)) continue;
      const protocol = `BOT-24H-${Date.now()}-${member.id}-${slot.id}`;
      db.prepare(`INSERT INTO assignments
        (service_slot_id,position_number,member_id,service_type,status,display_prefix,protocol,confirmed_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(slot.id, selected.position, member.id, 'EXTRAORDINARY', 'CONFIRMED', displayPrefix, protocol, stamp, stamp, stamp);
      inserted += 1;
    }
    audit({
      action: 'BOT_FULL_DAY_ASSIGNMENT',
      entityType: 'MEMBER',
      entityId: member.id,
      after: { serviceDate: detailedSlots[0].service_date, position: selected.position, inserted, replaced: selected.replacements.map((item) => item.id) },
      reason: 'Marcação de 24h pela Base CICC'
    });
    return { created: inserted, replaced: selected.replacements.length };
  })();
}

function assignMemberToSlot(member, rawSlotId, displayPrefix = null) {
  const slotId = Number(rawSlotId);
  if (!Number.isInteger(slotId) || slotId < 1) return 'Informe os dias desejados. Exemplo: /marcar 04; 05 noite';
  if (!eligible(member)) return 'Sua situação atual não permite marcação. Consulte STATUS ou fale com o escalante.';
  const waitingMessage = markingRoundWaitingMessage();
  if (waitingMessage) return waitingMessage;
  const turn = currentMarkingTurn();
  if (turn && dayjs(turn.deadline_at).isBefore(dayjs())) return `O prazo da vez de *${turn.rank} ${turn.operational_name}* encerrou em ${dayjs(turn.deadline_at).format('DD/MM [às] HH:mm')}. Aguarde o escalante abrir a próxima vez.`;
  if (turn && turn.member_id !== member.id) return `A vez de marcação é de *${turn.rank} ${turn.operational_name}* até ${dayjs(turn.deadline_at).format('DD/MM [às] HH:mm')}. Aguarde a sua vez.`;
  const result = db.transaction(() => {
    const slot = db.prepare(`SELECT s.*,COUNT(a.id) AS confirmed_count FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED' WHERE s.id=? GROUP BY s.id`).get(slotId);
    if (!slot || slot.status !== 'OPEN' || slot.homologated_at || slot.confirmed_count >= slot.current_capacity) return { error: 'Esta vaga não está mais disponível.' };
    if (slot.service_date < dayjs().format('YYYY-MM-DD')) return { error: 'Não é possível marcar um horário já iniciado.' };
    const competency = db.prepare('SELECT current_hour_limit FROM competencies WHERE id=?').get(slot.competency_id);
    const markedHours = Number(db.prepare(`SELECT COUNT(a.id)*12 AS hours FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
      WHERE a.member_id=? AND a.status='CONFIRMED' AND a.service_type='EXTRAORDINARY'
        AND s.competency_id=?`).get(member.id, slot.competency_id).hours || 0);
    const hourLimit = memberHourLimit(member, competency);
    // O limite é somente um alerta administrativo neste momento: nunca bloqueia a marcação pelo WhatsApp.
    const unavailable = db.prepare(`SELECT 1 FROM unavailabilities WHERE member_id=? AND status='ACTIVE' AND starts_at<=? AND ends_at>=? LIMIT 1`).get(member.id, slot.ends_at, slot.starts_at);
    if (unavailable) return { error: 'Você possui uma indisponibilidade para esta data.' };
    const existing = db.prepare(`SELECT 1 FROM assignments WHERE service_slot_id=? AND member_id=? AND status='CONFIRMED'`).get(slot.id, member.id);
    if (existing) return { error: 'Você já está marcado neste horário.' };
    const occupiedPositions = new Set(db.prepare(`SELECT position_number FROM assignments
      WHERE service_slot_id=? AND status='CONFIRMED'`).all(slot.id).map((item) => Number(item.position_number)));
    const position = Array.from({ length: Number(slot.current_capacity) }, (_, index) => index + 1)
      .find((candidate) => !occupiedPositions.has(candidate));
    if (!position) return { error: 'Esta vaga não possui mais uma posição livre.' };
    const protocol = `BOT-${Date.now()}-${member.id}-${slot.id}`;
    db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,display_prefix,protocol,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(slot.id, position, member.id, 'EXTRAORDINARY', 'CONFIRMED', displayPrefix, protocol, now(), now(), now());
    audit({ memberId: member.id, action: 'BOT_ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: protocol, after: { slotId: slot.id, position }, reason: 'Marcação por WhatsApp' });
    return { slot, protocol, markedHours: markedHours + 12, hourLimit };
  })();
  if (result.error) return result.error;
  return `Marcação confirmada.\n${dayjs(result.slot.service_date).format('DD/MM/YYYY')} — ${periodLabel(result.slot.period)} — 12h\nHoras no mês: ${hourSummary(result.markedHours, result.hourLimit)}\nProtocolo: ${result.protocol}`;
}

function cancelMemberAssignment(member, rawSlotId) {
  const slotId = Number(rawSlotId);
  if (!Number.isInteger(slotId) || slotId < 1) return 'Informe o código do horário. Exemplo: /cancelar 125';
  const assignment = db.prepare(`SELECT a.id,a.service_type,s.service_date,s.period FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id WHERE a.service_slot_id=? AND a.member_id=? AND a.status='CONFIRMED'`).get(slotId, member.id);
  if (!assignment) return 'Não encontrei uma marcação sua com este código.';
  if (assignment.service_type === 'ORDINARY') return 'O serviço ordinário não pode ser retirado pelo grupo. Procure o escalante para ajustar sua situação.';
  if (assignment.service_date < dayjs().format('YYYY-MM-DD')) return 'Não é possível cancelar um horário já iniciado.';
  db.prepare('DELETE FROM assignments WHERE id=?').run(assignment.id);
  audit({ memberId: member.id, action: 'BOT_CANCELLATION', entityType: 'ASSIGNMENT', entityId: assignment.id, reason: 'Cancelamento por WhatsApp' });
  return `Marcação cancelada: ${dayjs(assignment.service_date).format('DD/MM/YYYY')} — ${periodLabel(assignment.period)}.`;
}

export async function disconnectWhatsApp() {
  clearReconnectTimer();
  connection.manualDisconnect = true;
  writeSetting('whatsapp_auto_connect', '0', null);
  writeSetting('whatsapp_manual_stop', '1', null);
  const socket = connection.socket;
  connection.socket = null;
  connection.saveCreds = null;
  if (socket) await socket.end(undefined).catch(() => {});
  connection.status = 'DISCONNECTED'; connection.qrDataUrl = null; connection.qrIssued = false; connection.phoneNumber = null; connection.error = null;
  return publicStatus();
}

// Fecha o socket para reinício do processo sem apagar o vínculo nem desligar
// a reconexão automática. O QR Code só volta a ser necessário após Resetar sessão.
export async function closeWhatsAppForRestart() {
  clearReconnectTimer();
  connection.manualDisconnect = true;
  const socket = connection.socket;
  const saveCreds = connection.saveCreds;
  connection.socket = null;
  connection.saveCreds = null;
  await saveCreds?.().catch(() => {});
  await socket?.end(undefined).catch(() => {});
  connection.status = 'DISCONNECTED';
}

export async function resetWhatsAppSession() {
  clearReconnectTimer();
  connection.manualDisconnect = true;
  writeSetting('whatsapp_auto_connect', '0', null);
  writeSetting('whatsapp_manual_stop', '0', null);
  const socket = connection.socket;
  connection.socket = null;
  connection.saveCreds = null;
  if (socket) await socket.logout().catch(() => {});
  if (fs.existsSync(authDirectory)) fs.rmSync(authDirectory, { recursive: true, force: true });
  connection.status = 'DISCONNECTED';
  connection.qrDataUrl = null;
  connection.qrIssued = false;
  connection.phoneNumber = null;
  connection.error = null;
  return connectWhatsApp();
}

export async function restoreWhatsAppSession() {
  const hasSession = hasStoredWhatsAppSession();
  if (!hasSession || isManualConnectionStop()) return publicStatus();
  connection.manualDisconnect = false;
  writeSetting('whatsapp_auto_connect', '1', null);
  return connectWhatsApp({ automatic: true });
}

export async function getWhatsAppGroups() {
  if (!connection.socket || connection.status !== 'CONNECTED') throw new Error('Conecte o WhatsApp antes de carregar os grupos.');
  const groups = await connection.socket.groupFetchAllParticipating();
  return Object.values(groups).map((group) => ({ jid: group.id, name: group.subject })).sort((a, b) => a.name.localeCompare(b.name));
}

function configuredDestinations() {
  const groupJids = configuredGroupJids();
  if (!groupJids.length) throw new Error('Configure pelo menos um grupo de destino no painel.');
  if (!connection.socket || connection.status !== 'CONNECTED') throw new Error('O WhatsApp não está conectado.');
  return groupJids;
}

export async function sendWhatsAppText(text, { mentions = [] } = {}) {
  const results = [];
  for (const destination of configuredDestinations()) {
    const result = await connection.socket.sendMessage(destination, { text, mentions });
    logOutboundMessage(connection.socket, result, destination, text);
    results.push(result);
  }
  return results;
}

export async function sendWhatsAppDocument({ buffer, fileName, caption }) {
  const safeCaption = caption || 'Escala em PDF.';
  const results = [];
  for (const destination of configuredDestinations()) {
    const result = await connection.socket.sendMessage(destination, { document: buffer, mimetype: 'application/pdf', fileName, caption: safeCaption });
    logOutboundMessage(connection.socket, result, destination, safeCaption);
    results.push(result);
  }
  return results;
}
