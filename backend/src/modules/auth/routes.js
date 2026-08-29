import { Router } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, audit, now } from '../../database/index.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middlewares/auth.js';

const router = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.toLowerCase());
    if (!user || !(await argon2.verify(user.password_hash, password))) return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, env.SESSION_SECRET, { expiresIn: '8h' });
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: 28800000 });
    audit({ userId: user.id, action: 'LOGIN', entityType: 'USER', entityId: user.id, req });
    return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.must_change_password) } });
  } catch (error) { next(error); }
});
router.post('/logout', requireAuth, (req, res) => {
  res.clearCookie('session'); audit({ userId: req.user.id, action: 'LOGOUT', entityType: 'USER', entityId: req.user.id, req });
  res.status(204).end();
});
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,role,must_change_password FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: { ...user, mustChangePassword: Boolean(user.must_change_password) } });
});
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { password } = z.object({ password: z.string().min(12) }).parse(req.body);
    db.prepare('UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?').run(await argon2.hash(password), now(), req.user.id);
    audit({ userId: req.user.id, action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: req.user.id, req });
    res.status(204).end();
  } catch (error) { next(error); }
});
export default router;
