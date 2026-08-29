import { Router } from 'express';
import { z } from 'zod';
import { db, audit, now } from '../../database/index.js';
import { allow } from '../../middlewares/auth.js';
import { notifyCurrentMarkingTurn } from '../../messaging/whatsapp.js';

const router = Router();
const membersQuery = `SELECT m.id,m.rank,m.operational_name,m.seniority_position,m.unit_type,m.active,m.operational_status,m.authorization_status,d.deadline_at AS marking_deadline
  FROM members m LEFT JOIN marking_deadlines d ON d.member_id=m.id
  WHERE m.seniority_position IS NOT NULL ORDER BY m.seniority_position`;
const activeTurn = () => db.prepare(`SELECT t.id,t.member_id,t.deadline_at,t.created_at,m.rank,m.operational_name,m.seniority_position
  FROM marking_turns t JOIN members m ON m.id=t.member_id WHERE t.active=1 ORDER BY t.created_at DESC LIMIT 1`).get() ?? null;
const eligibleMembers = () => db.prepare(`SELECT id,rank,operational_name,seniority_position,active,operational_status,authorization_status FROM members
  WHERE seniority_position IS NOT NULL AND active=1 AND operational_status='ACTIVE' AND authorization_status='AUTHORIZED'
  ORDER BY seniority_position`).all();

const deadlineItemSchema = z.object({ memberId: z.number().int().positive(), deadlineAt: z.string().min(16).nullable() });
const memberName = (member) => `${member.rank} ${member.operational_name}`;
const formatDeadline = (value) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
const isEligible = (member) => Boolean(member.active) && member.operational_status === 'ACTIVE' && member.authorization_status === 'AUTHORIZED';

function parseDeadlineValues(items) {
  const values = new Map();
  for (const item of items) {
    if (!item.deadlineAt) { values.set(item.memberId, null); continue; }
    const parsed = new Date(item.deadlineAt);
    if (Number.isNaN(parsed.getTime())) return { error: { message: `A data ou hora informada para o militar ID ${item.memberId} é inválida.`, memberId: item.memberId } };
    values.set(item.memberId, parsed.toISOString());
  }
  return { values };
}

function findDeadlineProblem(orderedMembers, values, { requireAll = false, requireFuture = false } = {}) {
  const eligible = orderedMembers.filter(isEligible);
  if (requireAll) {
    const missing = eligible.find((member) => !values.get(member.id));
    if (missing) return { code: 'MISSING_DEADLINE', memberId: missing.id, message: `Informe a data e a hora limite de ${memberName(missing)}.` };
  }
  if (requireFuture) {
    const expired = eligible.find((member) => values.get(member.id) && new Date(values.get(member.id)) <= new Date());
    if (expired) return { code: 'EXPIRED_DEADLINE', memberId: expired.id, message: `O prazo de ${memberName(expired)} (${formatDeadline(values.get(expired.id))}) já venceu. Escolha uma data e hora futura.` };
  }
  const scheduled = eligible.filter((member) => values.get(member.id));
  for (let index = 1; index < scheduled.length; index += 1) {
    const previous = scheduled[index - 1];
    const current = scheduled[index];
    if (new Date(values.get(current.id)) <= new Date(values.get(previous.id))) {
      return {
        code: 'DEADLINE_ORDER', memberId: current.id, previousMemberId: previous.id,
        message: `O prazo de ${memberName(current)} (${formatDeadline(values.get(current.id))}) precisa ser depois do prazo de ${memberName(previous)} (${formatDeadline(values.get(previous.id))}).`
      };
    }
  }
  return null;
}

function selectCurrentSchedule(orderedMembers, deadlines, minimumIndex = 0) {
  const candidates = orderedMembers.slice(minimumIndex);
  const upcomingOffset = candidates.findIndex((member) => {
    const value = deadlines.get(member.id);
    return value && new Date(value) > new Date();
  });
  if (upcomingOffset < 0) {
    return { error: { code: 'NO_UPCOMING_DEADLINE', message: 'Todos os prazos desta parte da fila já venceram. Atualize os horários para iniciar uma nova rodada.' } };
  }
  const startIndex = minimumIndex + upcomingOffset;
  const members = orderedMembers.slice(startIndex);
  const problem = findDeadlineProblem(members, deadlines, { requireAll: true, requireFuture: true });
  if (problem) return { error: problem };
  return { members, first: members[0], startIndex, skippedCount: startIndex };
}

function saveDeadlineValues(rankedIds, values, userId, stamp) {
  const save = db.prepare(`INSERT INTO marking_deadlines (member_id,deadline_at,updated_by,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(member_id) DO UPDATE SET deadline_at=excluded.deadline_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
  const remove = db.prepare('DELETE FROM marking_deadlines WHERE member_id=?');
  rankedIds.forEach((id) => values.get(id) ? save.run(id, values.get(id), userId, stamp) : remove.run(id));
}

router.get('/', (req, res) => {
  const turn = activeTurn();
  res.json({ items: db.prepare(membersQuery).all(), turn, markingMode: turn ? 'SENIORITY' : 'OPEN' });
});
router.get('/versions', (req, res) => res.json({ items: db.prepare('SELECT * FROM seniority_versions ORDER BY version DESC').all() }));
router.put('/', allow('ADMIN'), (req, res, next) => {
  try {
    const input = z.object({
      memberIds: z.array(z.number().int().positive()).min(1),
      reason: z.string().trim().min(5).optional(),
      deadlines: z.array(deadlineItemSchema).optional()
    }).parse(req.body);
    const { memberIds, deadlines } = input;
    const reason = input.reason || 'Ajuste rápido de antiguidade pelo painel';
    const currentMembers = db.prepare(membersQuery).all();
    const current = currentMembers.map(({ id }) => id);
    if (new Set(memberIds).size !== memberIds.length || current.length !== memberIds.length || memberIds.some((id) => !current.includes(id))) return res.status(400).json({ message: 'A nova ordem deve conter exatamente os militares autorizados.' });
    let deadlineValues = null;
    if (deadlines) {
      if (deadlines.length !== current.length || new Set(deadlines.map((item) => item.memberId)).size !== deadlines.length || current.some((id) => !deadlines.some((item) => item.memberId === id))) return res.status(400).json({ message: 'Envie os prazos de todos os militares ao alterar a ordem.' });
      const parsed = parseDeadlineValues(deadlines);
      if (parsed.error) return res.status(400).json(parsed.error);
      deadlineValues = parsed.values;
    }
    const stamp = now();
    const turnBeforeChange = activeTurn();
    db.transaction(() => {
      db.prepare('UPDATE members SET seniority_position=NULL').run();
      const update = db.prepare('UPDATE members SET seniority_position=?,updated_at=? WHERE id=?'); memberIds.forEach((id, index) => update.run(index + 1, stamp, id));
      if (deadlineValues) {
        saveDeadlineValues(memberIds, deadlineValues, req.user.id, stamp);
        const activeDeadline = turnBeforeChange && deadlineValues.get(turnBeforeChange.member_id);
        if (activeDeadline) db.prepare('UPDATE marking_turns SET deadline_at=? WHERE id=?').run(activeDeadline, turnBeforeChange.id);
      }
      const version = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS value FROM seniority_versions').get().value;
      db.prepare('INSERT INTO seniority_versions (version,order_json,reason,created_by,created_at) VALUES (?,?,?,?,?)').run(version, JSON.stringify(memberIds), reason, req.user.id, stamp);
    })();
    audit({ userId: req.user.id, action: 'REORDER', entityType: 'SENIORITY', entityId: 'current', before: current, after: { memberIds, deadlines: deadlines ?? undefined }, reason, req });
    res.json({ items: db.prepare(membersQuery).all(), turn: activeTurn() });
  } catch (error) { next(error); }
});

router.put('/deadlines', allow('ADMIN'), (req, res, next) => {
  try {
    const { items } = z.object({ items: z.array(deadlineItemSchema) }).parse(req.body);
    const ranked = db.prepare('SELECT id FROM members WHERE seniority_position IS NOT NULL ORDER BY seniority_position').all().map(({ id }) => id);
    if (items.length !== ranked.length || new Set(items.map((item) => item.memberId)).size !== items.length || ranked.some((id) => !items.some((item) => item.memberId === id))) return res.status(400).json({ message: 'Envie todos os militares da antiguidade.' });
    const parsed = parseDeadlineValues(items);
    if (parsed.error) return res.status(400).json(parsed.error);
    const values = parsed.values;
    const problem = findDeadlineProblem(db.prepare(membersQuery).all(), values);
    if (problem) return res.status(400).json(problem);
    const stamp = now();
    db.transaction(() => {
      saveDeadlineValues(ranked, values, req.user.id, stamp);
      const turn = activeTurn();
      const activeDeadline = turn && values.get(turn.member_id);
      if (activeDeadline) db.prepare('UPDATE marking_turns SET deadline_at=? WHERE id=?').run(activeDeadline, turn.id);
    })();
    audit({ userId: req.user.id, action: 'SAVE_MARKING_SCHEDULE', entityType: 'SENIORITY', entityId: 'deadlines', after: items, req });
    res.json({ items: db.prepare(membersQuery).all(), turn: activeTurn() });
  } catch (error) { next(error); }
});

router.post('/turn/start', allow('ADMIN'), async (req, res, next) => {
  try {
    if (activeTurn()) return res.status(409).json({ message: 'Já existe uma vez aberta.' });
    const members = eligibleMembers(); if (!members.length) return res.status(400).json({ message: 'Não há militar apto na antiguidade.' });
    const deadlines = new Map(db.prepare('SELECT member_id,deadline_at FROM marking_deadlines').all().map((item) => [item.member_id, item.deadline_at]));
    const selected = selectCurrentSchedule(members, deadlines);
    if (selected.error) return res.status(400).json(selected.error);
    const { first, skippedCount } = selected;
    const deadline = new Date(deadlines.get(first.id));
    db.prepare('INSERT INTO marking_turns (member_id,deadline_at,active,created_by,created_at) VALUES (?,?,1,?,?)').run(first.id, deadline.toISOString(), req.user.id, now());
    const turn = activeTurn();
    audit({ userId: req.user.id, action: 'START_MARKING_TURN', entityType: 'SENIORITY', entityId: String(turn.id), after: { memberId: first.id, deadlineAt: deadline.toISOString(), skippedExpired: skippedCount }, req });
    let notificationSent = false; try { notificationSent = await notifyCurrentMarkingTurn(); } catch (error) { req.log?.warn({ err: error }, 'Vez aberta sem envio ao WhatsApp.'); }
    res.status(201).json({ turn, notificationSent, skippedCount, message: skippedCount ? `${skippedCount} prazo(s) vencido(s) foram ignorados. A fila começou em ${memberName(first)}.` : `A fila começou em ${memberName(first)}.` });
  } catch (error) { next(error); }
});
router.post('/turn/notify', allow('ADMIN'), async (req, res, next) => { try { if (!activeTurn()) return res.status(400).json({ message: 'Não existe uma vez aberta.' }); res.json({ notificationSent: await notifyCurrentMarkingTurn() }); } catch (error) { next(error); } });
router.post('/turn/reset', allow('ADMIN'), async (req, res, next) => {
  try {
    const { startMemberId } = z.object({ startMemberId: z.number().int().positive().nullable().optional() }).parse(req.body ?? {});
    const orderedMembers = eligibleMembers();
    if (!orderedMembers.length) return res.status(400).json({ message: 'Não há militar apto na antiguidade.' });
    const requestedStartIndex = startMemberId ? orderedMembers.findIndex((member) => member.id === startMemberId) : 0;
    if (requestedStartIndex < 0) return res.status(400).json({ message: 'O militar escolhido não está apto para a fila.' });
    const deadlines = new Map(db.prepare('SELECT member_id,deadline_at FROM marking_deadlines').all().map((item) => [item.member_id, item.deadline_at]));
    const selected = selectCurrentSchedule(orderedMembers, deadlines, requestedStartIndex);
    if (selected.error) return res.status(400).json(selected.error);
    const { first, startIndex } = selected;
    const deadlineAt = deadlines.get(first.id);
    const stamp = now();
    db.transaction(() => {
      db.prepare('UPDATE marking_turns SET active=0,closed_at=? WHERE active=1').run(stamp);
      db.prepare('INSERT INTO marking_turns (member_id,deadline_at,active,created_by,created_at) VALUES (?,?,1,?,?)').run(first.id, deadlineAt, req.user.id, stamp);
    })();
    const turn = activeTurn();
    audit({ userId: req.user.id, action: 'RESET_MARKING_TURN', entityType: 'SENIORITY', entityId: String(turn.id), after: { memberId: first.id, deadlineAt, ignoredBefore: startIndex }, req });
    let notificationSent = false;
    try { notificationSent = await notifyCurrentMarkingTurn(); } catch (error) { req.log?.warn({ err: error }, 'Sequência reiniciada sem envio ao WhatsApp.'); }
    res.json({ turn, notificationSent, skippedCount: startIndex - requestedStartIndex, message: startIndex > requestedStartIndex ? `${startIndex - requestedStartIndex} prazo(s) vencido(s) foram ignorados. A fila recomeçou em ${memberName(first)}.` : `A fila recomeçou em ${memberName(first)}.` });
  } catch (error) { next(error); }
});
router.delete('/turn', allow('ADMIN'), (req, res) => {
  const previous = activeTurn();
  if (previous) {
    db.prepare('UPDATE marking_turns SET active=0,closed_at=? WHERE id=?').run(now(), previous.id);
    audit({ userId: req.user.id, action: 'CLOSE_MARKING_TURN', entityType: 'SENIORITY', entityId: String(previous.id), before: previous, after: { markingMode: 'OPEN' }, reason: 'Fila encerrada; marcação livre habilitada', req });
  }
  res.json({ turn: null, markingMode: 'OPEN', message: 'Fila encerrada. Qualquer militar ativo e autorizado pode marcar.' });
});
export default router;
