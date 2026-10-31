import {unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {desktopFile} from '../shared/desktop-placements.mjs';
import {blobDigest} from './world.mjs';
import {clearAppDefaults} from './file-defaults.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const metadata=object=>{try{return JSON.parse(object.body);}catch{return{};}};
export async function deleting(platform,object,namespace,run){
 await platform.versions?.assertCanPurge([object.id]);
 await platform.world.update(object.id,{status:'purging'},{writer:object.namespace,actor:'Owner',action:'started permanent deletion'});
 const release=platform.world.freeze([object.id],namespace);
 try{await platform.world.tail;return await run();}
 catch(error){release();if(platform.world.get(object.id))await platform.world.update(object.id,{status:'purge-failed'},{writer:object.namespace,actor:'Cleanup',action:'permanent deletion needs retry'});throw error;}
 finally{release();}
}
export async function deleteFile(platform,id,{permanent=false,restore=false}={}){
 const object=platform.world.get(id);if(!object||!desktopFile({...object,archived:false}))fail(404,'File not found');
 if(restore)return platform.world.update(id,{archived:false},{writer:object.namespace,actor:'Owner',action:'restored file'});
 if(permanent){if(!object.archived)fail(409,'Delete this file before permanently deleting it');return deleting(platform,object,undefined,()=>purge(platform,[platform.world.get(id)]));}
 const deleted=await platform.world.update(id,{archived:true},{writer:object.namespace,actor:'Owner',action:'deleted file'});
 await platform.collaboration?.removeDesktopReferences([id]);return deleted;
}
function runtimes(deployment){return [deployment?.app,...(deployment?.backendURL?[new URL(deployment.backendURL).hostname.replace(/(?:\.fly\.dev|\.internal)$/,'')]:[])].filter(Boolean);}
export async function purgeApp(platform,id){
 const app=platform.world.get(id);if(!app||app.kind!=='app'||app.namespace!=='os')fail(404,'Application not found');
 if(!app.archived)fail(409,'Delete this app before permanently deleting it');
 return deleting(platform,app,id,async()=>{
  const run=async()=>{
   delete platform.keys[id];await platform.saveKeys();
   const releases=platform.world.all().filter(o=>o.kind==='release'&&metadata(o).appId===id),releaseIds=new Set(releases.map(o=>o.id));
   const survivingRuntimes=new Set(platform.world.all().filter(o=>!releaseIds.has(o.id)&&o.kind==='release').flatMap(o=>runtimes(metadata(o).deployment)));
   for(const release of releases){const deployment=metadata(release).deployment;if(!deployment)continue;if(runtimes(deployment).some(name=>survivingRuntimes.has(name)))continue;if(!platform.provider?.retire)fail(503,'Runtime cleanup provider is unavailable');await platform.provider.retire(deployment);}
   await platform.environment.remove(id);await clearAppDefaults(platform,id);
   const objects=platform.world.all().filter(o=>o.id===id||o.namespace===id||releaseIds.has(o.id)||o.kind==='fork-snapshot'&&metadata(o).targetId===id);
   return purge(platform,objects,{namespace:id,releases});
  };
  const task=platform.publishTail.then(run);platform.publishTail=task.catch(()=>{});return task;
 });
}
async function purge(platform,objects,{namespace,releases=[]}={}){
 const ids=objects.map(o=>o.id),targets=new Set(ids);
 // Projection identities remain identifiable even after a partial document cleanup.
 for(const object of platform.world.all())if(object.kind==='collaboration'&&(object.namespace===namespace||ids.some(id=>object.title==='object:'+id))){targets.add(object.id);ids.push(object.id);objects.push(object);}
 await platform.collaboration?.removeDesktopReferences(ids);
 const documents=await platform.collaboration?.purge({ids,namespace})||[];for(const id of documents)if(!targets.has(id)){targets.add(id);ids.push(id);const record=platform.world.get(id);if(record)objects.push(record);}
 let removedBlobs=0;
 await platform.world.erase(ids,{cleanup:async()=>{
  // Recheck ownership inside the same serialized transaction that erases metadata.
  const surviving=JSON.stringify({versions:await platform.versions?.references()||[],objects:platform.world.all().filter(o=>!targets.has(o.id)),history:platform.world.history.filter(h=>!targets.has(h.objectId)),refs:Object.entries(platform.world.blobRefs).filter(([id])=>!targets.has(id))});
  const revisions=platform.world.history.filter(h=>targets.has(h.objectId)).flatMap(h=>[h.before,h.after]).filter(Boolean);
  const locations=[...new Set([...objects,...revisions].map(o=>o.location).concat(ids.flatMap(id=>platform.world.blobRefs[id]||[])).filter(location=>blobDigest(location)))];
  for(const location of locations){const digest=blobDigest(location);if(!surviving.includes(digest)&&await platform.storage?.remove(location)){removedBlobs++;platform.world.retiredBlobs.add(digest);}}
  for(const release of releases){const value=metadata(release).digest;if(!/^[a-f0-9]{64}$/.test(value)||surviving.includes(value))continue;await unlink(join(platform.directory,'releases',value+'.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }});
 return{deleted:true,permanent:true,ids,removedBlobs};
}
