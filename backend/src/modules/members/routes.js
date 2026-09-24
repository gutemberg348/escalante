import { Router } from 'express';
import { z } from 'zod';
import { db, audit, now } from '../../database/index.js';
import { allow } from '../../middlewares/auth.js';
import { discoverMemberWhatsAppJid } from '../../messaging/whatsapp.js';
import { applyVacationToCompetency } from '../../scheduling/member-status.js';
import { regenerateOrdinaryAssignments } from '../../scheduling/monthly.js';

const router = Router();
const statuses = z.enum(['ACTIVE','VACATION','LEAVE','AWAY','INACTIVE']);
const authorizations = z.enum(['AUTHORIZED','PENDING','SUSPENDED','NOT_AUTHORIZED']);
const memberSchema = z.object({
  rank: z.string().min(1), operational_name: z.string().min(2), full_name: z.string().optional().nullable(),
  phone_number: z.string().regex(/^\d{10,15}$/).optional().nullable(), whatsapp_jid: z.string().endsWith('@s.whatsapp.net').optional().nullable(),
  unit_type: z.string().min(1), default_wing_id: z.coerce.number().int().positive().optional().nullable(),
  operational_status: statuses.optional(), authorization_status: authorizations.optional(), active: z.boolean().optional(),
  monthly_hour_limit: z.coerce.number().int().min(12).max(192).optional().nullable(), hour_limit_exempt: z.boolean().optional(),
  ordinary_eligible: z.boolean().optional(), notes: z.string().optional().nullable()
});
const memberPatchSchema = memberSchema.partial().extend({
  competency_id: z.coerce.number().int().positive().optional().nullable(),
  vacation_extra_action: z.enum(['KEEP', 'REMOVE']).optional().nullable()
});
const base = `SELECT m.*, w.name AS wing_name FROM members m LEFT JOIN wings w ON w.id=m.default_wing_id`;

function phoneVariants(phoneNumber) {
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

function defaultJid(phoneNumber) {
  return null;
}

function jidMatchesPhone(whatsappJid, phoneNumber) {
  if (!whatsappJid || !phoneNumber || !whatsappJid.endsWith('@s.whatsapp.net')) return false;
  const jidPhone = whatsappJid.split('@')[0].split(':')[0];
  return phoneVariants(phoneNumber).includes(jidPhone);
}

function synchronizeWhatsAppIdentities(memberId, phoneNumber, whatsappJid) {
  if (!whatsappJid) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO member_whatsapp_identities
    (member_id,jid,phone_number,source,verified_at) VALUES (?,?,?,?,?)`);
  insert.run(memberId, whatsappJid, phoneNumber, 'MANUAL', now());
}

function findDuplicateMember(rank, operationalName, excludeId = null) {
  return db.prepare(`SELECT id,rank,operational_name FROM members
    WHERE lower(trim(rank))=lower(trim(?)) AND lower(trim(operational_name))=lower(trim(?))
      AND (? IS NULL OR id<>?) LIMIT 1`)
    .get(rank, operationalName, excludeId, excludeId);
}

router.get('/', (req, res, next) => {
  try {
    const competencyId = req.query.competency_id ? z.coerce.number().int().positive().parse(req.query.competency_id) : null;
    if (!competencyId) return res.json({ items: db.prepare(`${base} ORDER BY m.seniority_position IS NULL, m.seniority_position, m.operational_name`).all().map((item) => ({ ...item, monthly_hours: 0, effective_hour_limit: null })) });
    const competency = db.prepare('SELECT current_hour_limit FROM competencies WHERE id=?').get(competencyId);
    if (!competency) return res.status(404).json({ message: 'Competência não encontrada.' });
    const monthlyHourLimit = Math.min(Number(competency.current_hour_limit || 192), 192);
    const items = db.prepare(`SELECT m.*,w.name AS wing_name,COALESCE(hours.marked_hours,0) AS monthly_hours,
      CASE WHEN m.hour_limit_exempt=1 THEN NULL ELSE COALESCE(m.monthly_hour_limit,?) END AS effective_hour_limit
      FROM members m LEFT JOIN wings w ON w.id=m.default_wing_id
      LEFT JOIN (SELECT a.member_id,COUNT(a.id)*12 AS marked_hours FROM assignments a
        JOIN service_slots s ON s.id=a.service_slot_id WHERE s.competency_id=?
          AND a.status='CONFIRMED' AND a.service_type='EXTRAORDINARY' GROUP BY a.member_id) hours ON hours.member_id=m.id
      ORDER BY m.seniority_position IS NULL,m.seniority_position,m.operational_name`).all(monthlyHourLimit, competencyId);
    res.json({ items });
  } catch (error) { next(error); }
});
router.get('/:id', (req, res) => {
  const item = db.prepare(`${base} WHERE m.id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ message: 'Militar não encontrado.' });
  return res.json({ item, history: db.prepare('SELECT * FROM member_history WHERE member_id=? ORDER BY changed_at DESC').all(req.params.id) });
});
router.post('/', allow('ADMIN','SCHEDULER'), async (req, res, next) => {
  try {
    const input = memberSchema.parse(req.body); const stamp = now();
    const rank = input.rank.trim();
    const operationalName = input.operational_name.trim();
    const duplicate = findDuplicateMember(rank, operationalName);
    if (duplicate) return res.status(409).json({ message: `${duplicate.rank} ${duplicate.operational_name} já está cadastrado.` });
    const nextPosition = db.prepare('SELECT COALESCE(MAX(seniority_position),0)+1 AS value FROM members').get().value;
    const record = {
      ...input,
      rank,
      operational_name: operationalName,
      full_name: input.full_name ?? null,
      phone_number: input.phone_number ?? null,
      whatsapp_jid: input.whatsapp_jid ?? defaultJid(input.phone_number),
      default_wing_id: input.default_wing_id ?? null,
      monthly_hour_limit: input.monthly_hour_limit ?? null,
      hour_limit_exempt: input.hour_limit_exempt ? 1 : 0,
      ordinary_eligible: input.ordinary_eligible === false ? 0 : 1,
      notes: input.notes ?? null,
      seniority_position: input.authorization_status === 'NOT_AUTHORIZED' ? null : nextPosition,
      operational_status: input.operational_status ?? 'ACTIVE',
      authorization_status: input.authorization_status ?? 'AUTHORIZED',
      active: input.active === false ? 0 : 1,
      created_at: stamp,
      updated_at: stamp
    };
    const result = db.transaction(() => {
      const inserted = db.prepare(`INSERT INTO members (rank,operational_name,full_name,phone_number,whatsapp_jid,seniority_position,unit_type,default_wing_id,operational_status,authorization_status,active,monthly_hour_limit,hour_limit_exempt,ordinary_eligible,notes,created_at,updated_at)
      VALUES (@rank,@operational_name,@full_name,@phone_number,@whatsapp_jid,@seniority_position,@unit_type,@default_wing_id,@operational_status,@authorization_status,@active,@monthly_hour_limit,@hour_limit_exempt,@ordinary_eligible,@notes,@created_at,@updated_at)`)
        .run(record);
      synchronizeWhatsAppIdentities(inserted.lastInsertRowid, record.phone_number, record.whatsapp_jid);
      return inserted;
    })();
    let item = db.prepare('SELECT * FROM members WHERE id=?').get(result.lastInsertRowid);
    await discoverMemberWhatsAppJid(item.id).catch(() => null);
    item = db.prepare('SELECT * FROM members WHERE id=?').get(result.lastInsertRowid); audit({ userId: req.user.id, action: 'CREATE', entityType: 'MEMBER', entityId: item.id, after: item, req });
    res.status(201).json({ item });
  } catch (error) { next(error); }
});
router.patch('/:id', allow('ADMIN','SCHEDULER'), async (req, res, next) => {
  try {
    const parsed = memberPatchSchema.parse(req.body);
    const { competency_id: competencyId = null, vacation_extra_action: vacationExtraAction = null, ...input } = parsed;
    const old = db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ message: 'Militar não encontrado.' });
    const competency = competencyId
      ? db.prepare('SELECT * FROM competencies WHERE id=? AND generated_at IS NOT NULL').get(competencyId)
      : null;
    if (competencyId && !competency) return res.status(404).json({ message: 'Escala selecionada não encontrada.' });
    const nextRank = input.rank?.trim() ?? old.rank;
    const nextOperationalName = input.operational_name?.trim() ?? old.operational_name;
    if (input.rank !== undefined || input.operational_name !== undefined) {
      const duplicate = findDuplicateMember(nextRank, nextOperationalName, old.id);
      if (duplicate) return res.status(409).json({ message: `${duplicate.rank} ${duplicate.operational_name} já está cadastrado.` });
    }
    const phoneChanged = input.phone_number !== undefined && input.phone_number !== old.phone_number;
    const merged = {
      ...old,
      ...input,
      rank: nextRank,
      operational_name: nextOperationalName,
      whatsapp_jid: phoneChanged
        ? (jidMatchesPhone(input.whatsapp_jid, input.phone_number) ? input.whatsapp_jid : null)
        : (input.whatsapp_jid ?? old.whatsapp_jid ?? defaultJid(input.phone_number ?? old.phone_number)),
      active: input.active === undefined ? old.active : (input.active ? 1 : 0),
      hour_limit_exempt: input.hour_limit_exempt === undefined
        ? Number(old.hour_limit_exempt || 0)
        : (input.hour_limit_exempt ? 1 : 0),
      ordinary_eligible: input.ordinary_eligible === undefined
        ? Number(old.ordinary_eligible ?? 1)
        : (input.ordinary_eligible ? 1 : 0),
      updated_at: now()
    };
    let statusEffect = null;
    if (competency && old.operational_status !== 'VACATION' && merged.operational_status === 'VACATION') {
      statusEffect = applyVacationToCompetency({
        memberId: old.id,
        competencyId: competency.id,
        extraAction: vacationExtraAction,
        userId: req.user.id,
        reason: 'Férias aplicadas pelo painel administrativo'
      });
      if (statusEffect.confirmationRequired) {
        return res.status(409).json({
          code: 'VACATION_EXTRAS_CONFIRMATION',
          message: `${old.rank} ${old.operational_name} possui serviços extras na escala selecionada. Escolha se deseja mantê-los ou retirá-los.`,
          impact: {
            ordinaryAssignments: statusEffect.ordinaryAssignments,
            extraordinaryAssignments: statusEffect.extraordinaryAssignments
          }
        });
      }
    }
    db.transaction(() => {
      if (phoneChanged) db.prepare('DELETE FROM member_whatsapp_identities WHERE member_id=?').run(merged.id);
      db.prepare(`UPDATE members SET rank=@rank,operational_name=@operational_name,full_name=@full_name,phone_number=@phone_number,whatsapp_jid=@whatsapp_jid,unit_type=@unit_type,default_wing_id=@default_wing_id,operational_status=@operational_status,authorization_status=@authorization_status,active=@active,monthly_hour_limit=@monthly_hour_limit,hour_limit_exempt=@hour_limit_exempt,ordinary_eligible=@ordinary_eligible,notes=@notes,updated_at=@updated_at WHERE id=@id`).run(merged);
      synchronizeWhatsAppIdentities(merged.id, merged.phone_number, merged.whatsapp_jid);
    })();
    await discoverMemberWhatsAppJid(merged.id).catch(() => null);
    if (competency && old.operational_status !== 'ACTIVE' && merged.operational_status === 'ACTIVE') {
      statusEffect = {
        type: 'REGENERATED_ON_REACTIVATION',
        generation: regenerateOrdinaryAssignments({
          competencyId: competency.id,
          userId: req.user.id,
          reason: `Escala regerada após retorno de ${merged.rank} ${merged.operational_name} ao status Ativo`
        })
      };
    }
    const item = db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id); audit({ userId:req.user.id, action:'UPDATE', entityType:'MEMBER', entityId:item.id, before:old, after:{ ...item, statusEffect }, req });
    res.json({ item, statusEffect, competency: competency ? { id: competency.id, name: competency.name } : null });
  } catch (error) { next(error); }
});
router.delete('/:id', allow('ADMIN','SCHEDULER'), (req, res, next) => {
  try {
    const memberId = z.coerce.number().int().positive().parse(req.params.id);
    const old = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
    if (!old) return res.status(404).json({ message: 'Militar não encontrado.' });
    const references = {
      assignments: db.prepare('SELECT COUNT(*) count FROM assignments WHERE member_id=?').get(memberId).count,
      unavailabilities: db.prepare('SELECT COUNT(*) count FROM unavailabilities WHERE member_id=?').get(memberId).count,
      turns: db.prepare('SELECT COUNT(*) count FROM marking_turns WHERE member_id=?').get(memberId).count,
      deadlines: db.prepare('SELECT COUNT(*) count FROM marking_deadlines WHERE member_id=?').get(memberId).count,
      passes: db.prepare('SELECT COUNT(*) count FROM bot_passes WHERE member_id=?').get(memberId).count
    };
    if (Object.values(references).some((count) => Number(count) > 0)) {
      return res.status(409).json({ message: 'Este militar já possui escala ou histórico operacional. Desative o cadastro em vez de excluir.' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM member_whatsapp_identities WHERE member_id=?').run(memberId);
      db.prepare('DELETE FROM member_history WHERE member_id=?').run(memberId);
      db.prepare('UPDATE audit_logs SET member_id=NULL WHERE member_id=?').run(memberId);
      db.prepare('DELETE FROM members WHERE id=?').run(memberId);
      const ordered = db.prepare('SELECT id FROM members WHERE seniority_position IS NOT NULL ORDER BY seniority_position,id').all();
      db.prepare('UPDATE members SET seniority_position=-id WHERE seniority_position IS NOT NULL').run();
      const updatePosition = db.prepare('UPDATE members SET seniority_position=?,updated_at=? WHERE id=?');
      ordered.forEach((member, index) => updatePosition.run(index + 1, now(), member.id));
    })();
    audit({ userId:req.user.id, action:'DELETE', entityType:'MEMBER', entityId:memberId, before:old, req });
    return res.status(204).end();
  } catch (error) { next(error); }
});
router.post('/:id/authorize', allow('ADMIN','SCHEDULER'), (req,res) => { db.prepare(`UPDATE members SET authorization_status='AUTHORIZED', active=1, updated_at=? WHERE id=?`).run(now(),req.params.id); audit({userId:req.user.id,action:'AUTHORIZE',entityType:'MEMBER',entityId:req.params.id,req}); res.status(204).end(); });
router.post('/:id/suspend', allow('ADMIN','SCHEDULER'), (req,res) => { db.prepare(`UPDATE members SET authorization_status='SUSPENDED', updated_at=? WHERE id=?`).run(now(),req.params.id); audit({userId:req.user.id,action:'SUSPEND',entityType:'MEMBER',entityId:req.params.id,req}); res.status(204).end(); });
export default router;
