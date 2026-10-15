import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { getGuardedR2, LIMITS, parseAnalytics, refreshAnalytics } from '../functions/utils/r2CostGuard.js';

function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(fs.readFileSync('database/migrations/r2_cost_guard.sql','utf8'));
    sqlite.exec('UPDATE r2_cost_guard SET observed_bytes=0,observed_a=0,observed_b=0');
    sqlite.prepare("UPDATE r2_cost_guard SET checked_at=?,error='' WHERE id=1").run(Date.now());
    const db = { prepare(sql) { return { bind(...args) { return {
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async run() { return { success:true,meta:sqlite.prepare(sql).run(...args) }; },
    }; }, async first() { return sqlite.prepare(sql).get() || null; } }; } };
    const calls = [];
    const handle = {key:'key',uploadId:'upload',async uploadPart(){calls.push('part');return {etag:'etag'};},async complete(){calls.push('complete');},async abort(){calls.push('abort');}};
    const raw = {
        async put(){calls.push('put');}, async get(){calls.push('get');return {size:3,body:new Response('abc').body};},
        async head(){calls.push('head');},async list(){calls.push('list');},async delete(){calls.push('delete');},
        async createMultipartUpload(){calls.push('create');return handle;},resumeMultipartUpload(){return handle;},
    };
    const env = {img_d1:db,img_r2:raw,CF_R2_ANALYTICS_TOKEN:'unit-test-only'};
    return {sqlite,env,calls,raw,bucket:getGuardedR2(env),row:()=>sqlite.prepare('SELECT * FROM r2_cost_guard').get()};
}
const analytics = () => ({data:{viewer:{accounts:[{operations:[{sum:{requests:2},dimensions:{actionType:'PutObject'}},{sum:{requests:3},dimensions:{actionType:'GetObject'}}],storage:[{max:{payloadSize:68,metadataSize:0,uploadCount:0},dimensions:{bucketName:'test',datetime:new Date().toISOString()}}]}]}}});

describe('R2 cost protection (real SQLite)',()=>{
    it('reserves before put and retains reservations after delete or failed put',async()=>{
        const f=fixture();await f.bucket.put('key',new Uint8Array(10));await f.bucket.delete('key');
        assert.equal(f.row().reserved_bytes,8202);assert.equal(f.row().reserved_a,2);
        f.raw.put=async()=>{throw new Error('storage failed');};
        await assert.rejects(()=>f.bucket.put('key',new Uint8Array(10)),/storage failed/);
        assert.equal(f.row().reserved_bytes,16404);
    });
    it('atomically rejects competing uploads crossing 8 decimal GB',async()=>{
        const f=fixture();f.sqlite.prepare('UPDATE r2_cost_guard SET reserved_bytes=?').run(LIMITS.bytes-9000);
        const results=await Promise.allSettled(Array.from({length:20},()=>f.bucket.put('key',new Uint8Array(100))));
        assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.length,1);
        assert.ok(f.row().reserved_bytes<LIMITS.bytes);
    });
    it('stops reads, writes and deletes if any quota reaches its limit',async()=>{
        for(const column of ['reserved_a','reserved_b','reserved_bytes']){
            const f=fixture();const max={reserved_a:LIMITS.a,reserved_b:LIMITS.b,reserved_bytes:LIMITS.bytes}[column];
            f.sqlite.prepare(`UPDATE r2_cost_guard SET ${column}=?`).run(max);
            for(const invoke of [()=>f.bucket.get('x'),()=>f.bucket.put('x','a'),()=>f.bucket.delete('x')]) await assert.rejects(invoke,/R2/);
            assert.deepEqual(f.calls,[]);
        }
    });
    it('includes account usage and fails closed on missing/corrupt schema or database errors',async()=>{
        const f=fixture();f.sqlite.prepare('UPDATE r2_cost_guard SET observed_b=?').run(LIMITS.b-1);
        await assert.rejects(()=>f.bucket.get('x'),/R2/);assert.deepEqual(f.calls,[]);
        f.sqlite.exec('DROP TABLE r2_cost_guard');await assert.rejects(()=>f.bucket.get('x'),/R2/);
        const g=fixture();delete g.env.CF_R2_ANALYTICS_TOKEN;await assert.rejects(()=>g.bucket.put('x','a'),/R2/);assert.deepEqual(g.calls,[]);
    });
    it('blocks unknown streams/methods and accounts for copied R2 body streams',async()=>{
        const f=fixture();await assert.rejects(()=>f.bucket.put('x',new Response('abc').body),/大小/);
        assert.throws(()=>f.bucket.unprotectedOperation,/未受保护/);
        const object=await f.bucket.get('x');await f.bucket.put('copy',object.body);
        assert.equal(f.row().reserved_bytes,8195);assert.equal(f.row().reserved_b,1);
    });
    it('guards every multipart operation, including resumed sessions and retries',async()=>{
        const f=fixture();const h=await f.bucket.createMultipartUpload('key');
        await h.uploadPart(1,new Uint8Array(5));await h.uploadPart(1,new Uint8Array(5));await h.complete([]);
        await f.bucket.resumeMultipartUpload('key','upload').abort();
        assert.equal(f.row().reserved_a,5);assert.equal(f.row().reserved_bytes,24596);
        f.sqlite.prepare('UPDATE r2_cost_guard SET reserved_a=?').run(LIMITS.a);
        await assert.rejects(()=>h.uploadPart(2,new Uint8Array(1)),/R2/);assert.equal(f.calls.length,5);
    });
    it('rejects malformed, unknown, incomplete or stale Cloudflare analytics',()=>{
        assert.deepEqual(parseAnalytics(analytics()),{bytes:68,a:2,b:3});
        for(const change of [d=>d.errors=[{}],d=>d.data.viewer.accounts=[],d=>d.data.viewer.accounts[0].operations[0].sum.requests=-1,d=>d.data.viewer.accounts[0].operations[0].dimensions.actionType='unknown',d=>d.data.viewer.accounts[0].storage[0].max.uploadCount=1,d=>d.data.viewer.accounts[0].storage[0].dimensions.datetime='2020-01-01']){
            const d=analytics();change(d);assert.throws(()=>parseAnalytics(d),/R2/);
        }
    });
    it('failed analytics locks access and does not use a previous good sample',async()=>{
        const f=fixture();const original=globalThis.fetch;
        globalThis.fetch=async()=>new Response('{}',{status:503});
        try{await assert.rejects(()=>refreshAnalytics(f.env),/失败/);await assert.rejects(()=>f.bucket.get('x'),/R2/);assert.equal(f.row().checked_at,0);assert.deepEqual(f.calls,[]);}
        finally{globalThis.fetch=original;}
    });
    it('refreshes analytics without resetting reservations or high-water marks',async()=>{
        const f=fixture();await f.bucket.put('x','abc');
        f.sqlite.prepare('UPDATE r2_cost_guard SET observed_bytes=100').run();
        const original=globalThis.fetch;globalThis.fetch=async()=>Response.json(analytics());
        try{await refreshAnalytics(f.env);assert.equal(f.row().reserved_bytes,8195);assert.equal(f.row().observed_bytes,100);assert.equal(f.row().observed_a,2);}
        finally{globalThis.fetch=original;}
    });
    it('all production R2 call sites use the guarded accessor',()=>{
        for(const path of ['functions/upload/index.js','functions/upload/chunkUpload.js','functions/upload/chunkMerge.js','functions/file/[[path]].js','functions/api/manage/delete/[[path]].js','functions/api/manage/move/[[path]].js','functions/api/manage/rename/[[path]].js']){
            const source=fs.readFileSync(path,'utf8');assert.ok(source.includes('getGuardedR2(env)'));assert.ok(!source.includes('const R2DataBase = env.img_r2'));
        }
    });
});
