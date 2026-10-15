import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const allowed=new Set(['utils/r2CostGuard.js','upload/index.js','file/[[path]].js','api/manage/sysConfig/upload.js']);
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const filename=path.join(dir,entry.name);if(entry.isDirectory())scan(filename);else if(entry.name.endsWith('.js')){const relative=path.relative(path.join(root,'functions'),filename).split(path.sep).join('/');const source=fs.readFileSync(filename,'utf8');if(source.includes('img_r2')&&!allowed.has(relative))throw new Error('New R2 reference requires review: '+relative);if(relative!=='utils/r2CostGuard.js'&&/img_r2\s*(?:\?\.)?\s*[.\[]/.test(source))throw new Error('Direct R2 call bypasses guard: '+relative);}}}
scan(path.join(root,'functions'));
const guard=fs.readFileSync(path.join(root,'functions/utils/r2CostGuard.js'),'utf8');
if(!guard.includes('getMeteredR2(env,binding)'))throw new Error('Usage metering hook missing');
if(!fs.existsSync(path.join(root,'functions/api/r2-usage/[[path]].js')))throw new Error('Usage API adapter missing');
if(fs.readFileSync(path.join(root,'frontend-dist/r2-usage.html'),'utf8')!==fs.readFileSync(path.join(root,'extensions/r2-usage/dashboard.html'),'utf8'))throw new Error('Usage dashboard needs installation');
console.log('R2 integration seams checked; upstream changes still require review.');
