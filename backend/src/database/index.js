import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env.js';

fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });
export const db = new Database(env.DATABASE_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','SCHEDULER','APPROVING_AUTHORITY','SYSTEM_OPERATOR')),
 active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT UNIQUE, base_date TEXT,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
 id INTEGER PRIMARY KEY AUTOINCREMENT, rank TEXT NOT NULL, operational_name TEXT NOT NULL, full_name TEXT,
 phone_number TEXT UNIQUE, whatsapp_jid TEXT UNIQUE, seniority_position INTEGER UNIQUE,
 unit_type TEXT NOT NULL, default_wing_id INTEGER, operational_status TEXT NOT NULL DEFAULT 'ACTIVE',
 authorization_status TEXT NOT NULL DEFAULT 'AUTHORIZED', active INTEGER NOT NULL DEFAULT 1, monthly_hour_limit INTEGER, hour_limit_exempt INTEGER NOT NULL DEFAULT 0, notes TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(default_wing_id) REFERENCES wings(id)
);
CREATE TABLE IF NOT EXISTS member_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, field_name TEXT NOT NULL, old_value TEXT,
 new_value TEXT, changed_by INTEGER NOT NULL, reason TEXT, changed_at TEXT NOT NULL,
 FOREIGN KEY(member_id) REFERENCES members(id), FOREIGN KEY(changed_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS seniority_versions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL UNIQUE, order_json TEXT NOT NULL,
 reason TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS competencies (
 id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, month INTEGER NOT NULL, name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'CONFIGURING', standard_hour_limit INTEGER NOT NULL DEFAULT 192,
 current_hour_limit INTEGER NOT NULL DEFAULT 192, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(year, month)
);
CREATE TABLE IF NOT EXISTS service_slots (
 id INTEGER PRIMARY KEY AUTOINCREMENT, competency_id INTEGER NOT NULL, service_date TEXT NOT NULL,
 period TEXT NOT NULL CHECK(period IN ('DIURNO','NOTURNO')), starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
 minimum_required INTEGER NOT NULL DEFAULT 2, normal_capacity INTEGER NOT NULL DEFAULT 2,
 current_capacity INTEGER NOT NULL DEFAULT 2, service_classification TEXT NOT NULL DEFAULT 'EXTRAORDINARY',
 is_majorado INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'OPEN', homologation_deadline TEXT NOT NULL,
 homologated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(competency_id) REFERENCES competencies(id), UNIQUE(competency_id, service_date, period)
);
CREATE TABLE IF NOT EXISTS capacity_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, service_slot_id INTEGER NOT NULL, previous_capacity INTEGER NOT NULL,
 new_capacity INTEGER NOT NULL, authority_name TEXT NOT NULL, authorization_reference TEXT NOT NULL,
 reason TEXT NOT NULL, changed_by INTEGER NOT NULL, changed_at TEXT NOT NULL,
 FOREIGN KEY(service_slot_id) REFERENCES service_slots(id), FOREIGN KEY(changed_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, service_slot_id INTEGER NOT NULL, position_number INTEGER NOT NULL,
 member_id INTEGER NOT NULL, service_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CONFIRMED',
 protocol TEXT NOT NULL UNIQUE, confirmed_at TEXT NOT NULL, cancelled_at TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, FOREIGN KEY(service_slot_id) REFERENCES service_slots(id),
 FOREIGN KEY(member_id) REFERENCES members(id), UNIQUE(service_slot_id, position_number)
);
CREATE TABLE IF NOT EXISTS unavailabilities (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, type TEXT NOT NULL, starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL, affects_ordinary INTEGER NOT NULL DEFAULT 1, affects_extraordinary INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'ACTIVE', reference TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, FOREIGN KEY(member_id) REFERENCES members(id), FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, member_id INTEGER, action TEXT NOT NULL,
 entity_type TEXT NOT NULL, entity_id TEXT, before_json TEXT, after_json TEXT, reason TEXT,
 ip_address TEXT, user_agent TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(member_id) REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
`);

export const now = () => new Date().toISOString();
export function audit({ userId, action, entityType, entityId, before, after, reason, req }) {
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, before_json, after_json, reason, ip_address, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId ?? null, action, entityType, String(entityId ?? ''), before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null, reason ?? null, req?.ip ?? null, req?.get('user-agent') ?? null, now());
}
