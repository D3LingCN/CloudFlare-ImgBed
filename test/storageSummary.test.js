import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {onRequest} from '../functions/api/storage-summary.js';

function fixture() {
 const sql=new DatabaseSync(':memory:');
 sql.exec(fs.readFileSync('database/migrations/r2_cost_guard.sql','utf8'));
 sql.exec(fs.readFileSync('extensions/r2-usage/schema.sql','utf8'));
 sql.exec("UPDATE r2_cost_guard SET checked_at=0,error='',reserved_a=7,reserved_b=9,reserved_bytes=10000");
 const db={prepare(query){const statement=args=>({async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {success:true,meta:sql.prepare(query).run(...args)};}});return {...statement([]),bind(...args){return statement(args);}};}};
 const env={img_d1:db,R2_USAGE_DB:db,CF_R2_ANALYTICS_TOKEN:'fixture-only',img_url:{async get(){return JSON.stringify({authType:'admin',expiresAt:Date.now()+60000});}}};
 return {sql,env,context:{env,request:new Request('https://img.d3ling.cn/api/storage-summary',{headers:{Cookie:'admin_session=fixture'}})}};
}
const analytics=()=>({data:{viewer:{accounts:[{operations:[],storage:[{max:{payloadSize:68,metadataSize:0,uploadCount:0},dimensions:{bucketName:'test',datetime:new Date().toISOString()}}]}]}}});

describe('authenticated storage summary reconciliation',()=>{
 it('refreshes stale analytics once, preserves counters, and reports availability accurately',async()=>{
  const f=fixture(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(analytics());};
  try{const response=await onRequest(f.context);assert.equal(response.status,200);assert.equal((await response.json()).blocked,false);assert.equal(calls,1);assert.equal((await onRequest(f.context)).status,200);assert.equal(calls,1);const row=f.sql.prepare('select * from r2_cost_guard').get();assert.equal(row.reserved_a,7);assert.equal(row.reserved_b,9);assert.equal(row.reserved_bytes,10000);assert.equal(row.observed_bytes,1000000);}finally{globalThis.fetch=original;f.sql.close();}
 });
 it('fails closed on analytics errors and keeps reservations',async()=>{
  const f=fixture(),original=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:503});
  try{const response=await onRequest(f.context);assert.equal(response.status,503);assert.equal((await response.json()).blocked,true);const row=f.sql.prepare('select * from r2_cost_guard').get();assert.equal(row.checked_at,0);assert.equal(row.reserved_b,9);assert.equal(row.error,'Analytics unavailable');}finally{globalThis.fetch=original;f.sql.close();}
 });
 it('rejects anonymous queries before any analytics request',async()=>{
  const f=fixture(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected');};
  try{f.context.request=new Request('https://img.d3ling.cn/api/storage-summary');assert.equal((await onRequest(f.context)).status,401);assert.equal(calls,0);}finally{globalThis.fetch=original;f.sql.close();}
 });
});
