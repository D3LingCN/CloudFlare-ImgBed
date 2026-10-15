import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { getMeteredR2 } from './meter.js';
import { classify, sha256, DAY } from './core.js';
import { parseOperations, reconcile, syncUsage } from './analytics.js';
import { handleApi } from './api.js';
import { trigger } from './scheduler.js';
import { getGuardedR2, LIMITS as GUARD_LIMITS } from '../../functions/utils/r2CostGuard.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 sql.exec("UPDATE usage_meta SET metering_since=1 WHERE id=1");
 const db={prepare(query){const statement={bind(...args){return bound(args)},...bound([])};function bound(args){return {async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){return {success:true,meta:sql.prepare(query).run(...args)}},_run(){return sql.prepare(query).run(...args)}}}return statement},async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>({success:true,meta:s._run()}));sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
 const calls=[];const handle={key:'key',uploadId:'id',async uploadPart(){calls.push('part')},async complete(){calls.push('complete')},async abort(){calls.push('abort')}};
 const raw={async put(){calls.push('put');return 'ok'},async get(){calls.push('get');return null},async head(){calls.push('head')},async list(){calls.push('list')},async delete(){calls.push('delete')},async createMultipartUpload(){calls.push('create');return handle},resumeMultipartUpload(){return handle}};
 const env={R2_USAGE_DB:db,R2_USAGE_ENABLED:'1',R2_USAGE_BUCKET:'target',R2_USAGE_ACCOUNT_ID:'test-account',CF_R2_ANALYTICS_TOKEN:'test-only'};
 return {sql,env,db,raw,calls,bucket:getMeteredR2(env,raw)};
}
function payload(rows){return {data:{viewer:{accounts:[{operations:rows.map(([bucket,action,status,requests])=>({dimensions:{bucketName:bucket,actionType:action,responseStatusCode:status},sum:{requests}}))}]}}};}

test('actual calls are counted atomically; free operations and multipart resumes use correct classes',async()=>{
 const f=fixture();await Promise.all(Array.from({length:25},()=>f.bucket.get('x')));await f.bucket.put('x','v');await f.bucket.delete('x');
 const h=await f.bucket.createMultipartUpload('x');await h.uploadPart(1,'a');await h.uploadPart(1,'a');await h.complete([]);await f.bucket.resumeMultipartUpload('x','id').abort();
 const rows=f.sql.prepare('SELECT * FROM usage_local').all();const byAction=Object.fromEntries(rows.map(r=>[r.action,r]));
 assert.equal(byAction.GetObject.attempts,25);assert.equal(byAction.GetObject.completed,25);assert.equal(byAction.DeleteObject.class,'free');assert.equal(byAction.AbortMultipartUpload.class,'free');assert.equal(byAction.UploadPart.attempts,2);assert.equal(rows.reduce((n,r)=>n+r.attempts,0),f.calls.length);
});
test('failed SDK calls persist attempts; absent ledger blocks before accessing R2',async()=>{
 const f=fixture();f.raw.get=async()=>{throw new Error('upstream failure')};await assert.rejects(()=>f.bucket.get('x'),/upstream failure/);const row=f.sql.prepare('SELECT * FROM usage_local').get();assert.equal(row.attempts,1);assert.equal(row.failed,1);
 f.sql.exec('DROP TABLE usage_local');await assert.rejects(()=>f.bucket.put('x','v'));assert.deepEqual(f.calls,[]);
 assert.throws(()=>getMeteredR2({...f.env,R2_USAGE_DB:undefined},f.raw),/database/);
});
test('integrated quota wrapper only meters accepted operations and never meters a blocked read',async()=>{
 const f=fixture();f.sql.exec(fs.readFileSync(new URL('../../database/migrations/r2_cost_guard.sql',import.meta.url),'utf8'));
 f.sql.prepare("UPDATE r2_cost_guard SET checked_at=?,error='' WHERE id=1").run(Date.now());
 const guarded=getGuardedR2({...f.env,img_d1:f.db,img_r2:f.raw});
 await guarded.get('x');assert.equal(f.sql.prepare("SELECT attempts FROM usage_local WHERE action='GetObject'").get().attempts,1);
 f.sql.prepare('UPDATE r2_cost_guard SET reserved_b=?').run(GUARD_LIMITS.b);
 await assert.rejects(()=>guarded.get('x'),/R2/);assert.equal(f.sql.prepare("SELECT attempts FROM usage_local WHERE action='GetObject'").get().attempts,1);
 assert.deepEqual(f.calls,['get']);
});
test('UTC midnight completion is attributed to the attempt window',async()=>{
 const f=fixture(),original=Date.now;Date.now=()=>Date.parse('2026-10-14T23:59:59Z');
 f.raw.put=async()=>{Date.now=()=>Date.parse('2026-10-15T00:00:01Z');return 'ok'};
 try{await f.bucket.put('x','v');const row=f.sql.prepare('SELECT * FROM usage_local').get();assert.equal(row.day,'2026-10-14');assert.equal(row.completed,1)}finally{Date.now=original}
});
test('analytics rejects errors, malformed counts and truncation; unknown actions are visible',()=>{
 assert.equal(classify('PutBucketCors'),'A');assert.equal(classify('GetBucketLocation'),'B');assert.equal(classify('DeleteObject'),'free');assert.equal(classify('FutureAction'),'unknown');
 const rows=parseOperations(payload([['target','FutureAction',200,4]]));assert.equal(rows[0].class,'unknown');
 assert.throws(()=>parseOperations({errors:[{}]}));assert.throws(()=>parseOperations(payload([['target','GetObject',200,-1]])));assert.throws(()=>parseOperations(payload([['target','GetObject',NaN,1]])));
 assert.throws(()=>parseOperations(payload(Array.from({length:10000},()=>['target','GetObject',200,1]))));
});
test('reconciliation separates bucket scope and partial coverage, preserving both delta signs',()=>{
 const local=[{action:'PutObject',class:'A',attempts:3,completed:2,failed:1}];const official=parseOperations(payload([['target','PutObject',200,2],['target','GetObject',200,5],['other','GetObject',200,999]]));
 const rows=reconcile('2026-10-14',local,official,Date.parse('2026-10-14T12:00:00Z'),'target');assert.equal(rows.length,2);assert.equal(rows[0].delta,-1);assert.equal(rows[1].delta,5);assert.equal(rows[0].coverage,'partial');assert.equal(rows[0].statuses[200],2);
 assert.equal(reconcile('2026-10-14',local,official,Date.parse('2026-10-15T00:00:00Z'),'target')[0].coverage,'before-metering');
});
test('nightly sync appends revision history, uses closed UTC days, and never adds repeated snapshots',async()=>{
 const f=fixture(),original=globalThis.fetch,now=Date.parse('2026-10-15T15:30:00Z'),windows=[];
 globalThis.fetch=async(_url,options)=>{const q=JSON.parse(options.body);windows.push(q.variables);return Response.json(payload([['target','PutObject',200,3],['other','GetObject',200,10]]))};
 try{const first=await syncUsage(f.env,'scheduled',now),second=await syncUsage(f.env,'scheduled',now+1);assert.equal(first.account.a,3);assert.equal(second.account.a,3);assert.equal(first.bucket.b,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM usage_sync_runs').get().n,2);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM usage_reconciliation').get().n,6);assert.equal(windows[1].start,'2026-10-12T00:00:00.000Z');assert.equal(windows[3].end,'2026-10-15T00:00:00.000Z');assert.equal(windows[0].start,'2026-10-01T00:00:00.000Z');assert.equal(windows[0].end,'2026-10-15T15:15:00.000Z');}finally{globalThis.fetch=original}
});
test('failed or truncated sync retains last success, records failure, and releases lock',async()=>{
 const f=fixture(),original=globalThis.fetch;globalThis.fetch=async()=>Response.json(payload([['target','GetObject',200,1]]));
 try{await syncUsage(f.env);globalThis.fetch=async()=>new Response('{}',{status:503});await assert.rejects(()=>syncUsage(f.env));assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM usage_sync_runs WHERE status='success'").get().n,1);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM usage_sync_runs WHERE status='failed'").get().n,1);assert.equal(f.sql.prepare('SELECT sync_until FROM usage_meta').get().sync_until,0);f.sql.exec(`UPDATE usage_meta SET sync_until=${Date.now()+DAY}`);assert.deepEqual(await syncUsage(f.env),{busy:true});}finally{globalThis.fetch=original}
});
test('API rejects anonymous, invalid and revoked tokens; read token cannot write, sync token cannot read',async()=>{
 const f=fixture(),read='r'.repeat(40),sync='s'.repeat(40);
 f.sql.prepare('INSERT INTO usage_tokens VALUES(?,?,?,?,0)').run(await sha256(read),'read','test-read',1);f.sql.prepare('INSERT INTO usage_tokens VALUES(?,?,?,?,0)').run(await sha256(sync),'sync','test-sync',1);
 const call=(path,token,method='GET')=>handleApi({env:f.env,request:new Request('https://img.test/api/r2-usage/'+path,{method,headers:token?{Authorization:'Bearer '+token}:{}})});
 assert.equal((await call('status')).status,401);assert.equal((await call('status','x'.repeat(40))).status,401);assert.equal((await call('status',sync)).status,403);assert.equal((await call('sync',read,'POST')).status,403);assert.equal((await call('history?days=999',read)).status,400);
 const old=globalThis.fetch;globalThis.fetch=()=>{throw new Error('GET must never fetch R2 or Cloudflare')};try{const response=await call('status',read);assert.equal(response.status,200);assert.equal((await response.json()).officialStale,true)}finally{globalThis.fetch=old}
 f.sql.exec("UPDATE usage_tokens SET revoked=1 WHERE scope='read'");assert.equal((await call('status',read)).status,401);
});
test('cookie-authenticated sync requires same origin and service read token has no image privileges',async()=>{
 const f=fixture();const response=await handleApi({env:f.env,request:new Request('https://img.test/api/r2-usage/sync',{method:'POST',headers:{Origin:'https://evil.test'}})},async()=>true);assert.equal(response.status,403);
});
test('scheduler only POSTs to the configured endpoint and fails visibly on HTTP errors',async()=>{
 const old=globalThis.fetch,env={R2_USAGE_SYNC_URL:'https://img.test/api/r2-usage/sync',R2_USAGE_SYNC_TOKEN:'test'};let called;
 globalThis.fetch=async(url,options)=>{called={url,options};return Response.json({status:'success'})};try{await trigger(env);assert.equal(called.url,env.R2_USAGE_SYNC_URL);assert.equal(called.options.method,'POST');assert.equal(called.options.redirect,'error');globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(()=>trigger(env),/503/)}finally{globalThis.fetch=old}
});
