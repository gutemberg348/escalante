import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { audit, db, now } from '../database/index.js';
import { buildSchedulePdf } from './schedule-pdf.js';

const authDirectory = path.resolve(path.dirname(env.DATABASE_PATH), 'whatsapp-auth');
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
  if (!mentionsBot(socket, message)) return null;
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

function hasNonBotMention(socket, message) {
  const botIds = botAccounts(socket);
  return Boolean(messageContextInfo(message)?.mentionedJid?.some((jid) => !botIds.has(jidAccount(jid))));
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

function membersMentionedByTextAccount(socket, body, excludedMemberId = null) {
  const botIds = botAccounts(socket);
  const accounts = [...new Set([...String(body ?? '').matchAll(/@(\d{10,20})/g)].map((match) => match[1]))]
    .filter((account) => !botIds.has(account));
  const matches = new Map();
  for (const account of accounts) {
    for (const suffix of ['@s.whatsapp.net', '@lid']) {
      const member = resolveMemberIdentity({ participant: `${account}${suffix}` }).member;
      if (member && member.id !== excludedMemberId) matches.set(member.id, member);
    }
  }
  return [...matches.values()];
}

async function mentionedMember(socket, message, excludedMemberId = null) {
  const mentioned = messageContextInfo(message)?.mentionedJid ?? [];
  const botIds = botAccounts(socket);
  const findByJid = db.prepare('SELECT * FROM members WHERE whatsapp_jid=?');
  const findByIdentity = db.prepare(`SELECT m.* FROM member_whatsapp_identities i JOIN members m ON m.id=i.member_id WHERE i.jid=?`);
  for (const jid of mentioned) {
    if (botIds.has(jidAccount(jid))) continue;
    const member = findByJid.get(jid) ?? findByIdentity.get(jid);
    if (member && member.id !== excludedMemberId) return member;
    const resolved = await resolveMemberIdentityWithMapping(socket, {
      participant: jid,
      remoteJid: message.key.remoteJid
    });
    if (resolved.member && resolved.member.id !== excludedMemberId) return resolved.member;
  }
  const textMatches = membersMentionedByTextAccount(socket, textFromMessage(message), excludedMemberId);
  if (textMatches.length === 1) return textMatches[0];
  return memberMentionedByName(textFromMessage(message), excludedMemberId);
}

const delegatedMarkingPattern = /\b(?:COLOCA|COLOCAR|COLOQUE|POE|POR|PONHA|BOTA|BOTAR|BOTE|MARCA|MARCAR|MARQUE|ESCALA|ESCALAR|INCLUA|ADICIONA|ADICIONAR)\b/;
const isDelegatedMarkingText = (body) => delegatedMarkingPattern.test(normalizeMentionLabel(body));

function logOutboundMessage(socket, result, remoteJid, body) {
  db.prepare(`INSERT OR IGNORE INTO whatsapp_messages
    (message_id,remote_jid,sender_jid,direction,body,created_at) VALUES (?,?,?,?,?,?)`)
    .run(result?.key?.id ?? `OUT-${Date.now()}`, remoteJid, socket.user?.id ?? null, 'OUTBOUND', String(body ?? '').slice(0, 2000), now());
}

async function handleIncomingMessages(socket, { messages }) {
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
    const quotedRequest = quotedMemberRequest(socket, message);
    const effectiveBody = quotedRequest?.body ?? body;
    const explicitSlash = effectiveBody.startsWith('/');
    const commandText = withoutBotMention(effectiveBody);
    const identity = quotedRequest
      ? await resolveMemberIdentityWithMapping(socket, quotedRequest.key)
      : (originalIdentity.member ? originalIdentity : await resolveMemberIdentityWithMapping(socket, message.key));
    const targetMember = quotedRequest ? identity.member : await mentionedMember(socket, message, identity.member?.id ?? null);
    const mentionTokens = effectiveBody.match(/@\S+/g) ?? [];
    const delegatedMention = !quotedRequest && isDelegatedMarkingText(commandText)
      && (hasNonBotMention(socket, message) || mentionTokens.length >= 2);
    const unresolvedTargetMention = delegatedMention && !targetMember;
    if (delegatedMention) {
      console.info('Resolução de marcação por menção', {
        messageId,
        senderMemberId: identity.member?.id ?? null,
        targetMemberId: targetMember?.id ?? null,
        structuredMentions: messageContextInfo(message)?.mentionedJid?.length ?? 0,
        textMentions: mentionTokens.length
      });
    }
    const senderJid = identity.senderJid;
    if (!senderJid) continue;
    const processedMessageId = messageId;
    const processed = db.prepare('INSERT OR IGNORE INTO processed_messages (message_id,sender_jid,received_at,processed_at) VALUES (?,?,?,?)').run(processedMessageId, senderJid, now(), now());
    if (!processed.changes) continue;
    db.prepare('INSERT OR IGNORE INTO whatsapp_messages (message_id,remote_jid,sender_jid,direction,body,created_at) VALUES (?,?,?,?,?,?)')
      .run(processedMessageId, remoteJid, senderJid, 'INBOUND', effectiveBody.slice(0, 2000), now());
    const reply = identity.member
      ? unresolvedTargetMention
        ? 'O militar marcado não está vinculado a um cadastro do efetivo.'
        : await executeCommand(identity.member, commandText, { explicitSlash, targetMember })
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

Quando informar somente o dia, o sistema marca dia e noite (24 horas).

Outros atalhos:
*/status* - consulta seu cadastro
*/minhas* - suas marcações
*/horas @pessoa* - horas e horários confirmados de um militar
*/cronograma* - ordem completa da antiguidade e o horário limite de cada militar
*/escala* - recebe a escala em PDF
*/meses* - mostra os meses gerados e qual está ativo
*/escala 10/2026* - troca o mês ativo e envia o novo PDF
*/gerar-proximo-mes* - mostra o aviso antes de gerar
*/confirmar-gerar-proximo-mes* - confirma a geração e publica o PDF
*/cancelar 125* - cancela uma marcação
*/passo a vez* - não marca nesta rodada

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

async function executeCommand(member, rawBody, { explicitSlash = false, targetMember = null } = {}) {
  const commandBody = rawBody.trim().replace(/^\/+/, '').trim();
  const normalized = commandBody.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const [command, argument] = normalized.split(/\s+/, 2);
  if (['MENU', 'AJUDA', 'COMANDOS'].includes(command)) return commandMenu();
  if (command === 'MESES') return generatedCompetenciesMessage();
  const delegatedAction = isDelegatedMarkingText(normalized);
  if (targetMember && targetMember.id !== member.id && delegatedAction) {
    const choices = parseNaturalChoices(normalized);
    if (!choices.length) return `Informe o dia e o turno de *${targetMember.rank} ${targetMember.operational_name}*. Exemplo: *coloque @militar dia 12 à noite* ou *dia 12, 24 horas*.`;
    const result = await assignNaturalChoices(targetMember, choices);
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
  if (command === 'CRONOGRAMA' || /\b(?:VER|MOSTRAR|MOSTRA|QUERO VER)\s+(?:O\s+)?CRONOGRAMA\b/.test(normalized)) {
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
    const choices = parseNaturalChoices(selection);
    if (choices.length) return assignNaturalChoices(member, choices);
    const result = assignMemberToSlot(member, selection);
    return result.startsWith('Marcação confirmada') ? resultWithNextTurn(member, result) : result;
  }
  const choices = parseNaturalChoices(normalized);
  if (choices.length) return assignNaturalChoices(member, choices);
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

export async function buildMarkingSchedule({ competencyId = null, column = null } = {}) {
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
  const firstJid = await mentionJidForMember(members[0]);
  const firstMention = firstJid ? `@${jidAccount(firstJid)}` : `*${members[0].rank} ${members[0].operational_name}*`;
  const rows = members.map((member, index) =>
    `${index + 1}. ${member.rank} ${member.operational_name} — até ${dayjs(member.deadline_at).format('HH:mm')}`
  );
  return {
    type: 'TEXT',
    text: `*CRONOGRAMA DE MARCAÇÃO — ESCALA DE ${competency.name.toUpperCase()} (${activeColumn}ª COLUNA)*

Marcação em sequência.

Assim que ${firstMention} marcar, o próximo da lista já pode fazer o mesmo, sem precisar aguardar o horário limite.

*HORÁRIOS DE MARCAÇÃO*

${rows.join('\n\n')}`,
    mentions: firstJid ? [firstJid] : [],
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
    return { type: 'TEXT', text: '*RODADA DE MARCAÇÃO ENCERRADA*\n\nTodos os militares da lista tiveram a sua vez.', mentions: [] };
  }
  return buildMarkingReminder(change.next);
}

function advanceMarkingTurn(expectedMemberId) {
  const previous = currentMarkingTurn();
  if (!previous || previous.member_id !== expectedMemberId) return null;
  const next = db.prepare(`SELECT id,rank,operational_name,seniority_position,phone_number,whatsapp_jid
    FROM members WHERE seniority_position>? AND active=1 AND operational_status='ACTIVE'
      AND authorization_status='AUTHORIZED'
    ORDER BY seniority_position LIMIT 1`).get(previous.seniority_position);
  const nextDeadline = next ? db.prepare('SELECT deadline_at FROM marking_deadlines WHERE member_id=?').get(next.id)?.deadline_at : null;
  const stamp = now();
  const changed = db.transaction(() => {
    const closed = db.prepare('UPDATE marking_turns SET active=0,closed_at=? WHERE id=? AND active=1').run(stamp, previous.id);
    if (!closed.changes) return false;
    if (next && nextDeadline) {
      db.prepare('INSERT INTO marking_turns (member_id,deadline_at,active,created_by,created_at) VALUES (?,?,1,?,?)')
        .run(next.id, nextDeadline, previous.created_by, stamp);
    }
    return true;
  })();
  if (!changed) return null;
  return { previous, next: next && nextDeadline ? { ...next, deadline_at: nextDeadline } : null, needsSchedule: Boolean(next && !nextDeadline) };
}

async function resultWithNextTurn(member, text, reason = 'MARKED') {
  const change = advanceMarkingTurn(member.id);
  const announcement = await turnAnnouncement(change, reason);
  if (!announcement) return text;
  writeSetting('automation_last_marking_reminder_at', now(), null);
  return { ...announcement, text: `${text}\n\n${announcement.text}` };
}

export async function notifyCurrentMarkingTurn() {
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
      (SELECT GROUP_CONCAT(name, ' | ') FROM (SELECT m2.rank || ' ' || m2.operational_name AS name FROM assignments a2 JOIN members m2 ON m2.id=a2.member_id WHERE a2.service_slot_id=s.id AND a2.status='CONFIRMED' ORDER BY a2.position_number)) AS members
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

export function parseNaturalChoices(body) {
  const choicesByDay = new Map();
  const normalized = body.toUpperCase().replace(/\s+/g, ' ');
  const fullDayPattern = '24\\s*(?:H|HRS?|HORAS?|HRAS?)';
  const periodPattern = `DIA(?:\\s+E)?\\s+NOITE|DIURNO(?:\\s+E)?\\s+NOTURNO|${fullDayPattern}|DIA|DIURNO|NOITE|NOTURNO`;
  const addChoice = (rawDay, periodText) => {
    const day = Number(rawDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) return;
    const periods = choicesByDay.get(day) ?? new Set();
    if (/DIA|DIURNO/.test(periodText)) periods.add('DIURNO');
    if (/NOITE|NOTURNO/.test(periodText)) periods.add('NOTURNO');
    if (/24\s*(?:H|HRS?|HORAS?|HRAS?)/.test(periodText)) { periods.add('DIURNO'); periods.add('NOTURNO'); }
    choicesByDay.set(day, periods);
  };
  const groupedDays = new RegExp(`\\b((?:0?\\d{1,2}\\s*(?:,|E)\\s*)+0?\\d{1,2})\\s*,?\\s*(${periodPattern})\\b`, 'g');
  for (const match of normalized.matchAll(groupedDays)) for (const day of match[1].match(/\d{1,2}/g) || []) addChoice(day, match[2]);
  const daysBeforeComma = new RegExp(`\\b((?:0?\\d{1,2}\\s+)+0?\\d{1,2})\\s*,\\s*(${periodPattern})\\b`, 'g');
  for (const match of normalized.matchAll(daysBeforeComma)) for (const day of match[1].match(/\d{1,2}/g) || []) addChoice(day, match[2]);
  for (const match of normalized.matchAll(/\b0?(\d{1,2})\s+24\s*(?:H|HRS?|HORAS?|HRAS?)\b/g)) addChoice(match[1], '24 HORAS');
  const onlyHours = normalized.match(/^\s*0?(\d{1,2})\s+HORAS?\s*$/);
  if (onlyHours) addChoice(onlyHours[1], '24 HORAS');
  const sharedPeriod = new RegExp(`\\b0?(\\d{1,2})\\s+E\\s+0?(\\d{1,2})\\s+(${periodPattern})\\b`, 'g');
  for (const match of normalized.matchAll(sharedPeriod)) {
    addChoice(match[1], match[3]);
    addChoice(match[2], match[3]);
  }
  // Aceita também a forma natural: "dia 14 a noite" / "14 à noite".
  const expression = new RegExp(`\\b(?:DIA\\s+)?0?(\\d{1,2})\\s+(?:A\\s+)?(${periodPattern})\\b`, 'g');
  for (const match of normalized.matchAll(expression)) {
    const prefix = normalized.slice(0, match.index);
    if (match[1] === '24' && /\d{1,2}[,\s]+$/.test(prefix)) continue;
    addChoice(match[1], match[2]);
  }
  for (const match of normalized.matchAll(/\b0?(\d{1,2})(?=\s*(?:;|,|\bE\b))/g)) {
    const afterDay = normalized.slice((match.index ?? 0) + match[0].length).trimStart();
    if (!/^(?:DIA|DIURNO|NOITE|NOTURNO|24\s*(?:H|HRS?|HORAS?|HRAS?))/.test(afterDay)) addChoice(match[1], '24 HORAS');
  }
  const finalBareDay = normalized.match(/(?:^|\s)(?:DIA\s+)?0?(\d{1,2})\s*[.!]?\s*$/);
  if (finalBareDay) addChoice(finalBareDay[1], '24 HORAS');
  const lastChoice = [...choicesByDay.entries()].at(-1);
  if (lastChoice) {
    const trailingDay = /\bE\s+0?(\d{1,2})(?!\s+(?:DIA|DIURNO|NOITE|NOTURNO))\b/g;
    for (const match of normalized.matchAll(trailingDay)) {
      for (const period of lastChoice[1]) addChoice(match[1], period);
    }
  }
  return [...choicesByDay]
    .sort(([firstDay], [secondDay]) => firstDay - secondDay)
    .map(([day, periods]) => ({ day, periods: [...periods].sort((first, second) => first === second ? 0 : first === 'DIURNO' ? -1 : 1) }));
}

async function assignNaturalChoices(member, choices) {
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
      const result = assignFullDayWithBasePreference(member, daySlots);
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
      const result = assignMemberToSlot(member, slot.id);
      if (result.startsWith('Marcação confirmada')) confirmed = true;
      responses.push(result.startsWith('Marcação confirmada') ? `${label}: confirmado.` : `${label}: ${result}`);
    }
  }
  const message = `*RESULTADO DA MARCAÇÃO*\n\n${responses.join('\n')}\n\nResponda *minhas marcações* para conferir ou use /escala para receber o PDF.`;
  return confirmed ? await resultWithNextTurn(member, message) : message;
}

async function registerPass(member) {
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

function assignFullDayWithBasePreference(member, rawSlots) {
  if (!eligible(member)) return { error: 'Sua situação atual não permite marcação.' };
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
        (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(slot.id, selected.position, member.id, 'EXTRAORDINARY', 'CONFIRMED', protocol, stamp, stamp, stamp);
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

function assignMemberToSlot(member, rawSlotId) {
  const slotId = Number(rawSlotId);
  if (!Number.isInteger(slotId) || slotId < 1) return 'Informe os dias desejados. Exemplo: /marcar 04; 05 noite';
  if (!eligible(member)) return 'Sua situação atual não permite marcação. Consulte STATUS ou fale com o escalante.';
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
    db.prepare(`INSERT INTO assignments (service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(slot.id, position, member.id, 'EXTRAORDINARY', 'CONFIRMED', protocol, now(), now(), now());
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
