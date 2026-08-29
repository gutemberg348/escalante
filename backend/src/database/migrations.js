import { db, now } from './index.js';

const migrations = [
  {
    version: '001_whatsapp_messages',
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_messages (
          message_id TEXT PRIMARY KEY,
          sender_jid TEXT,
          received_at TEXT NOT NULL,
          processed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          remote_jid TEXT NOT NULL,
          sender_jid TEXT,
          direction TEXT NOT NULL,
          body TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_sender ON whatsapp_messages(sender_jid, created_at);
      `);
    }
  },
  {
    version: '002_member_whatsapp_identities',
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS member_whatsapp_identities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          jid TEXT NOT NULL UNIQUE,
          phone_number TEXT,
          source TEXT NOT NULL DEFAULT 'MESSAGE',
          verified_at TEXT NOT NULL,
          FOREIGN KEY(member_id) REFERENCES members(id)
        );
        CREATE INDEX IF NOT EXISTS idx_member_whatsapp_identities_member ON member_whatsapp_identities(member_id);
        CREATE INDEX IF NOT EXISTS idx_member_whatsapp_identities_phone ON member_whatsapp_identities(phone_number);
      `);
    }
  },
  {
    version: '003_backfill_member_whatsapp_identities',
    apply() {
      const members = db.prepare(`SELECT id,phone_number,whatsapp_jid FROM members WHERE phone_number IS NOT NULL AND phone_number<>''`).all();
      const updateJid = db.prepare('UPDATE members SET whatsapp_jid=?,updated_at=? WHERE id=?');
      const insertIdentity = db.prepare(`INSERT OR IGNORE INTO member_whatsapp_identities
        (member_id,jid,phone_number,source,verified_at) VALUES (?,?,?,?,?)`);
      for (const member of members) {
        const variants = new Set([member.phone_number]);
        if (member.phone_number.startsWith('55') && member.phone_number.length === 13 && member.phone_number[4] === '9') {
          variants.add(`${member.phone_number.slice(0, 4)}${member.phone_number.slice(5)}`);
        }
        if (member.phone_number.startsWith('55') && member.phone_number.length === 12) {
          variants.add(`${member.phone_number.slice(0, 4)}9${member.phone_number.slice(4)}`);
        }
        const canonicalJid = member.whatsapp_jid || `${member.phone_number}@s.whatsapp.net`;
        if (!member.whatsapp_jid) updateJid.run(canonicalJid, now(), member.id);
        variants.add(canonicalJid.split('@')[0]);
        for (const phone of variants) insertIdentity.run(member.id, `${phone}@s.whatsapp.net`, member.phone_number, 'MIGRATION', now());
      }
    }
  },
  {
    version: '004_bot_passes',
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_passes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          competency_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          passed_at TEXT NOT NULL,
          UNIQUE(competency_id, member_id),
          FOREIGN KEY(competency_id) REFERENCES competencies(id),
          FOREIGN KEY(member_id) REFERENCES members(id)
        );
      `);
    }
  },
  {
    version: '005_marking_turns',
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS marking_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          deadline_at TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          FOREIGN KEY(member_id) REFERENCES members(id),
          FOREIGN KEY(created_by) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_marking_turns_active ON marking_turns(active, created_at DESC);
      `);
    }
  },
  {
    version: '006_marking_deadlines',
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS marking_deadlines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL UNIQUE,
          deadline_at TEXT NOT NULL,
          updated_by INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(member_id) REFERENCES members(id),
          FOREIGN KEY(updated_by) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_marking_deadlines_deadline ON marking_deadlines(deadline_at);
      `);
    }
  },
  {
    version: '007_schedule_pdf_column_releases',
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedule_pdf_column_releases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          competency_id INTEGER NOT NULL,
          service_date TEXT NOT NULL,
          third_column_open INTEGER NOT NULL DEFAULT 0,
          fourth_column_open INTEGER NOT NULL DEFAULT 0,
          updated_by INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(competency_id, service_date),
          FOREIGN KEY(competency_id) REFERENCES competencies(id),
          FOREIGN KEY(updated_by) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_pdf_columns_competency ON schedule_pdf_column_releases(competency_id, service_date);
      `);
    }
  },
  {
    version: '008_two_positions_per_shift',
    apply() {
      const overloaded = db.prepare(`SELECT s.id FROM service_slots s
        LEFT JOIN assignments a ON a.service_slot_id=s.id AND a.status='CONFIRMED'
        GROUP BY s.id HAVING COUNT(a.id)>2 LIMIT 1`).get();
      if (overloaded) throw new Error(`O horário ${overloaded.id} possui mais de dois militares e precisa ser revisado.`);
      db.prepare('UPDATE service_slots SET minimum_required=2,normal_capacity=2,current_capacity=2,updated_at=?').run(now());
      const settings = db.prepare(`INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
      settings.run('default_minimum_required', '2', now());
      settings.run('default_normal_capacity', '2', now());
    }
  },
  {
    version: '009_column_rounds',
    apply() {
      db.prepare(`UPDATE service_slots SET minimum_required=2,normal_capacity=2,current_capacity=CASE
        WHEN EXISTS (SELECT 1 FROM schedule_pdf_column_releases r
          WHERE r.competency_id=service_slots.competency_id AND r.service_date=service_slots.service_date
            AND r.fourth_column_open=1) THEN 4
        WHEN EXISTS (SELECT 1 FROM schedule_pdf_column_releases r
          WHERE r.competency_id=service_slots.competency_id AND r.service_date=service_slots.service_date
            AND r.third_column_open=1) THEN 3
        ELSE 2 END,updated_at=?`).run(now());
      db.prepare(`INSERT OR IGNORE INTO system_settings (key,value,updated_at)
        VALUES ('bot_active_marking_column','2',?)`).run(now());
    }
  },
  {
    version: '010_member_monthly_hour_limit',
    apply() {
      const columns = db.prepare('PRAGMA table_info(members)').all();
      if (!columns.some((column) => column.name === 'monthly_hour_limit')) {
        db.exec('ALTER TABLE members ADD COLUMN monthly_hour_limit INTEGER');
      }
    }
  },
  {
    version: '011_member_hour_limit_exempt',
    apply() {
      const columns = db.prepare('PRAGMA table_info(members)').all();
      if (!columns.some((column) => column.name === 'hour_limit_exempt')) {
        db.exec('ALTER TABLE members ADD COLUMN hour_limit_exempt INTEGER NOT NULL DEFAULT 0');
      }
    }
  }
];

export function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version=?');
  const register = db.prepare('INSERT INTO schema_migrations (version,applied_at) VALUES (?,?)');
  let applied = 0;
  for (const migration of migrations) {
    if (alreadyApplied.get(migration.version)) continue;
    db.transaction(() => { migration.apply(); register.run(migration.version, now()); })();
    applied += 1;
  }
  return applied;
}
