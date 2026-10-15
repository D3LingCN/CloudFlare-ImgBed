import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';
describe('retired Cloudflare hosting',()=>{
    it('blocks every route without reaching storage or other handlers',async()=>{
        for(const path of ['/','/dashboard','/upload','/file/test.png','/api/r2-usage/status','/dav/test']) {
            let calls=0;
            const response=await onRequest({request:new Request('https://example.com'+path),env:{},next(){calls++;throw new Error('Must not run')}});
            assert.equal(response.status,503); assert.equal(calls,0);
            assert.equal(response.headers.get('Cache-Control'),'no-store');
        }
    });
    it('allows the explicitly configured server and returns no body for HEAD',async()=>{
        const response=await onRequest({env:{IMGBED_HOSTING_MODE:'server'},next:()=>new Response('server')});
        assert.equal(await response.text(),'server');
        assert.equal(await (await onRequest({env:{},request:new Request('https://example.com',{method:'HEAD'})})).text(),'');
    });
});
