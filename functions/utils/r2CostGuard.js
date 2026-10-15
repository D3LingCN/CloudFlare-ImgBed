// Account-wide analytics is a delayed cross-check, never the request-time ledger.
// Reservations are atomic, durable, conservative and NEVER automatically reset.
import { getMeteredR2 } from '../../extensions/r2-usage/meter.js';
export const LIMITS = Object.freeze({ bytes: 8_000_000_000, a: 500_000, b: 5_000_000 });
const REFRESH_MS = 5 * 60_000;
const ACCOUNT = 'aa3fac9ba450aac479a59bfbb8e6ab1c';
const wrappers = new WeakMap();
const knownStreams = new WeakMap();
const classA = new Set(['putobject','copyobject','completemultipartupload','createmultipartupload','uploadpart','uploadpartcopy','listbuckets','listobjects','listobjectsv2','listmultipartuploads','listparts','putbucket']);
const classB = new Set(['getobject','headobject','headbucket','usagesummary']);
const free = new Set(['deleteobject','deleteobjects','deletebucket','abortmultipartupload']);

export class R2GuardError extends Error {
    constructor(reason) { super(`R2 费用保护：${reason}；操作已停止。`); this.name = 'R2GuardError'; }
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new R2GuardError('统计数据无效');
    return value;
}
function validate(row) {
    if (!row || row.enabled !== 1 || row.error) throw new R2GuardError('统计未就绪或保护已锁定');
    for (const key of ['reserved_bytes','reserved_a','reserved_b','observed_bytes','observed_a','observed_b','checked_at']) integer(row[key]);
    if (row.checked_at > Date.now() + 60_000) throw new R2GuardError('统计时间无效');
    return row;
}
function sizeOf(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
    if (value instanceof Blob) return value.size;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
    if (value && knownStreams.has(value)) return knownStreams.get(value);
    // Unknown-length streams must not reach R2, including future call sites.
    throw new R2GuardError('无法确定写入大小');
}
export function parseAnalytics(data) {
    if (data?.errors?.length) throw new R2GuardError('Cloudflare 统计返回错误');
    const accounts = data?.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new R2GuardError('账户统计缺失');
    const { operations, storage } = accounts[0];
    if (!Array.isArray(operations) || !Array.isArray(storage) || !storage.length || operations.length >= 10000 || storage.length >= 10000) throw new R2GuardError('统计缺失或被截断');
    let a = 0, b = 0;
    for (const item of operations) {
        const count = integer(item.sum?.requests);
        const action = item.dimensions?.actionType?.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (classA.has(action)) a += count;
        else if (classB.has(action)) b += count;
        else if (!free.has(action) && count) throw new R2GuardError('出现未识别的 R2 操作类型');
    }
    // Take the largest daily sample for EACH bucket, then sum ALL account buckets.
    const buckets = new Map();
    for (const item of storage) {
        const name = item.dimensions?.bucketName;
        const timestamp = Date.parse(item.dimensions?.datetime);
        if (!name || !Number.isFinite(timestamp) || Date.now() - timestamp > 24 * 3600_000 || timestamp > Date.now() + 60_000) throw new R2GuardError('存储统计过期或无效');
        const size = integer(item.max?.payloadSize) + integer(item.max?.metadataSize);
        if (integer(item.max?.uploadCount) > 0) throw new R2GuardError('存在未完成分片，无法核对存储');
        buckets.set(name, Math.max(buckets.get(name) || 0, size));
    }
    return { bytes: integer([...buckets.values()].reduce((sum, size) => sum + size, 0)), a: integer(a), b: integer(b) };
}
export async function refreshAnalytics(env, now = Date.now()) {
    const db = env.img_d1;
    if (!db?.prepare || !env.CF_R2_ANALYTICS_TOKEN) throw new R2GuardError('缺少 D1 或只读统计密钥');
    const lease = await db.prepare('UPDATE r2_cost_guard SET refresh_until=? WHERE id=1 AND refresh_until<? RETURNING id').bind(now + 30_000, now).first();
    if (!lease) throw new R2GuardError('统计核对中，请稍后重试');
    try {
        const query = `query Guard($account: string!, $start: Time!, $storageStart: Time!, $end: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            operations: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests } dimensions { actionType } }
            storage: r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $storageStart, datetime_leq: $end}) { max { payloadSize metadataSize uploadCount } dimensions { bucketName datetime } }
          } }
        }`;
        const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
            method: 'POST', headers: { Authorization: `Bearer ${env.CF_R2_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: { account: ACCOUNT, start: new Date(now - 31 * 86400_000 + 1000).toISOString(), storageStart: new Date(now - 86400_000 + 1000).toISOString(), end: new Date(now).toISOString() } }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new R2GuardError('Cloudflare 统计接口不可用');
        const observed = parseAnalytics(await response.json());
        const result = await db.prepare(`UPDATE r2_cost_guard SET observed_bytes=MAX(observed_bytes,?), observed_a=MAX(observed_a,?), observed_b=MAX(observed_b,?), checked_at=?,refresh_until=0,error='' WHERE id=1 AND refresh_until=? RETURNING id`).bind(observed.bytes, observed.a, observed.b, now, now + 30_000).first();
        if (!result) throw new R2GuardError('统计更新失败');
    } catch (error) {
        // Do not store upstream messages/URLs, which could contain sensitive data.
        await db.prepare("UPDATE r2_cost_guard SET checked_at=0,refresh_until=?,error='Analytics unavailable' WHERE id=1 AND refresh_until=?").bind(now + REFRESH_MS, now + 30_000).run();
        throw new R2GuardError('统计核对失败');
    }
}
async function reserve(env, a, b, bytes) {
    integer(a); integer(b); integer(bytes);
    try {
        const db = env.img_d1;
        if (!db?.prepare || !env.CF_R2_ANALYTICS_TOKEN) throw new R2GuardError('缺少统计配置');
        let state = await db.prepare('SELECT * FROM r2_cost_guard WHERE id=1').first();
        if (!state) throw new R2GuardError('配额账本缺失');
        if (state.error || Date.now() - state.checked_at >= REFRESH_MS) {
            await refreshAnalytics(env);
            state = await db.prepare('SELECT * FROM r2_cost_guard WHERE id=1').first();
        }
        validate(state);
        // All limits must remain valid: reaching ANY limit stops ALL R2 operations.
        // Failed R2 calls, retries, overwrites and deletions never refund these counters.
        const accepted = await db.prepare(`UPDATE r2_cost_guard
          SET reserved_a=reserved_a+?,reserved_b=reserved_b+?,reserved_bytes=reserved_bytes+?
          WHERE id=1 AND enabled=1 AND error='' AND checked_at>=? AND checked_at<=?
          AND reserved_a>=0 AND reserved_b>=0 AND reserved_bytes>=0
          AND observed_a>=0 AND observed_b>=0 AND observed_bytes>=0
          AND reserved_a+observed_a+?<${LIMITS.a}
          AND reserved_b+observed_b+?<${LIMITS.b}
          AND reserved_bytes+observed_bytes+?<${LIMITS.bytes}
          RETURNING id`).bind(a,b,bytes,Date.now()-REFRESH_MS,Date.now()+60_000,a,b,bytes).first();
        if (!accepted) throw new R2GuardError('额度已达上限或统计异常');
    } catch (error) {
        if (error instanceof R2GuardError) throw error;
        throw new R2GuardError('配额数据库不可用');
    }
}
export function getGuardedR2(env) {
    const binding = env.img_r2;
    if (!binding) throw new R2GuardError('R2 未绑定');
    // No mutable per-request environment and no replacement of the original binding.
    if (wrappers.has(binding)) return wrappers.get(binding);
    const raw = getMeteredR2(env,binding);
    const multipart = handle => Object.freeze({
        key: handle.key, uploadId: handle.uploadId,
        async uploadPart(number, value, ...args) { await reserve(env,1,0,2*sizeOf(value)+8192); return handle.uploadPart(number,value,...args); },
        async complete(...args) { await reserve(env,1,0,0); return handle.complete(...args); },
        async abort(...args) { await reserve(env,1,0,0); return handle.abort(...args); },
    });
    const bucket = new Proxy(Object.freeze({
        async get(...args) {
            await reserve(env,0,1,0);
            const object = await raw.get(...args);
            if (object?.body && Number.isSafeInteger(object.size)) knownStreams.set(object.body,object.size);
            return object;
        },
        async head(...args) { await reserve(env,0,1,0); return raw.head(...args); },
        async put(key,value,...args) { await reserve(env,1,0,sizeOf(value)+8192); return raw.put(key,value,...args); },
        async list(...args) { await reserve(env,1,0,0); return raw.list(...args); },
        async delete(...args) { await reserve(env,1,0,0); return raw.delete(...args); },
        async createMultipartUpload(...args) { await reserve(env,1,0,8192); return multipart(await raw.createMultipartUpload(...args)); },
        resumeMultipartUpload(...args) { return multipart(raw.resumeMultipartUpload(...args)); },
    }), { get(target,key) {
        if (key in target) return Reflect.get(target,key);
        throw new R2GuardError('未受保护的 R2 方法');
    } });
    wrappers.set(binding,bucket);
    return bucket;
}
export async function guardStatus(env) {
    const state = await env.img_d1.prepare('SELECT * FROM r2_cost_guard WHERE id=1').first();
    let blocked = true;
    let remaining = null;
    try {
        validate(state);
        remaining = {
            bytes: Math.max(0,LIMITS.bytes-state.reserved_bytes-state.observed_bytes),
            a: Math.max(0,LIMITS.a-state.reserved_a-state.observed_a),
            b: Math.max(0,LIMITS.b-state.reserved_b-state.observed_b),
        };
        blocked = !env.CF_R2_ANALYTICS_TOKEN || Date.now()-state.checked_at>=REFRESH_MS || Object.values(remaining).some(value=>value<=0);
    } catch { /* invalid ledger remains blocked */ }
    return { limits: LIMITS, state, remaining, blocked, refreshIntervalSeconds: REFRESH_MS/1000, policy: 'monotonic-no-refunds-no-automatic-reset', configured: !!env.CF_R2_ANALYTICS_TOKEN };
}
