// R2保护扩展：实际 SDK 尝试计量层，对应 usage_local；不是额度预留账本。
// 先持久化 attempts，成功后才调用远端；结果记录失败也不能退款或假定未发生。
import { classify, dayOf, bucketName, database } from './core.js';

// Runs immediately before an actual SDK method, after the existing quota guard.
// No image keys, request URLs, IP addresses or credentials are persisted.
export function getMeteredR2(env, raw) {
    if (!env.R2_USAGE_ENABLED) return raw; // explicit activation after schema deployment
    if (env.R2_USAGE_ENABLED !== '1') throw new Error('Invalid R2 usage activation flag');
    const db = database(env);
    const bucket = bucketName(env);
    async function call(action, invoke) {
        const now = Date.now(), day = dayOf(now);
        const result = await db.prepare(`INSERT INTO usage_local(day,bucket,action,class,attempts,first_at,last_at)
          VALUES(?,?,?,?,1,?,?) ON CONFLICT(day,bucket,action) DO UPDATE SET
          attempts=attempts+1,last_at=MAX(last_at,excluded.last_at)`).bind(day,bucket,action,classify(action),now,now).run();
        if (!result.success) throw new Error('R2 usage ledger unavailable; operation blocked');
        let value;
        try { value = await invoke(); }
        catch (error) {
            // A persisted attempt remains even if recording the outcome fails.
            await finish('failed').catch(()=>{});
            throw error;
        }
        await finish('completed');
        return value;
        async function finish(column) {
            const outcome = await db.prepare(`UPDATE usage_local SET ${column}=${column}+1 WHERE day=? AND bucket=? AND action=?`).bind(day,bucket,action).run();
            if (!outcome.success) throw new Error('R2 outcome recording failed; attempt retained');
        }
    }
    const wrapMultipart = handle => ({
        key:handle.key, uploadId:handle.uploadId,
        uploadPart:(...args)=>call('UploadPart',()=>handle.uploadPart(...args)),
        complete:(...args)=>call('CompleteMultipartUpload',()=>handle.complete(...args)),
        abort:(...args)=>call('AbortMultipartUpload',()=>handle.abort(...args)),
    });
    return {
        get:(...args)=>call('GetObject',()=>raw.get(...args)),
        head:(...args)=>call('HeadObject',()=>raw.head(...args)),
        put:(...args)=>call('PutObject',()=>raw.put(...args)),
        list:(...args)=>call('ListObjects',()=>raw.list(...args)),
        delete:(...args)=>call('DeleteObject',()=>raw.delete(...args)),
        createMultipartUpload:(...args)=>call('CreateMultipartUpload',()=>raw.createMultipartUpload(...args)).then(wrapMultipart),
        // Resuming a handle is local; it does not issue an R2 operation.
        resumeMultipartUpload:(...args)=>wrapMultipart(raw.resumeMultipartUpload(...args)),
    };
}
