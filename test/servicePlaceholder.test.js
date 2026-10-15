import assert from 'node:assert/strict';
import { servicePlaceholder } from '../functions/utils/servicePlaceholder.js';
describe('public service placeholder',()=>{
    it('renders an image without leaking quota or internal failure details',async()=>{
        const response=servicePlaceholder(new Request('https://example.com/file/x.png'));
        const body=await response.text();
        assert.equal(response.status,200);
        assert.match(response.headers.get('Content-Type'),/^image\/svg\+xml/);
        assert.equal(response.headers.get('Cache-Control'),'no-store');
        assert.ok(Buffer.byteLength(body)<2000);
        assert.doesNotMatch(body,/R2|Analytics|额度|Token|500000/);
        assert.match(body,/服务维护中/);
    });
    it('only shows a valid operator-confirmed future time and supports HEAD',async()=>{
        const request=new Request('https://example.com/file/x.png');
        assert.match(await servicePlaceholder(request,{IMGBED_RESTORE_AT:'2099-02-01T00:00:00Z'}).text(),/预计/);
        for(const time of ['invalid','2000-01-01T00:00:00Z','<script>']) {
            assert.doesNotMatch(await servicePlaceholder(request,{IMGBED_RESTORE_AT:time}).text(),/预计|script/);
        }
        assert.equal(await servicePlaceholder(new Request(request,{method:'HEAD'})).text(),'');
    });
});
