import { VERSION, LIMITS, FREE_TIER, dayOf, monthOf, bucketName, database, sha256 } from './core.js';
import { syncUsage } from './analytics.js';

const headers = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*'};
function json(body,status=200) { return Response.json(body,{status,headers}); }
async function scopeOf(request,db,authorizeAdmin) {
    const header=request.headers.get('Authorization');
    if (header) {
        const match=/^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
        if (!match) return null;
        const row=await db.prepare('SELECT scope FROM usage_tokens WHERE hash=? AND revoked=0').bind(await sha256(match[1])).first();
        return row?.scope || null;
    }
    return await authorizeAdmin() ? 'admin' : null;
}
function runView(row) {
    if (!row) return null;
    return {id:row.id,source:row.source,status:row.status,startedAt:new Date(row.started_at).toISOString(),
        completedAt:row.completed_at?new Date(row.completed_at).toISOString():null,
        cutoff:new Date(row.cutoff).toISOString(),month:row.month,error:row.error,
        account:row.account_json?JSON.parse(row.account_json):null,bucket:row.bucket_json?JSON.parse(row.bucket_json):null};
}
export async function handleApi(context,authorizeAdmin=async()=>false,readGuard=async()=>null) {
    const {request,env}=context, url=new URL(request.url);
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'86400'}});
    try {
        const db=database(env), scope=await scopeOf(request,db,authorizeAdmin);
        if (!scope) return json({error:'Authentication required'},401);
        const route=url.pathname.replace(/\/+$/,'').split('/').at(-1);
        if (route==='sync') {
            if (request.method!=='POST') return json({error:'Use POST'},405);
            if (!['admin','sync'].includes(scope)) return json({error:'Read-only token cannot synchronize'},403);
            if (scope==='admin' && request.headers.get('Origin')!==url.origin) return json({error:'Same-origin request required'},403);
            const result=await syncUsage(env,scope==='sync'?'scheduled':'manual');
            return json(result,result.busy?409:200);
        }
        if (request.method!=='GET') return json({error:'Use GET'},405);
        if (!['read','admin'].includes(scope)) return json({error:'Sync token cannot read statistics'},403);
        if (route==='status') {
            const now=Date.now(), month=monthOf(now), bucket=bucketName(env);
            const [local,meta,last,lastSuccess,guard]=await Promise.all([
                db.prepare(`SELECT class,SUM(attempts) AS attempts,SUM(completed) AS completed,SUM(failed) AS failed
                  FROM usage_local WHERE day>=? AND day<? AND bucket=? GROUP BY class`).bind(month+'-01',dayOf(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)),bucket).all(),
                db.prepare('SELECT metering_since FROM usage_meta WHERE id=1').first(),
                db.prepare('SELECT * FROM usage_sync_runs ORDER BY started_at DESC LIMIT 1').first(),
                db.prepare("SELECT * FROM usage_sync_runs WHERE status='success' ORDER BY started_at DESC LIMIT 1").first(),
                readGuard(),
            ]);
            const counters={a:{attempts:0,completed:0,failed:0},b:{attempts:0,completed:0,failed:0},free:{attempts:0,completed:0,failed:0},unknown:{attempts:0,completed:0,failed:0}};
            for(const row of local.results) {
                const key=row.class==='A'?'a':row.class==='B'?'b':row.class;
                counters[key]={attempts:row.attempts,completed:row.completed,failed:row.failed};
            }
            for(const value of Object.values(counters)) value.pending=value.attempts-value.completed-value.failed;
            const observed=runView(lastSuccess);
            return json({version:VERSION,generatedAt:new Date(now).toISOString(),bucket,month,periodTimezone:'UTC',
                meteringSince:meta?.metering_since?new Date(meta.metering_since).toISOString():null,
                limits:LIMITS,freeTier:FREE_TIER,local:counters,official:observed,
                officialStale:!lastSuccess||now-lastSuccess.started_at>36*3600000||lastSuccess.month!==month,
                lastSync:runView(last),schedule:{timezone:'Asia/Shanghai',time:'23:30',closedDaysRechecked:3},
                protection:guard?{blocked:guard.blocked,remaining:guard.remaining,reserved:{a:guard.state?.reserved_a,b:guard.state?.reserved_b,bytes:guard.state?.reserved_bytes},observed:{a:guard.state?.observed_a,b:guard.state?.observed_b,bytes:guard.state?.observed_bytes},policy:guard.policy}:null,
                notes:['Local counts are SDK attempts, not page views or quota reservations.','Official counts are delayed Cloudflare analytics, not a billing statement.','Daily differences use identical closed UTC windows; positive delta means official minus local.','Historical/partial coverage and delayed analytics can produce differences.','Reporting never resets or lowers the independent protection ledger.']});
        }
        if(route==='history') {
            const days=Number(url.searchParams.get('days')||30);
            if(!Number.isInteger(days)||days<1||days>90) return json({error:'days must be 1..90'},400);
            const rows=await db.prepare(`SELECT day,action,class,attempts,completed,failed FROM usage_local
              WHERE day>=? AND bucket=? ORDER BY day DESC,action LIMIT 2000`).bind(dayOf(Date.now()-(days-1)*86400000),bucketName(env)).all();
            return json({timezone:'UTC',rows:rows.results});
        }
        if(route==='sync-runs') {
            const before=Number(url.searchParams.get('before')||Date.now()+1);
            if(!Number.isSafeInteger(before)||before<0) return json({error:'Invalid cursor'},400);
            const rows=(await db.prepare('SELECT * FROM usage_sync_runs WHERE started_at<? ORDER BY started_at DESC LIMIT 50').bind(before).all()).results;
            return json({rows:rows.map(runView),nextBefore:rows.length===50?rows.at(-1).started_at:null});
        }
        if(route==='reconciliation') {
            let id=url.searchParams.get('run');
            if(id && !/^[a-f0-9-]{36}$/.test(id)) return json({error:'Invalid run ID'},400);
            const run=id?await db.prepare('SELECT * FROM usage_sync_runs WHERE id=?').bind(id).first():await db.prepare("SELECT * FROM usage_sync_runs WHERE status='success' ORDER BY started_at DESC LIMIT 1").first();
            if(!run) return json({run:null,rows:[]});
            if(run.status!=='success') return json({run:runView(run),rows:[]});
            const rows=(await db.prepare('SELECT * FROM usage_reconciliation WHERE run_id=? ORDER BY day DESC,action').bind(run.id).all()).results;
            return json({run:runView(run),deltaDefinition:'officialRequests - localAttempts',rows:rows.map(row=>({day:row.day,bucket:row.bucket,action:row.action,class:row.class,localAttempts:row.local_attempts,localCompleted:row.local_completed,localFailed:row.local_failed,officialRequests:row.official_requests,delta:row.delta,coverage:row.coverage,statuses:JSON.parse(row.statuses_json)}))});
        }
        return json({error:'Not found'},404);
    } catch {
        return json({error:'Usage statistics unavailable; previous records are retained'},503);
    }
}
