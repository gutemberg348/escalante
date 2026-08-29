import { Router } from 'express';
import { z } from 'zod';
import { allow } from '../../middlewares/auth.js';
import { audit } from '../../database/index.js';
import { connectWhatsApp, disconnectWhatsApp, getWhatsAppGroups, getWhatsAppStatus, resetWhatsAppSession, saveWhatsAppSettings, sendMarkingSchedule } from '../../messaging/whatsapp.js';
import { getAutomationSettings, refreshWhatsAppAutomation, saveAutomationSettings, sendDailySchedule, sendMarkingReminder, sendMonthlyOpening } from '../../messaging/automation.js';

const router = Router();
const settingsSchema = z.object({
  targetNumber: z.string().regex(/^\d{10,15}$/).optional().or(z.literal('')),
  groupJid: z.string().endsWith('@g.us').optional().or(z.literal('')),
  groupJids: z.array(z.string().endsWith('@g.us')).max(20).optional()
});
const automationSchema = z.object({
  dailyEnabled: z.boolean(),
  dailyTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  monthlyEnabled: z.boolean(),
  monthlyDay: z.number().int().min(1).max(31),
  monthlyTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  markingReminderEnabled: z.boolean(),
  markingReminderMinutes: z.number().int().min(5).max(720)
});

router.get('/status', (req, res) => res.json({ item: getWhatsAppStatus() }));
router.put('/settings', allow('ADMIN'), (req, res, next) => {
  try {
    const input = settingsSchema.parse(req.body);
    const item = saveWhatsAppSettings({ ...input, userId: req.user.id });
    audit({ userId: req.user.id, action: 'UPDATE', entityType: 'WHATSAPP_SETTINGS', entityId: 'default', after: input, req });
    res.json({ item });
  } catch (error) { next(error); }
});
router.post('/connect', allow('ADMIN'), async (req, res) => { const item = await connectWhatsApp(); audit({ userId:req.user.id, action:'CONNECT', entityType:'WHATSAPP', entityId:'default', req }); res.json({ item }); });
router.post('/disconnect', allow('ADMIN'), async (req, res) => { const item = await disconnectWhatsApp(); audit({ userId:req.user.id, action:'DISCONNECT', entityType:'WHATSAPP', entityId:'default', req }); res.json({ item }); });
router.post('/reset-session', allow('ADMIN'), async (req, res) => { const item = await resetWhatsAppSession(); audit({ userId:req.user.id, action:'RESET_SESSION', entityType:'WHATSAPP', entityId:'default', req }); res.json({ item }); });
router.get('/groups', allow('ADMIN'), async (req, res, next) => { try { res.json({ items: await getWhatsAppGroups() }); } catch (error) { next(error); } });
router.get('/automation', allow('ADMIN'), (req, res) => res.json({ item: getAutomationSettings() }));
router.put('/automation', allow('ADMIN'), (req, res, next) => {
  try {
    const input = automationSchema.parse(req.body);
    const item = saveAutomationSettings(input, req.user.id);
    audit({ userId: req.user.id, action: 'UPDATE', entityType: 'WHATSAPP_AUTOMATION', entityId: 'default', after: input, req });
    refreshWhatsAppAutomation().catch((error) => req.log?.error({ err: error }, 'Falha ao atualizar o agendador do WhatsApp.'));
    res.json({ item });
  } catch (error) { next(error); }
});
router.post('/automation/send-daily', allow('ADMIN'), async (req, res, next) => {
  try { res.json(await sendDailySchedule({ force: true })); } catch (error) { next(error); }
});
router.post('/automation/send-monthly', allow('ADMIN'), async (req, res, next) => {
  try { res.json(await sendMonthlyOpening({ force: true })); } catch (error) { next(error); }
});
router.post('/automation/send-reminder', allow('ADMIN'), async (req, res, next) => {
  try { res.json(await sendMarkingReminder({ force: true })); } catch (error) { next(error); }
});
router.post('/automation/send-schedule', allow('ADMIN'), async (req, res, next) => {
  try { res.json(await sendMarkingSchedule()); } catch (error) { next(error); }
});
export default router;
