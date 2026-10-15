import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { CloudflareR2 } from '../deploy/server/cloudflareR2.js';
import { parseAnalytics } from '../functions/utils/r2CostGuard.js';
describe('server private R2 adapter',()=>{
    function fixture(respond=async()=>({})){const calls=[];return {calls,bucket:new CloudflareR2({R2_ACCOUNT_ID:'test',R2_BUCKET:'private'},
        {async send(command){calls.push(command);return respond(command)}})};}
    it('retains keys and metadata and never performs a hidden HEAD or list',async()=>{
        const f=fixture(async()=>({ETag:'"etag"'}));
        await f.bucket.put('folder/original.png',new Blob(['abc']),{httpMetadata:{contentType:'image/png'},customMetadata:{a:'b'}});
        assert.equal(f.calls.length,1);assert.equal(f.calls[0].constructor.name,'PutObjectCommand');
        const input=f.calls[0].input;assert.equal(input.Key,'folder/original.png');assert.equal(input.Bucket,'private');
        assert.equal(input.ContentLength,3);assert.equal(input.ContentType,'image/png');assert.equal(input.StorageClass,'STANDARD');
    });
    it('streams partial reads while preserving full object size and metadata',async()=>{
        const f=fixture(async()=>({Body:Readable.from([Buffer.from('abc')]),ContentLength:3,ContentRange:'bytes 2-4/10',ContentType:'image/png',ETag:'"v1"'}));
        const object=await f.bucket.get('image',{range:{offset:2,length:3}});
        assert.equal(f.calls[0].input.Range,'bytes=2-4');assert.equal(object.size,10);
        assert.deepEqual(object.range,{offset:2,length:3});assert.equal(await new Response(object.body).text(),'abc');
        const headers=new Headers();object.writeHttpMetadata(headers);assert.equal(headers.get('ETag'),'"v1"');
    });
    it('distinguishes not found from permission and connection errors',async()=>{
        const missing=fixture(async()=>{throw {$metadata:{httpStatusCode:404}}});assert.equal(await missing.bucket.head('x'),null);
        const denied=fixture(async()=>{throw new Error('denied')});await assert.rejects(()=>denied.bucket.get('x'),/denied/);
    });
    it('resuming multipart is local; every part/completion/abort is one SDK call',async()=>{
        const f=fixture(async()=>({ETag:'"part"'}));const handle=f.bucket.resumeMultipartUpload('file','id');assert.equal(f.calls.length,0);
        const part=await handle.uploadPart(2,new Uint8Array(5));assert.equal(part.etag,'"part"');
        await handle.complete([part,{partNumber:1,etag:'"one"'}]);await handle.abort();
        assert.equal(f.calls.length,3);assert.deepEqual(f.calls[1].input.MultipartUpload.Parts.map(x=>x.PartNumber),[1,2]);
    });
    it('retains list cursors and catches partial deletion errors',async()=>{
        const f=fixture(async c=>c.constructor.name==='ListObjectsV2Command'?{Contents:[{Key:'k',Size:1}],IsTruncated:true,NextContinuationToken:'next'}:{Errors:[{Key:'k'}]});
        const result=await f.bucket.list({cursor:'old',prefix:'p'});assert.equal(result.cursor,'next');assert.equal(f.calls[0].input.ContinuationToken,'old');
        await assert.rejects(()=>f.bucket.delete(['k']),/incomplete/);
    });
    it('conservatively accounts for the documented Sippy configuration query',()=>{
        const result=parseAnalytics({data:{viewer:{accounts:[{operations:[{dimensions:{actionType:'GetBucketSippyConfiguration'},sum:{requests:3}}],
            storage:[{dimensions:{bucketName:'private',datetime:new Date().toISOString()},max:{payloadSize:5,metadataSize:1,uploadCount:0}}]}]}}});
        assert.deepEqual(result,{a:3,b:3,bytes:6});
    });
});
