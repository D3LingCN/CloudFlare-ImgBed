import { guardStatus, refreshAnalytics } from '../../utils/r2CostGuard.js';
export async function onRequest(context) {
    try {
        if (context.request.method === 'POST') await refreshAnalytics(context.env);
        else if (context.request.method !== 'GET') return new Response('Method not allowed',{status:405});
        return Response.json(await guardStatus(context.env),{headers:{'Cache-Control':'no-store'}});
    } catch {
        return Response.json({blocked:true,error:'R2 statistics unavailable; operations remain blocked'}, {status:503,headers:{'Cache-Control':'no-store'}});
    }
}
