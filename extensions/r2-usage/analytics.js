// R2保护扩展：夜间月报与完整 UTC 日差异，写 usage_sync_runs / usage_reconciliation。
// 与费用保护的 5 分钟核对分开：此模块不清零、不降低、不解锁 r2_cost_guard。
import { DAY, classify, integer, dayOf, monthOf, totals, bucketName, database } from './core.js';

export function parseOperations(payload) {
    if (payload?.errors?.length) throw new Error('Analytics GraphQL error');
    const accounts = payload?.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error('Analytics account missing');
    const rows = accounts[0].operations;
    if (!Array.isArray(rows) || rows.length >= 10000) throw new Error('Analytics incomplete or truncated');
    return rows.map(row=>{
        const d = row.dimensions;
        if (!d || typeof d.actionType !== 'string' || typeof d.bucketName !== 'string') throw new Error('Invalid analytics dimensions');
        const status = Number(d.responseStatusCode);
        if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new Error('Invalid analytics status');
        return { bucket:d.bucketName, action:d.actionType, class:classify(d.actionType), status, requests:integer(row.sum?.requests) };
    });
}
async function fetchOperations(env,start,end) {
    if (!env.CF_R2_ANALYTICS_TOKEN || !env.R2_USAGE_ACCOUNT_ID) throw new Error('Analytics configuration missing');
    const query = `query Usage($account: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter:{accountTag:$account}) {
        operations:r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$start,datetime_lt:$end}) {
          sum { requests } dimensions { bucketName actionType responseStatusCode }
        }
      } }
    }`;
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql',{
        method:'POST',headers:{Authorization:`Bearer ${env.CF_R2_ANALYTICS_TOKEN}`,'Content-Type':'application/json'},
        body:JSON.stringify({query,variables:{account:env.R2_USAGE_ACCOUNT_ID,start:new Date(start).toISOString(),end:new Date(end).toISOString()}}),
        signal:AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Analytics HTTP error');
    return parseOperations(await response.json());
}
export function reconcile(day,local,official,meteringSince,bucket) {
    const map = new Map();
    for (const row of local) map.set(row.action,{...row,official_requests:0,statuses:{}});
    for (const row of official.filter(row=>row.bucket===bucket)) {
        let item = map.get(row.action);
        if (!item) { item={action:row.action,class:row.class,attempts:0,completed:0,failed:0,official_requests:0,statuses:{}}; map.set(row.action,item); }
        item.official_requests = integer(item.official_requests+row.requests);
        item.statuses[row.status] = integer((item.statuses[row.status]||0)+row.requests);
    }
    const start = Date.parse(day+'T00:00:00Z');
    const coverage = !meteringSince || meteringSince >= start+DAY ? 'before-metering' : meteringSince > start ? 'partial' : 'full';
    return [...map.values()].map(row=>({day,bucket,action:row.action,class:row.class,
        localAttempts:row.attempts,localCompleted:row.completed,localFailed:row.failed,
        officialRequests:row.official_requests,delta:row.official_requests-row.attempts,coverage,statuses:row.statuses}));
}
export async function syncUsage(env,source='manual',now=Date.now()) {
    const db=database(env), id=crypto.randomUUID(), lease=now+120000;
    const acquired=await db.prepare('UPDATE usage_meta SET sync_until=? WHERE id=1 AND sync_until<? RETURNING metering_since').bind(lease,now).first();
    if (!acquired) return {busy:true};
    const cutoff=now-15*60000, month=monthOf(cutoff);
    try {
        await db.prepare("INSERT INTO usage_sync_runs(id,source,started_at,cutoff,status,month) VALUES(?,?,?,?,'running',?)").bind(id,source,now,cutoff,month).run();
        const monthStart=Date.parse(month+'-01T00:00:00Z');
        const monthly=await fetchOperations(env,monthStart,cutoff);
        const account=totals(monthly), bucket=totals(monthly.filter(row=>row.bucket===bucketName(env)));
        const statements=[];
        // Closed UTC days only. Repeat the last three days to capture delayed metrics.
        const closedEnd=Date.parse(dayOf(cutoff)+'T00:00:00Z');
        for (let offset=3;offset>=1;offset--) {
            const start=closedEnd-offset*DAY, day=dayOf(start);
            const official=await fetchOperations(env,start,start+DAY);
            const local=(await db.prepare('SELECT * FROM usage_local WHERE day=? AND bucket=?').bind(day,bucketName(env)).all()).results;
            for (const row of reconcile(day,local,official,acquired.metering_since,bucketName(env))) {
                statements.push(db.prepare(`INSERT INTO usage_reconciliation(run_id,day,bucket,action,class,local_attempts,local_completed,local_failed,official_requests,delta,coverage,statuses_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,row.day,row.bucket,row.action,row.class,row.localAttempts,row.localCompleted,row.localFailed,row.officialRequests,row.delta,row.coverage,JSON.stringify(row.statuses)));
            }
        }
        // D1 batch is transactional; no partially successful reconciliation is exposed.
        statements.push(db.prepare("UPDATE usage_sync_runs SET completed_at=?,status='success',account_json=?,bucket_json=? WHERE id=?").bind(Date.now(),JSON.stringify(account),JSON.stringify(bucket),id));
        await db.batch(statements);
        return {id,status:'success',cutoff:new Date(cutoff).toISOString(),account,bucket};
    } catch {
        await db.prepare("UPDATE usage_sync_runs SET completed_at=?,status='failed',error='Cloudflare analytics or reconciliation unavailable' WHERE id=?").bind(Date.now(),id).run();
        throw new Error('R2 usage synchronization failed; previous snapshots retained');
    } finally {
        await db.prepare('UPDATE usage_meta SET sync_until=0 WHERE id=1 AND sync_until=?').bind(lease).run();
    }
}
