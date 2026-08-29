import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ message: 'Sessão não encontrada.' });
  try { req.user = jwt.verify(token, env.SESSION_SECRET); return next(); }
  catch { return res.status(401).json({ message: 'Sessão expirada ou inválida.' }); }
}
export const allow = (...roles) => (req, res, next) => roles.includes(req.user.role)
  ? next() : res.status(403).json({ message: 'Perfil sem permissão para esta ação.' });
