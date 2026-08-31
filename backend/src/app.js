import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { db } from './database/index.js';
import authRoutes from './modules/auth/routes.js';
import memberRoutes from './modules/members/routes.js';
import seniorityRoutes from './modules/seniority/routes.js';
import competencyRoutes from './modules/competencies/routes.js';
import serviceSlotRoutes from './modules/service-slots/routes.js';
import whatsappRoutes from './modules/whatsapp/routes.js';
import { requireAuth } from './middlewares/auth.js';

const app = express();
app.set('trust proxy', 1);
app.use(pinoHttp({ level: env.LOG_LEVEL }));
app.use(helmet());
app.use(cors({ origin: env.WEB_URL, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));
app.use('/api/members', requireAuth, memberRoutes);
app.use('/api/seniority', requireAuth, seniorityRoutes);
app.use('/api/competencies', requireAuth, competencyRoutes);
app.use('/api/service-slots', requireAuth, serviceSlotRoutes);
app.use('/api/whatsapp', requireAuth, whatsappRoutes);
app.get('/api/dashboard', requireAuth, (_, res) => {
  const today = new Date();
  const currentMonthIndex = today.getFullYear() * 12 + today.getMonth() + 1;
  const competency = db.prepare(`SELECT * FROM competencies
    ORDER BY CASE WHEN (year * 12 + month) >= ? THEN 0 ELSE 1 END,
      CASE WHEN (year * 12 + month) >= ? THEN (year * 12 + month) END ASC,
      year DESC, month DESC LIMIT 1`).get(currentMonthIndex, currentMonthIndex);
  const activeMembers = Number(db.prepare(`SELECT COUNT(*) AS total FROM members
    WHERE active=1 AND operational_status='ACTIVE' AND authorization_status='AUTHORIZED'`).get().total || 0);
  if (!competency) return res.json({ competency: null, cards: { eligible_members: activeMembers, vacant_days: 0, available_vacancies: 0, coverage_percent: 0 } });
  const metrics = db.prepare(`SELECT
    COUNT(DISTINCT CASE WHEN confirmed_count < current_capacity AND status='OPEN' AND homologated_at IS NULL THEN service_date END) AS vacant_days,
    SUM(CASE WHEN confirmed_count < current_capacity AND status='OPEN' AND homologated_at IS NULL THEN current_capacity-confirmed_count ELSE 0 END) AS available_vacancies,
    ROUND(100.0 * SUM(confirmed_count) / NULLIF(SUM(current_capacity),0)) AS coverage_percent
    FROM (SELECT s.*,COUNT(CASE WHEN a.status='CONFIRMED' THEN 1 END) AS confirmed_count
      FROM service_slots s LEFT JOIN assignments a ON a.service_slot_id=s.id
      WHERE s.competency_id=? GROUP BY s.id)`).get(competency.id);
  res.json({ competency: { id: competency.id, name: competency.name }, cards: {
    eligible_members: activeMembers,
    vacant_days: Number(metrics.vacant_days || 0),
    available_vacancies: Number(metrics.available_vacancies || 0),
    coverage_percent: Number(metrics.coverage_percent || 0)
  } });
});
app.use((req, res) => res.status(404).json({ message: 'Rota não encontrada.' }));
app.use((error, req, res, next) => {
  req.log?.error(error);
  if (error.name === 'ZodError') return res.status(400).json({ message: 'Dados inválidos.', issues: error.issues });
  if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ message: 'Já existe um registro com estes dados.' });
  return res.status(500).json({ message: 'Erro interno do servidor.' });
});
export default app;
