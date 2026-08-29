import argon2 from 'argon2';
import { db, now } from './index.js';
import { env } from '../config/env.js';

const seed = async () => {
  const stamp = now();
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get(env.ADMIN_EMAIL);
  if (!adminExists) db.prepare(`INSERT INTO users (name,email,password_hash,role,must_change_password,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run('Administrador CICC', env.ADMIN_EMAIL, await argon2.hash(env.ADMIN_INITIAL_PASSWORD), 'ADMIN', stamp, stamp);
  const wing = db.prepare('INSERT OR IGNORE INTO wings (name, code, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (let n = 1; n <= 5; n++) wing.run(`Ala ${n}`, `ALA-${n}`, stamp, stamp);
  const initialMembers = [
    ['Sub Ten','G. Souza','CICC'],['Sgt','Fragoso','CICC'],['Sgt','Duarte','CICC'],['Sgt','E. Silva','CICC'],['Sgt','Jansen','CICC'],['Sgt','Pedro Neto','CICC'],['Sgt','Jomar','CICC'],['Sgt','Santiago','APOIO'],['Sgt','Galdino','APOIO'],['Cb','Gelson','APOIO'],['Sd','Líssia','APOIO']
  ];
  const add = db.prepare(`INSERT OR IGNORE INTO members (rank,operational_name,seniority_position,unit_type,created_at,updated_at) VALUES (?,?,?,?,?,?)`);
  initialMembers.forEach(([rank, name, unit], index) => add.run(rank, name, index + 1, unit, stamp, stamp));
  console.log(`Dados iniciais prontos. Acesse com ${env.ADMIN_EMAIL} e altere a senha inicial.`);
};
seed();
