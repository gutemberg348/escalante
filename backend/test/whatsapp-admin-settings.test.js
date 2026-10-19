import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-admin-settings-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-admin-settings-test-secret';
process.env.ADMIN_EMAIL = 'test@example.com';
process.env.ADMIN_INITIAL_PASSWORD = 'isolated-test-password';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { default: routes } = await import('../src/modules/whatsapp/routes.js');
runMigrations();
const stamp = now();
db.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at,updated_at)
  VALUES (1,'Test','test@example.com','hash','ADMIN',?,?)`).run(stamp, stamp);
db.prepare(`INSERT INTO members (id,rank,operational_name,unit_type,created_at,updated_at)
  VALUES (1,'Sgt','Test','CICC',?,?)`).run(stamp, stamp);
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' }; next(); });
app.use('/whatsapp', routes);
app.use((error, req, res, next) => res.status(error.name === 'ZodError' ? 400 : 500).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/whatsapp`;
async function save(body, role = 'ADMIN') {
  const response = await fetch(`${url}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const saved = () => db.prepare("SELECT value FROM system_settings WHERE key='whatsapp_admin_member_ids'").get()?.value;
beforeEach(() => db.prepare("DELETE FROM system_settings WHERE key='whatsapp_admin_member_ids'").run());
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) fs.rmSync(path.join(directory, name), { force: true });
  fs.rmdirSync(directory);
});
test('only a panel ADMIN can configure WhatsApp administrators', async () => {
  for (const role of ['SCHEDULER', 'VIEWER']) {
    assert.equal((await save({ adminMemberIds: [1] }, role)).status, 403);
    assert.equal(saved(), undefined);
  }
});
test('administrator selection persists, is returned by status and supports explicit revocation', async () => {
  const result = await save({ adminMemberIds: [1, 1] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.item.adminMemberIds, [1]);
  assert.equal(saved(), '[1]');
  assert.deepEqual((await (await fetch(`${url}/status`)).json()).item.adminMemberIds, [1]);
  await save({ targetNumber: '5583999999999' });
  assert.equal(saved(), '[1]', 'older clients must not erase permissions by omitting the field');
  await save({ adminMemberIds: [] });
  assert.equal(saved(), '[]');
});
test('invalid administrator IDs are rejected without partially changing permissions', async () => {
  await save({ adminMemberIds: [1] });
  for (const ids of [[9999], [0], ['1'], [1.5]]) {
    assert.equal((await save({ adminMemberIds: ids })).status, 400);
    assert.equal(saved(), '[1]');
  }
});
