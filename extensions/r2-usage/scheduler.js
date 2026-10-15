// This Worker has no access to R2, D1, admin credentials or the analytics token.
// Its single narrow credential can only invoke the synchronization endpoint.
export default {
    async scheduled(event,env,context) {
        context.waitUntil(trigger(env));
    },
    fetch() { return new Response('Scheduled R2 usage synchronizer',{status:404}); },
};
export async function trigger(env) {
    if (!env.R2_USAGE_SYNC_TOKEN || !env.R2_USAGE_SYNC_URL) throw new Error('Synchronization configuration missing');
    const response=await fetch(env.R2_USAGE_SYNC_URL,{method:'POST',headers:{Authorization:`Bearer ${env.R2_USAGE_SYNC_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(90000)});
    if(!response.ok) throw new Error(`R2 usage synchronization HTTP ${response.status}`);
    const result=await response.json();
    if(result.status!=='success') throw new Error('R2 usage synchronization did not succeed');
}
