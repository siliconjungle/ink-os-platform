import { mkdir, readFile, writeFile, unlink, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
import { hash,blobDigest } from './world.mjs';

export class Storage {
  constructor(directory,{env=process.env}={}) { this.directory = directory; this.env=env; this.config = null;this.r2=null;this.blobTails=new Map();this.inflight=new Map(); }
  async open() { await mkdir(join(this.directory, 'blobs'), { recursive: true }); try { this.config = JSON.parse(await readFile(join(this.directory, 'storage.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }if(this.env.INK_OS_R2_URL&&this.env.INK_OS_R2_TOKEN)this.r2={url:this.env.INK_OS_R2_URL,token:this.env.INK_OS_R2_TOKEN,bucket:this.env.INK_OS_R2_BUCKET||'ink-os-assets'};const bucket=this.env.INK_OS_S3_BUCKET||this.env.BUCKET_NAME||this.env.S3_BUCKET;if(bucket)this.config={managed:true,bucket,endpoint:this.env.INK_OS_S3_ENDPOINT||this.env.AWS_ENDPOINT_URL_S3||this.env.S3_ENDPOINT,region:this.env.AWS_REGION||this.env.AWS_DEFAULT_REGION||'auto',accessKeyId:this.env.AWS_ACCESS_KEY_ID,secretAccessKey:this.env.AWS_SECRET_ACCESS_KEY,prefix:(this.env.INK_OS_STORAGE_PREFIX||'ink-os').replace(/^\/+|\/+$/g,'')+'/'};return this; }
  client(config = this.config) { return new S3Client({ endpoint: config.endpoint || undefined, region: config.region || 'us-east-1', forcePathStyle: true,
    credentials: config.accessKeyId && config.secretAccessKey ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined }); }
  async connect(config) {
    if(this.r2||this.config?.managed)throw Error('Storage is managed through server environment variables');if (!config.bucket) throw Error('Enter a bucket name');
    await this.client(config).send(new HeadBucketCommand({ Bucket: config.bucket }));
    this.config = config; await writeFile(join(this.directory, 'storage.json'), JSON.stringify(config), { mode: 0o600 });
    return this.describe();
  }
  describe() { return { local: true,...(this.r2?{r2:{managed:true,bucket:this.r2.bucket}}:{}),s3: !this.r2&&this.config ? { managed:!!this.config.managed,bucket: this.config.bucket, endpoint: this.config.endpoint || '', region: this.config.region || 'us-east-1' } : null }; }
  pending(location){return (this.inflight.get(blobDigest(location))||0)>0;}
  lockBlob(digest,run){const previous=this.blobTails.get(digest)||Promise.resolve(),task=previous.catch(()=>{}).then(run);this.blobTails.set(digest,task);task.finally(()=>{if(this.blobTails.get(digest)===task)this.blobTails.delete(digest);}).catch(()=>{});return task;}
  async put(bytes,mime='application/octet-stream',{retain=false}={}){const digest=hash(bytes);this.inflight.set(digest,(this.inflight.get(digest)||0)+1);let released=false;const release=()=>{if(released)return;released=true;const count=(this.inflight.get(digest)||1)-1;count?this.inflight.set(digest,count):this.inflight.delete(digest);};try{const result=await this.lockBlob(digest,()=>this.putBytes(bytes,mime));if(!retain)release();return{...result,release};}catch(error){release();throw error;}}
  async putBytes(bytes, mime = 'application/octet-stream') {
    const digest = hash(bytes); const key = `${this.config?.prefix||''}objects/${digest}`;
    if(!this.r2&&!this.config){const directory=join(this.directory,'blobs'),path=join(directory,digest);await writeFile(path+'.next',bytes,{mode:0o600,flush:true});await rename(path+'.next',path);const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
    if(this.r2){await this.r2Request('/objects/'+digest,{method:'PUT',headers:{'Content-Type':mime},body:bytes});return{location:`r2://${this.r2.bucket}/objects/${digest}`,digest,bytes:bytes.length,mime};}
    if (this.config) {
      await this.client().send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: mime }));
      return { location: `s3://${this.config.bucket}/${key}`, digest, bytes: bytes.length, mime };
    }
    return { location: `blob:${digest}`, digest, bytes: bytes.length, mime };
  }
  async r2Request(path,init={}){const response=await fetch(new URL(path,this.r2.url),{...init,headers:{...init.headers,Authorization:'Bearer '+this.r2.token},signal:AbortSignal.timeout(60000)});if(!response.ok)throw Object.assign(Error('R2 storage request failed: '+response.status),{status:502});return response;}
  async get(location) {
    if(location.startsWith('r2://')){if(!this.r2)throw Error('Managed R2 storage is unavailable');const url=new URL(location);if(url.hostname!==this.r2.bucket||!/^\/objects\/[a-f0-9]{64}$/.test(url.pathname))throw Error('Asset is outside managed R2 storage');return Buffer.from(await(await this.r2Request(url.pathname)).arrayBuffer());}
    if (location.startsWith('blob:')) { const digest = location.slice(5); if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid blob'); return readFile(join(this.directory, 'blobs', digest)); }
    if (location.startsWith('s3://')) {
      if (!this.config) throw Error('Connect this S3 source first');
      const url = new URL(location);if(url.hostname!==this.config.bucket||this.config.prefix&&!url.pathname.slice(1).startsWith(this.config.prefix))throw Error('Asset is outside the managed storage prefix');const result = await this.client().send(new GetObjectCommand({ Bucket: url.hostname, Key: url.pathname.slice(1) }));
      return Buffer.from(await result.Body.transformToByteArray());
    }
    throw Error('Unsupported storage location');
  }
  async remove(location){const digest=blobDigest(location);if(!digest)return false;return this.lockBlob(digest,()=>this.pending(location)?false:this.removeBytes(location));}
  async removeBytes(location) {
    let digest;
    if (/^blob:[a-f0-9]{64}$/.test(location)) digest=location.slice(5);
    else if (location.startsWith('r2://') && this.r2) {
      const url=new URL(location);
      if(url.hostname!==this.r2.bucket||!/^\/objects\/[a-f0-9]{64}$/.test(url.pathname))return false;
      digest=url.pathname.slice(9);await this.r2Request(url.pathname,{method:'DELETE'});
    } else if(location.startsWith('s3://') && this.config?.managed) {
      const url=new URL(location),prefix=(this.config.prefix||'')+'objects/';
      if(url.hostname!==this.config.bucket||!url.pathname.slice(1).startsWith(prefix)||!/^[a-f0-9]{64}$/.test(url.pathname.slice(prefix.length+1)))return false;
      digest=url.pathname.slice(prefix.length+1);await this.client().send(new DeleteObjectCommand({Bucket:url.hostname,Key:url.pathname.slice(1)}));
    } else return false;
    await unlink(join(this.directory,'blobs',digest)).catch(error=>{if(error.code!=='ENOENT')throw error;});return true;
  }
  async list(prefix = '') {
    if(this.r2){const objects=await(await this.r2Request('/_list')).json();return objects.filter(object=>object.key.startsWith(prefix)).map(object=>({...object,location:`r2://${this.r2.bucket}/${object.key}`}));}
    if (!this.config) throw Error('Connect S3 first');
    const result = await this.client().send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: (this.config.prefix||'')+prefix, MaxKeys: 100 }));
    return (result.Contents || []).map(o => ({ key: o.Key, size: o.Size, modified: o.LastModified, location: `s3://${this.config.bucket}/${o.Key}` }));
  }
}
