import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-observation-'));
process.env.DATABASE_PATH = path.join(directory,'test.sqlite');
process.env.NODE_ENV = 'test';
const { db, now } = await import('../src/database/index.js');
const { runMigrations } = await import('../src/database/migrations.js');
const { ensureCompetencySchedule } = await import('../src/scheduling/monthly.js');
const { default: routes } = await import('../src/modules/service-slots/routes.js');
runMigrations();
const stamp=now();
db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES (1,'Teste','observation@example.com','hash','ADMIN',?,?)").run(stamp,stamp);
for(const [id,name] of [[1,'Fragoso'],[2,'Jansen']]) db.prepare("INSERT INTO members(id,rank,operational_name,unit_type,created_at,updated_at) VALUES (?,'Sgt',?,'CICC',?,?)").run(id,name,stamp,stamp);
const { competency }=ensureCompetencySchedule('2031-11-01');
db.prepare('UPDATE competencies SET generated_at=? WHERE id=?').run(stamp,competency.id);
const slots=db.prepare('SELECT * FROM service_slots WHERE competency_id=? ORDER BY service_date,period').all(competency.id);
const app=express();app.use(express.json());
app.use((req,res,next)=>{req.user={id:1,role:req.headers['x-test-role']||'ADMIN'};next();});
app.use('/slots',routes);
app.use((error,req,res,next)=>res.status(error.name==='ZodError'?400:500).json({message:error.message}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const url=`http://127.0.0.1:${server.address().port}/slots`;
const getAssignment=()=>db.prepare('SELECT * FROM assignments WHERE id=1').get();
const getOther=()=>db.prepare('SELECT * FROM assignments WHERE id=2').get();
const request=async(body,role='ADMIN',id=1)=>{
  const r=await fetch(`${url}/assignments/${id}/observation`,{method:'PATCH',headers:{'Content-Type':'application/json','x-test-role':role},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
};
beforeEach(()=>{
  db.exec("DELETE FROM assignments; DELETE FROM audit_logs; UPDATE service_slots SET status='OPEN',homologated_at=NULL;");
  for(const [id,type]of[[1,'ORDINARY'],[2,'EXTRAORDINARY']]) db.prepare(`INSERT INTO assignments(id,service_slot_id,position_number,member_id,service_type,status,protocol,confirmed_at,created_at,updated_at)
    VALUES (?,?,1,?,?,'CONFIRMED',?,?,?,?)`).run(id,slots[id-1].id,id,type,`observation-${id}`,stamp,stamp,stamp);
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();for(const file of ['test.sqlite','test.sqlite-wal','test.sqlite-shm'])fs.rmSync(path.join(directory,file),{force:true});fs.rmdirSync(directory);});

for(const [id,type]of[[1,'ORDINARY'],[2,'EXTRAORDINARY']]) test(`observations preserve all assignment data for ${type}`,async()=>{
  const before=db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
  const other=db.prepare('SELECT * FROM assignments WHERE id<>?').all(id);
  const r=await request({displayPrefix:'Sgt Pedro Neto',expectedUpdatedAt:before.updated_at},'ADMIN',id);
  assert.equal(r.status,200);
  assert.deepEqual({...r.data.item,display_prefix:before.display_prefix,updated_at:before.updated_at},before);
  assert.equal(r.data.item.display_prefix,'Sgt Pedro Neto');
  assert.notEqual(r.data.item.updated_at,before.updated_at);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE id<>?').all(id),other);
  const audit=db.prepare("SELECT * FROM audit_logs WHERE action='MANUAL_ASSIGNMENT_OBSERVATION'").get();
  assert.equal(JSON.parse(audit.before_json).display_prefix,null);
  assert.equal(JSON.parse(audit.after_json).display_prefix,'Sgt Pedro Neto');
});
test('admins and schedulers can edit, replace and clear arbitrary annotations',async()=>{
  for(const [role,text,expected]of[['SCHEDULER',' ATESTADO ','ATESTADO'],['ADMIN','DISPENSADO','DISPENSADO'],['ADMIN',null,null],['ADMIN','Outra observação','Outra observação'],['ADMIN','   ',null]]){
    const r=await request({displayPrefix:text,expectedUpdatedAt:getAssignment().updated_at},role);
    assert.equal(r.status,200);assert.equal(getAssignment().display_prefix,expected);
  }
});
test('read-only profiles cannot edit an annotation',async()=>{
  const before=getAssignment();
  for(const role of ['SYSTEM_OPERATOR','APPROVING_AUTHORITY']) assert.equal((await request({displayPrefix:'ATESTADO',expectedUpdatedAt:stamp},role)).status,403);
  assert.deepEqual(getAssignment(),before);
});
test('closed, homologated, cancelled and missing assignments reject edits',async()=>{
  const body={displayPrefix:'ATESTADO',expectedUpdatedAt:stamp};
  db.prepare("UPDATE service_slots SET status='CLOSED' WHERE id=?").run(slots[0].id);
  assert.equal((await request(body)).status,409);
  db.prepare("UPDATE service_slots SET status='OPEN',homologated_at=? WHERE id=?").run(stamp,slots[0].id);
  assert.equal((await request(body)).status,409);
  db.prepare('UPDATE service_slots SET homologated_at=NULL WHERE id=?').run(slots[0].id);
  db.prepare("UPDATE assignments SET status='CANCELLED' WHERE id=1").run();
  assert.equal((await request(body)).status,404);
  assert.equal((await request(body,'ADMIN',99999)).status,404);
  assert.equal(getAssignment().display_prefix,null);
});
test('stale versions cannot overwrite a later observation or member change',async()=>{
  const before=getAssignment();
  assert.equal((await request({displayPrefix:'ATESTADO',expectedUpdatedAt:before.updated_at})).status,200);
  const newer=getAssignment();
  assert.equal((await request({displayPrefix:'Sgt Jansen',expectedUpdatedAt:before.updated_at})).status,409);
  assert.deepEqual(getAssignment(),newer);
});
test('invalid notes or unrelated fields write nothing',async()=>{
  const before=getAssignment();
  for(const body of [{displayPrefix:'a'.repeat(161),expectedUpdatedAt:stamp},{displayPrefix:'(ATESTADO)',expectedUpdatedAt:stamp},{displayPrefix:'duas\nlinhas',expectedUpdatedAt:stamp},
    {displayPrefix:'texto\u0000invisível',expectedUpdatedAt:stamp},{displayPrefix:'ATESTADO'},{displayPrefix:'ATESTADO',expectedUpdatedAt:stamp,memberId:2}]){
    assert.equal((await request(body)).status,400);assert.deepEqual(getAssignment(),before);
  }
});
test('the panel, confirmation list and PDF read the same saved suffix',async()=>{
  await request({displayPrefix:'Sgt Jansen',expectedUpdatedAt:stamp});
  const managed=await fetch(`${url}/manage?competency_id=${competency.id}`).then(r=>r.json());
  const assignment=managed.items.flatMap(s=>s.assignments).find(a=>a.id===1);
  assert.equal(assignment.displayPrefix,'Sgt Jansen');assert.equal(assignment.updatedAt,getAssignment().updated_at);
  const confirmed=await fetch(`${url}/confirmations?competency_id=${competency.id}&service_date=2031-11-01`).then(r=>r.json());
  assert.equal(confirmed.items.find(a=>a.assignmentId===1).displayPrefix,'Sgt Jansen');
  const pdf=await fetch(`${url}/pdf?competency_id=${competency.id}`);
  assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
  assert.equal(getOther().display_prefix,null);
});
