// R2保护扩展：服务器私有 R2 的桶接口兼容层，见 docs/code-changes.md。
// 这里不判断额度；业务必须从 getGuardedR2 调用它，禁止另建绕过保护的业务 SDK。
import {
    S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
    ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand,
    CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

// Keep the original R2 binding interface and object keys. All callers still pass
// through getGuardedR2; disable SDK retries so every attempt has a reservation.
export class CloudflareR2 {
    constructor(env, client) {
        const {R2_ACCOUNT_ID,R2_BUCKET,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY}=env;
        if (!R2_ACCOUNT_ID || !R2_BUCKET || (!client && (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY))) {
            throw new Error('Private R2 connection is not configured');
        }
        this.bucket=R2_BUCKET;
        this.client=client || new S3Client({region:'auto',
            endpoint:`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials:{accessKeyId:R2_ACCESS_KEY_ID,secretAccessKey:R2_SECRET_ACCESS_KEY},
            maxAttempts:1,forcePathStyle:true});
    }
    async send(Command,input) { return this.client.send(new Command({Bucket:this.bucket,...input})); }
    async get(key,options={}) {
        const r=options.range;
        const Range=r ? r.suffix ? `bytes=-${r.suffix}` : `bytes=${r.offset||0}-${r.length? (r.offset||0)+r.length-1:''}` : undefined;
        try { return object(await this.send(GetObjectCommand,{Key:key,Range}),key); }
        catch(e) { if(e.$metadata?.httpStatusCode===404)return null;throw e; }
    }
    async head(key) {
        try { return object(await this.send(HeadObjectCommand,{Key:key}),key); }
        catch(e) { if(e.$metadata?.httpStatusCode===404)return null;throw e; }
    }
    async put(key,value,options={}) {
        const body=await payload(value);
        const result=await this.send(PutObjectCommand,{Key:key,Body:body,
            ...metadata(options),ContentLength:body.byteLength,StorageClass:'STANDARD'});
        return {key,etag:result.ETag?.replaceAll('"',''),httpEtag:result.ETag};
    }
    async list(options={}) {
        const result=await this.send(ListObjectsV2Command,{Prefix:options.prefix,
            ContinuationToken:options.cursor,MaxKeys:Math.min(options.limit||1000,1000),Delimiter:options.delimiter});
        return {objects:(result.Contents||[]).map(x=>({key:x.Key,size:x.Size,uploaded:x.LastModified,etag:x.ETag?.replaceAll('"',''),httpEtag:x.ETag})),
            truncated:!!result.IsTruncated,cursor:result.NextContinuationToken,
            delimitedPrefixes:(result.CommonPrefixes||[]).map(x=>x.Prefix)};
    }
    async delete(keys) {
        if(Array.isArray(keys)) {
            const result=await this.send(DeleteObjectsCommand,{Delete:{Objects:keys.map(Key=>({Key})),Quiet:true}});
            if(result.Errors?.length)throw new Error('R2 deletion was incomplete');
        } else await this.send(DeleteObjectCommand,{Key:keys});
    }
    async createMultipartUpload(key,options={}) {
        const result=await this.send(CreateMultipartUploadCommand,{Key:key,...metadata(options),StorageClass:'STANDARD'});
        if(!result.UploadId)throw new Error('R2 multipart identifier missing');
        return this.resumeMultipartUpload(key,result.UploadId);
    }
    resumeMultipartUpload(key,uploadId) {
        return {key,uploadId,
            uploadPart:async(number,value)=>{
                const body=await payload(value);
                const result=await this.send(UploadPartCommand,{Key:key,UploadId:uploadId,PartNumber:number,Body:body,ContentLength:body.byteLength});
                return {partNumber:number,etag:result.ETag};
            },
            complete:async(parts)=>{
                const result=await this.send(CompleteMultipartUploadCommand,{Key:key,UploadId:uploadId,
                    MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.partNumber,ETag:p.etag})).sort((a,b)=>a.PartNumber-b.PartNumber)}});
                return {key,etag:result.ETag?.replaceAll('"',''),httpEtag:result.ETag};
            },
            abort:()=>this.send(AbortMultipartUploadCommand,{Key:key,UploadId:uploadId}),
        };
    }
}
async function payload(value) {
    if(typeof value==='string')return Buffer.from(value);
    if(value instanceof Blob)return new Uint8Array(await value.arrayBuffer());
    if(value instanceof ArrayBuffer)return new Uint8Array(value);
    if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    // The guard only lets known-length R2 copy streams through this path.
    return new Uint8Array(await new Response(value).arrayBuffer());
}
function metadata(options) {
    const m=options.httpMetadata||{};
    return {ContentType:m.contentType,CacheControl:m.cacheControl,ContentDisposition:m.contentDisposition,
        ContentEncoding:m.contentEncoding,ContentLanguage:m.contentLanguage,Metadata:options.customMetadata};
}
function object(value,key) {
    const match=value.ContentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const body=value.Body ? value.Body.transformToWebStream ? value.Body.transformToWebStream() :
        value.Body instanceof ReadableStream ? value.Body : Readable.toWeb(value.Body) : undefined;
    const httpMetadata={contentType:value.ContentType,cacheControl:value.CacheControl,contentDisposition:value.ContentDisposition,
        contentEncoding:value.ContentEncoding,contentLanguage:value.ContentLanguage};
    return {key,body,size:match?Number(match[3]):value.ContentLength,
        range:match?{offset:Number(match[1]),length:Number(match[2])-Number(match[1])+1}:undefined,
        etag:value.ETag?.replaceAll('"',''),httpEtag:value.ETag,uploaded:value.LastModified,
        httpMetadata,customMetadata:value.Metadata||{},
        writeHttpMetadata(headers) {
            for(const [name,v] of Object.entries({'Content-Type':value.ContentType,'Cache-Control':value.CacheControl,
                'Content-Disposition':value.ContentDisposition,'Content-Encoding':value.ContentEncoding,'Content-Language':value.ContentLanguage,
                'ETag':value.ETag,'Last-Modified':value.LastModified?.toUTCString()}))if(v)headers.set(name,v);
        },
    };
}
