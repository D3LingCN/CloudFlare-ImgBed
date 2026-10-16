// R2保护扩展：报表阈值须与保护模块 LIMITS 一起审查；FREE_TIER 仅作免费额度分母。
export const VERSION = 1;
export const DAY = 86_400_000;
export const DEFAULT_BUCKET = 'd3ling-imgbed-files';
export const LIMITS = Object.freeze({ a: 850_000, b: 8_500_000, bytes: 8_500_000_000 });
export const FREE_TIER = Object.freeze({ a: 1_000_000, b: 10_000_000 });
const a = new Set(['listbuckets','putbucket','listobjects','listobjectsv2','putobject','copyobject','completemultipartupload','createmultipartupload','lifecyclestoragetiertransition','listmultipartuploads','uploadpart','uploadpartcopy','listparts','putbucketencryption','putbucketcors','putbucketlifecycleconfiguration']);
const b = new Set(['headbucket','headobject','getobject','usagesummary','getbucketencryption','getbucketlocation','getbucketcors','getbucketlifecycleconfiguration']);
const free = new Set(['deleteobject','deleteobjects','deletebucket','abortmultipartupload']);
export function classify(action) {
    const name = String(action).replace(/[^a-z0-9]/gi,'').toLowerCase();
    return a.has(name) ? 'A' : b.has(name) ? 'B' : free.has(name) ? 'free' : 'unknown';
}
export function dayOf(now) { return new Date(now).toISOString().slice(0,10); }
export function monthOf(now) { return new Date(now).toISOString().slice(0,7); }
export function integer(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid analytics count');
    return n;
}
export function totals(rows) {
    const value = { a:0, b:0, free:0, unknown:0, unauthorized:0 };
    for (const row of rows) {
        const count = integer(row.requests);
        const key = row.class === 'A' ? 'a' : row.class === 'B' ? 'b' : row.class;
        value[key] = integer(value[key] + count);
        if (row.status === 401) value.unauthorized = integer(value.unauthorized + count);
    }
    return value;
}
export async function sha256(value) {
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function bucketName(env) { return env.R2_USAGE_BUCKET || DEFAULT_BUCKET; }
export function database(env) {
    if (!env.R2_USAGE_DB?.prepare) throw new Error('R2 usage database is not configured');
    return env.R2_USAGE_DB;
}
