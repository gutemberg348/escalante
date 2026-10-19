import { Router } from 'express';
import dayjs from 'dayjs';
import { z } from 'zod';
import { db, now, audit } from '../../database/index.js';
import { allow } from '../../middlewares/auth.js';
import { generateOrdinaryAssignments } from '../../scheduling/monthly.js';
import { fiveWings, monthStart, wingDays, wingAnchorsForMonth, cycleRuleForMonth, membershipsForMonth, previewWingImport, saveWingRoster } from '../../scheduling/wings.js';

const router = Router();
const id = z.coerce.number().int().positive();
const mode = z.literal('CONTINUOUS').default('CONTINUOUS');
const entry = z.object({ memberId: id, wingId: id, positionNumber: z.number().int().min(1).max(2) });
const fail = (message, status = 400, details = {}) => { throw Object.assign(new Error(message), { status, details }); };
const competencyFor = (value) => {
  const competency = db.prepare('SELECT * FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(id.parse(value));
  if (!competency) fail('Selecione uma escala já gerada.', 404);
  return competency;
};
const nextMonth = (competency) => {
  const date = dayjs(monthStart(competency)).add(1, 'month');
  return { year: date.year(), month: date.month() + 1, id: db.prepare('SELECT id FROM competencies WHERE year=? AND month=?').get(date.year(), date.month() + 1)?.id ?? -1 };
};
const handle = (fn) => (req, res, next) => {
  try { fn(req, res); } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, ...error.details });
    next(error);
  }
};

function validateEntries(entries) {
  const ids = new Set();
  const wingIds = new Set(fiveWings().map((wing) => wing.id));
  for (const item of entries) {
    if (ids.has(item.memberId)) fail('Um militar só pode ter uma ala por alteração.');
    ids.add(item.memberId);
    if (!wingIds.has(item.wingId)) fail('Escolha uma das cinco alas.');
    if (!db.prepare('SELECT id FROM members WHERE id=?').get(item.memberId)) fail('Militar não encontrado.', 404);
  }
}

function validateRoster(competency) {
  const occupied = new Map();
  for (const row of wingAnchorsForMonth(competency)) {
    let date = dayjs(row.last_service_date).add(5, 'day');
    for (; date.format('YYYY-MM-DD') <= dayjs(monthStart(competency)).endOf('month').format('YYYY-MM-DD'); date = date.add(5, 'day')) {
      const dateKey = date.format('YYYY-MM-DD');
      if ((row.from_date && dateKey < row.from_date) || (row.until_date && dateKey > row.until_date)) continue;
      const key = `${dateKey}:${row.position_number}`;
      if (occupied.has(key) && occupied.get(key) !== row.member_id) {
        const first = db.prepare('SELECT rank,operational_name FROM members WHERE id=?').get(occupied.get(key));
        const second = db.prepare('SELECT rank,operational_name FROM members WHERE id=?').get(row.member_id);
        fail(`${first.rank} ${first.operational_name} e ${second.rank} ${second.operational_name} estão na mesma posição da mesma ala. Escolha outra posição ou use a troca entre militares.`, 409);
      }
      occupied.set(key, row.member_id);
    }
  }
}

router.get('/', handle((req, res) => {
  const competency = competencyFor(req.query.competency_id);
  const rule = cycleRuleForMonth(monthStart(competency));
  const future = nextMonth(competency);
  res.json({ competency, configured: Boolean(db.prepare('SELECT 1 FROM wing_cycle_rules LIMIT 1').get()), rule,
    wings: fiveWings().map((wing) => ({ ...wing, dates: wingDays(competency, wing.number, rule) })),
    memberships: membershipsForMonth(competency), nextMemberships: membershipsForMonth(future),
    nextMonth: { ...future, startsAt: monthStart(future), rule: cycleRuleForMonth(monthStart(future)) },
    members: db.prepare(`SELECT id,rank,operational_name,active,operational_status,authorization_status,ordinary_eligible
      FROM members ORDER BY COALESCE(seniority_position,99999),rank,operational_name`).all()
  });
}));

router.get('/import-preview', allow('ADMIN', 'SCHEDULER'), handle((req, res) => {
  const competency = competencyFor(req.query.competency_id);
  res.json(previewWingImport(competency));
}));

router.post('/import', allow('ADMIN', 'SCHEDULER'), handle((req, res) => {
  const input = z.object({ competencyId: id, mode, entries: z.array(entry).min(1).max(100) }).parse(req.body);
  const competency = competencyFor(input.competencyId);
  validateEntries(input.entries);
  db.transaction(() => {
    saveWingRoster({ competency, entries: input.entries, mode: input.mode, userId: req.user.id });
    validateRoster(competency);
  })();
  res.json({ message: 'Cinco alas cadastradas. A escala selecionada foi preservada; as próximas gerações já usarão as alas.' });
}));

router.put('/cycle', allow('ADMIN', 'SCHEDULER'), handle((req, res) => {
  const input = z.object({ competencyId: id, mode }).parse(req.body);
  const competency = competencyFor(input.competencyId);
  const rule = cycleRuleForMonth(monthStart(competency));
  if (!rule) fail('Cadastre as alas antes de alterar o ciclo.');
  res.json({ message: 'O ciclo 1x4 é contínuo. A sequência das alas é mantida na virada do mês, sem reiniciar no dia 1.' });
}));

router.post('/move', allow('ADMIN', 'SCHEDULER'), handle((req, res) => {
  const input = z.object({ competencyId: id, scope: z.enum(['THIS_MONTH', 'NEXT_MONTH']),
    entries: z.array(entry).min(1).max(2), fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
  const competency = competencyFor(input.competencyId);
  if (!cycleRuleForMonth(monthStart(competency))) fail('Cadastre as alas desse mês antes de remanejar.');
  validateEntries(input.entries);
  const stamp = now();
  const fromDate = input.fromDate ?? [monthStart(competency), dayjs().format('YYYY-MM-DD')].sort().at(-1);
  const target = input.scope === 'NEXT_MONTH' ? nextMonth(competency) : competency;
  if (monthStart(target) < dayjs().startOf('month').format('YYYY-MM-DD')) fail('Não é possível alterar alas de um mês passado.');
  if (input.scope === 'THIS_MONTH' && (!dayjs(fromDate).isValid() || dayjs(fromDate).format('YYYY-MM-DD') !== fromDate
      || fromDate < monthStart(competency) || fromDate > dayjs(monthStart(competency)).endOf('month').format('YYYY-MM-DD')
      || fromDate < dayjs().format('YYYY-MM-DD'))) fail('Escolha uma data válida, de hoje em diante, dentro do mês selecionado.');
  let generation = null;
  db.transaction(() => {
    const before = membershipsForMonth(target);
    for (const item of input.entries) {
      if (input.scope === 'NEXT_MONTH') {
        db.prepare(`INSERT INTO wing_memberships (member_id,wing_id,position_number,effective_month,updated_by,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(member_id,effective_month) DO UPDATE SET wing_id=excluded.wing_id,position_number=excluded.position_number,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .run(item.memberId, item.wingId, item.positionNumber, monthStart(target), req.user.id, stamp);
      } else {
        const locked = db.prepare(`SELECT 1 FROM service_slots s JOIN assignments a ON a.service_slot_id=s.id
          WHERE s.competency_id=? AND s.service_date>=? AND a.member_id=? AND a.service_type='ORDINARY'
            AND a.status='CONFIRMED' AND (s.status<>'OPEN' OR s.homologated_at IS NOT NULL) LIMIT 1`).get(competency.id, fromDate, item.memberId);
        if (locked) fail('Há serviços fechados ou homologados neste período. Escolha outra data para remanejar.', 409);
        db.prepare(`INSERT INTO wing_month_overrides (competency_id,member_id,wing_id,position_number,from_date,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(competency_id,member_id,from_date) DO UPDATE SET wing_id=excluded.wing_id,position_number=excluded.position_number,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .run(competency.id, item.memberId, item.wingId, item.positionNumber, fromDate, req.user.id, stamp);
        db.prepare(`DELETE FROM assignments WHERE member_id=? AND service_type='ORDINARY' AND status='CONFIRMED'
          AND service_slot_id IN (SELECT id FROM service_slots WHERE competency_id=? AND service_date>=?)`).run(item.memberId, competency.id, fromDate);
      }
    }
    validateRoster(target);
    if (input.scope === 'NEXT_MONTH') {
      validateRoster({ ...target, id: -1 });
      // Uma troca futura também deve respeitar outras mudanças já programadas.
      const futureMonths = db.prepare('SELECT DISTINCT effective_month FROM wing_memberships WHERE effective_month>?').all(monthStart(target));
      for (const row of futureMonths) {
        const date = dayjs(row.effective_month);
        validateRoster({ id: -1, year: date.year(), month: date.month() + 1 });
      }
    } else {
      generation = generateOrdinaryAssignments({ competencyId: competency.id, userId: req.user.id,
        memberIds: input.entries.map((item) => item.memberId), fromDate, reason: 'Remanejamento de ala somente neste mês' });
      if (generation.conflictDays.length) fail('O destino tem serviços ocupados ou posições indisponíveis. Nenhuma alteração foi salva. Use a troca entre militares ou ajuste as vagas no painel.', 409,
        { conflicts: generation.conflictDays });
    }
    audit({ userId: req.user.id, action: 'MOVE_WING_MEMBERS', entityType: 'COMPETENCY', entityId: competency.id,
      before, after: input, reason: input.scope === 'NEXT_MONTH' ? 'Troca permanente a partir do próximo mês' : 'Remanejamento temporário, mantendo os extras' });
  })();
  res.json({ generation, message: input.scope === 'NEXT_MONTH'
    ? `Troca programada para ${dayjs(monthStart(target)).format('MM/YYYY')} em diante. Se esse mês já foi gerado, use Regerar para aplicar.`
    : 'Remanejamento aplicado somente neste mês. Serviços extras e datas anteriores foram preservados.' });
}));

export default router;
