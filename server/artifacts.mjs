import{createHash}from'node:crypto';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
// A transport chunk is bounded; an application or an individual file is not.
export const ARTIFACT_CHUNK_BYTES=16*1024*1024;
export function artifactRecords(platform,appId){platform.app(appId);return platform.world.all().filter(object=>object.namespace===appId&&!object.archived&&object.tags.includes('app-artifact')).flatMap(object=>{try{const body=JSON.parse(object.body);return[{id:object.id,sha256:body.sha256,bytes:body.bytes}];}catch{return[];}});}
function currentLocation(location,digest,storage){
 if(typeof storage==='string')return location===`r2://${storage}/objects/${digest}`;
 if(storage?.r2)return location===`r2://${storage.r2.bucket}/objects/${digest}`;
 if(storage?.config)return location===`s3://${storage.config.bucket}/${storage.config.prefix||''}objects/${digest}`;
 return !!storage&&location===`blob:${digest}`;
}
export function validateArtifactReferences(world,assets,appId,storage){
 const references=new Map();if(!assets)return references;
 // One Ink snapshot avoids one database bridge invocation per asset segment.
 const retained=new Map(world.all().filter(object=>object.namespace===appId).map(object=>[object.id,object]));
 for(const file of assets.values())for(const part of file.chunks||[file.pack||file]){
  const object=retained.get(part.objectId||file.objectId);let metadata;try{metadata=JSON.parse(object?.body);}catch{}
  if(!object||object.archived||object.kind!=='file'||!Array.isArray(object.tags)||!object.tags.includes('app-artifact')||!/^[a-f0-9]{64}$/.test(part.sha256)||!metadata||metadata.sha256!==part.sha256||metadata.bytes!==part.bytes||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>ARTIFACT_CHUNK_BYTES||!currentLocation(object.location,part.sha256,storage))fail(403,'Release artifacts must be retained in this application namespace and current storage');
  const previous=references.get(part.sha256);if(previous&&previous.bytes!==part.bytes)fail(403,'Release artifact size is inconsistent');references.set(part.sha256,{location:object.location,bytes:part.bytes});
 }
 return references;
}
// A narrow R2-shaped adapter for the shared frontend range/pack/chunk streamer.
// Reads only authenticated manifest references retained by this app. Verify each
// complete transport chunk before exposing its requested byte slice.
export function managedArtifactBucket(platform,appId,file){
 const references=validateArtifactReferences(platform.world,new Map([[file.path,file]]),appId,platform.storage);
 return{async get(key,{range}={}){
  const match=/^objects\/([a-f0-9]{64})$/.exec(key),reference=match&&references.get(match[1]);if(!reference)fail(403,'Release artifact is outside this application manifest');
  if(!range||!Number.isSafeInteger(range.offset)||!Number.isSafeInteger(range.length)||range.offset<0||range.length<1||range.offset+range.length>reference.bytes)fail(400,'Invalid release artifact range');
  if(typeof platform.storage?.readAliasCurrent!=='function')fail(503,'Managed release storage is unavailable');
  let bytes;try{bytes=await platform.storage.readAliasCurrent(reference.location,{maxBytes:ARTIFACT_CHUNK_BYTES,allowMissing:true});}catch(error){if(error.code==='ENOENT'||error.upstreamStatus===404||error.$metadata?.httpStatusCode===404)return null;if(error.upstreamStatus>=500)throw Error('Release asset unavailable');throw Error('Release asset size or integrity mismatch');}
  if(bytes===null)return null;
  if(!(bytes instanceof Uint8Array)||bytes.length!==reference.bytes||createHash('sha256').update(bytes).digest('hex')!==match[1])throw Error('Release asset size or integrity mismatch');
  return{size:bytes.length,body:new Response(bytes.subarray(range.offset,range.offset+range.length)).body};
 }};
}
export async function uploadArtifact(platform,req,appId,digest){
 platform.app(appId);if(!/^[a-f0-9]{64}$/.test(digest))fail(400,'Invalid artifact digest');
 const chunks=[];let size=0;const hash=createHash('sha256');
 for await(const chunk of req){size+=chunk.length;if(size>ARTIFACT_CHUNK_BYTES)fail(413,'Artifact transport chunk exceeds 16 MiB');hash.update(chunk);chunks.push(chunk);}
 if(!size||hash.digest('hex')!==digest)fail(400,'Artifact content digest mismatch');
 const prior=platform.world.all().find(o=>o.namespace===appId&&!o.archived&&o.tags.includes('app-artifact')&&JSON.parse(o.body).sha256===digest);if(prior)return platform.world.publicObject(prior);
 const blob=await platform.storage.put(Buffer.concat(chunks,size),'application/octet-stream',{retain:true});
 try{return platform.world.publicObject(await platform.world.put({namespace:appId,kind:'file',title:'Application artifact '+digest.slice(0,12),tags:['app-artifact'],location:blob.location,body:JSON.stringify({mime:'application/vnd.ink-os.artifact',bytes:size,sha256:digest})},{writer:appId,actor:'Deployment',action:'stored artifact'}));}finally{blob.release?.();}
}
