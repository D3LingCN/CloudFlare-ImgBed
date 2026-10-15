import { validateSession } from '../utils/auth/sessionManager.js';
import { guardStatus } from '../utils/r2CostGuard.js';
import { handleApi } from '../../extensions/r2-usage/api.js';
export async function onRequest(context) {
    const headers = {'Cache-Control':'private, no-store'};
    if (context.request.method !== 'GET') return Response.json({error:'Method not allowed'},{status:405,headers});
    try {
        const admin = (await validateSession(context.env,context.request,'admin')).valid;
        const user = admin || (await validateSession(context.env,context.request,'user')).valid;
        if (!user) return Response.json({error:'Authentication required'},{status:401,headers});
        const url = new URL(context.request.url); url.pathname='/api/r2-usage/status';
        const request = new Request(url,{headers:context.request.headers});
        const response = await handleApi({...context,request},async()=>true,()=>guardStatus(context.env));
        if (!response.ok) throw new Error('Unavailable');
        const usage = await response.json();
        const guard = await guardStatus(context.env);
        const storageUsed = guard.state ? guard.state.reserved_bytes + guard.state.observed_bytes : null;
        return Response.json({month:usage.month,blocked:guard.blocked,limits:guard.limits,remaining:guard.remaining,
            storage:{used:storageUsed,total:10_000_000_000,remaining:guard.remaining?.bytes??null},
            local:{a:usage.local.a.attempts,b:usage.local.b.attempts},
            freeTier:usage.freeTier,updatedAt:usage.generatedAt,meteringSince:usage.meteringSince,
            officialStale:usage.officialStale}, {headers});
    } catch { return Response.json({blocked:true,error:'暂时无法获取用量'}, {status:503,headers}); }
}
