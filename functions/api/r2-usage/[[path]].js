// Additive adapter: only the upstream admin-session verifier is reused.
import { handleApi } from '../../../extensions/r2-usage/api.js';
import { validateSession } from '../../utils/auth/sessionManager.js';
import { guardStatus } from '../../utils/r2CostGuard.js';
export function onRequest(context) {
    return handleApi(context,
        async()=>(await validateSession(context.env,context.request,'admin')).valid,
        ()=>guardStatus(context.env));
}
