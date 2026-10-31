import{createHash}from'node:crypto';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
// A transport chunk is bounded; an application or an individual file is not.
export const ARTIFACT_CHUNK_BYTES=16*1024*1024;
export function artifactRecords(platform,appId){platform.app(appId);return platform.world.all().filter(object=>object.namespace===appId&&!object.archived&&object.tags.includes('app-artifact')).flatMap(object=>{try{const body=JSON.parse(object.body);return[{id:object.id,sha256:body.sha256,bytes:body.bytes}];}catch{return[];}});}
export function validateArtifactReferences(world,assets,appId,bucket){
 if(!assets)return;
 // One Ink snapshot avoids one database bridge invocation per asset segment.
 const retained=new Map(world.all().filter(object=>object.namespace===appId).map(object=>[object.id,object]));
 for(const file of assets.values())for(const part of file.chunks||[file.pack||file]){const object=retained.get(part.objectId||file.objectId);if(!object||object.archived||object.location!==`r2://${bucket}/objects/${part.sha256}`)fail(403,'Release artifacts must be retained in this application namespace');}
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
