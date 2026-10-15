import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const targets=[
 ['functions/upload/index.js','../utils/r2CostGuard.js'],
 ['functions/upload/chunkUpload.js','../utils/r2CostGuard.js'],
 ['functions/upload/chunkMerge.js','../utils/r2CostGuard.js'],
 ['functions/file/[[path]].js','../utils/r2CostGuard.js'],
 ['functions/api/manage/delete/[[path]].js','../../../utils/r2CostGuard.js'],
 ['functions/api/manage/move/[[path]].js','../../../utils/r2CostGuard.js'],
 ['functions/api/manage/rename/[[path]].js','../../../utils/r2CostGuard.js'],
];
// Reapply only the small, known adapter seams after an upstream merge.
for(const [relative,dependency] of targets){
 const filename=path.join(root,relative);let source=fs.readFileSync(filename,'utf8');
 source=source.replaceAll('const R2DataBase = env.img_r2;','const R2DataBase = getGuardedR2(env);');
 if(!source.includes('getGuardedR2(env)'))throw new Error('Upstream R2 entry changed: '+relative);
 if(!source.includes('import { getGuardedR2 }'))source=`import { getGuardedR2 } from '${dependency}';\n`+source;
 fs.writeFileSync(filename,source);
}
const guard=path.join(root,'functions/utils/r2CostGuard.js');let source=fs.readFileSync(guard,'utf8');
if(!source.includes('getMeteredR2(env,binding)'))throw new Error('Cost guard adapter missing; restore the fork extension before deploying');
fs.copyFileSync(path.join(root,'extensions/r2-usage/dashboard.html'),path.join(root,'frontend-dist/r2-usage.html'));
console.log('R2 usage extension adapters installed. Run check-integration.mjs and tests before deploying.');
