import{deleting}from'./deletion.mjs';
import{hash,id,blobDigest}from'./world.mjs';
const format='ink-os-version-v1',mime='application/vnd.ink-os.version+json';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const isVersion=object=>object?.namespace==='os'&&object.kind==='os.version';
const json=value=>JSON.stringify(value);
const locations=value=>[...new Set((json(value).match(/(?:blob:[a-f0-9]{64}|(?:r2|s3):\/\/[^\s"\\]+\/objects\/[a-f0-9]{64})/g)||[]))];
const liveRegisters=doc=>Object.fromEntries((doc.snapshot.registers||[]).filter(row=>!row.deleted).map(row=>[row.path,JSON.parse(row.value)]));
function objectMap(manifest){
 const projected=new Set();for(const doc of manifest.documents)if(doc.metadata.kind==='state'&&doc.metadata.key==='state')for(const row of doc.snapshot.registers||[]){const key=row.path.slice(1).replaceAll('~1','/').replaceAll('~0','~');projected.add(hash(doc.metadata.namespace+'\0state\0'+key).slice(0,32));}
 const objects=new Map(manifest.world.objects.filter(object=>object.kind!=='collaboration'&&!projected.has(object.id)).map(object=>[object.id,{...object}]));
 for(const doc of manifest.documents)if(doc.metadata.kind==='text'&&doc.metadata.key.startsWith('object:')){const object=objects.get(doc.metadata.key.slice(7));if(object)object.body=doc.snapshot.text;}
 return objects;
}
function changes(before,after,key){
 const left=new Map(before.map(value=>[key(value),value])),right=new Map(after.map(value=>[key(value),value]));
 return{added:[...right.keys()].filter(id=>!left.has(id)),removed:[...left.keys()].filter(id=>!right.has(id)),changed:[...right.keys()].filter(id=>left.has(id)&&json(left.get(id))!==json(right.get(id)))};
}
export class Versions{
 constructor({world,collaboration,storage,bundle}){Object.assign(this,{world,collaboration,storage,bundle});this.cache=new Map();this.tail=Promise.resolve();world.versions=this;}
 records(){return this.world.all().filter(isVersion).sort((a,b)=>b.created-a.created||b.id.localeCompare(a.id));}
 metadata(record){if(!isVersion(record))fail(404,'OS version not found');let meta;try{meta=JSON.parse(record.body);}catch{fail(503,'OS version metadata is corrupt');}if(meta.format!==format||meta.manifestDigest!==blobDigest(record.location))fail(503,'OS version metadata is corrupt');return meta;}
 view(record){if(!isVersion(record))fail(404,'OS version not found');const base={id:record.id,label:record.title,archived:record.archived,status:record.status};try{return{...base,...this.metadata(record)};}catch(error){if(error.status!==503)throw error;return{...base,status:'corrupt',error:error.message};}}
 list({includeDeleted=false}={}){return this.records().filter(row=>includeDeleted||!row.archived).map(row=>this.view(row));}
 get(key){return this.view(this.world.get(key));}
 async stageManifest(manifest,{label='Before restoring OS'}={}){
  manifest=structuredClone(manifest);
  if(manifest?.format!==format||!/^[a-f0-9]{32}$/.test(manifest.id||'')||!Array.isArray(manifest.world?.objects)||!Array.isArray(manifest.documents)||!Array.isArray(manifest.locations)||!Array.isArray(manifest.parents)||typeof label!=='string'||!label.trim()||label.length>120)fail(400,'Invalid staged OS version');
  const blob=await this.storage.put(Buffer.from(json(manifest)),mime,{retain:true});
  return{manifest,release:blob.release,record:{id:manifest.id,namespace:'os',kind:'os.version',title:label.trim(),location:blob.location,tags:['os-version'],status:'saved',body:json({format,mime,manifestDigest:blob.digest,capturedAt:manifest.capturedAt,worldVersion:manifest.world.version,parents:manifest.parents,objects:manifest.world.objects.length,documents:manifest.documents.length,assets:manifest.locations.length})}};
 }
 async read(key){
  const record=this.world.get(key),meta=this.metadata(record);let pending=this.cache.get(meta.manifestDigest);
  if(!pending){pending=(async()=>{const bytes=await this.storage.get(record.location);if(hash(bytes)!==meta.manifestDigest)fail(503,'OS version content digest mismatch');const manifest=JSON.parse(bytes);if(manifest.format!==format||manifest.id!==key)fail(503,'OS version identity mismatch');return manifest;})();this.cache.set(meta.manifestDigest,pending);while(this.cache.size>2)this.cache.delete(this.cache.keys().next().value);pending.catch(()=>this.cache.delete(meta.manifestDigest));}
  return structuredClone(await pending);
 }
 async capture(){
  if(this.world.deleting.size||this.world.deletingNamespaces.size)fail(409,'Permanent deletion is in progress; retry this version afterwards');
  const captured=await this.collaboration.captureVersion(()=>this.world.captureVersion());
  if(captured.world.objects.some(object=>['purging','purge-failed'].includes(object.status))||this.world.deleting.size||this.world.deletingNamespaces.size)fail(409,'Finish pending permanent deletion before saving an OS version');
  const bundles={};for(const record of captured.world.objects.filter(object=>object.namespace==='os'&&object.kind==='release')){const meta=JSON.parse(record.body);if(!meta.bundleLocation&&this.bundle)bundles[record.id]=await this.bundle(record.id);}
  const snapshot={...captured,bundles},owned=new Set(Object.values(captured.world.blobRefs).flat().map(blobDigest));return{format,...snapshot,locations:locations(snapshot).filter(location=>owned.has(blobDigest(location))&&!this.world.retiredBlobs.has(blobDigest(location)))};
 }
 create({label='Saved OS version',parent}={}){
  if(typeof label!=='string'||!label.trim()||label.length>120)fail(400,'Give this OS version a label of at most 120 characters');
  const task=this.tail.then(async()=>{
   const previous=parent===null?null:parent||this.list()[0]?.id;if(previous)this.metadata(this.world.get(previous));
   const snapshot=await this.capture(),key=id(),manifest={...snapshot,id:key,parents:previous?[previous]:[]};
   const blob=await this.storage.put(Buffer.from(json(manifest)),mime,{retain:true});
   try{
    const record=await this.world.put(()=>{
     if(snapshot.world.objects.some(object=>this.world.purged.has(object.id)||this.world.deleting.has(object.id)||this.world.deletingNamespaces.has(object.namespace)||['purging','purge-failed'].includes(this.world.get(object.id)?.status)))fail(409,'An object was permanently deleted during capture; retry this version');
     if(snapshot.locations.some(location=>this.world.retiredBlobs.has(blobDigest(location))))fail(409,'Referenced content was permanently deleted during capture');
     return{id:key,namespace:'os',kind:'os.version',title:label.trim(),location:blob.location,tags:['os-version'],status:'saved',body:json({format,mime,manifestDigest:blob.digest,capturedAt:manifest.capturedAt,worldVersion:snapshot.world.version,parents:manifest.parents,objects:snapshot.world.objects.length,documents:snapshot.documents.length,assets:snapshot.locations.length})};
    },{writer:'os',expected:0,actor:'Version history',action:'saved OS version'});
    this.cache.set(blob.digest,Promise.resolve(manifest));while(this.cache.size>2)this.cache.delete(this.cache.keys().next().value);return this.view(record);
   }catch(error){blob.release();try{await this.world.transact(async()=>{const retained=json({objects:this.world.all(),history:this.world.history,refs:this.world.blobRefs});if(!retained.includes(blob.digest))await this.storage.remove(blob.location);});}catch(cleanupError){error.cleanupError=cleanupError.message;}throw error;}finally{blob.release();}
  });this.tail=task.catch(()=>{});return task;
 }
 async references(exclude){const refs=[];for(const row of this.records())if(row.id!==exclude)refs.push(...(await this.read(row.id)).locations);return[...new Set(refs)];}
 async assertCanPurge(ids){
  const targets=new Set(ids);for(const row of this.records()){if(targets.has(row.id))continue;const snapshot=await this.read(row.id);if(snapshot.world.objects.some(object=>targets.has(object.id))||snapshot.documents.some(doc=>targets.has(doc.metadata.id.slice(0,32))))fail(409,'Retained by OS version '+row.id+'; permanently delete that saved version first');}
 }
 async archive(key,{restore=false,permanent=false}={}){
  const record=this.world.get(key);if(!isVersion(record))fail(404,'OS version not found');const manifestDigest=blobDigest(record.location);
  if(!permanent){const saved=await this.world.update(key,{archived:!restore},{writer:'os',expected:record.revision,actor:'Version history',action:restore?'restored saved version':'archived saved version'});return this.view(saved);}
  if(!record.archived)fail(409,'Archive this saved version before permanently deleting it');
  await deleting({world:this.world,versions:this},record,undefined,()=>this.world.erase([key],{cleanup:async()=>{
   const otherRefs=await this.references(key),surviving=json({objects:this.world.all().filter(object=>object.id!==key),history:this.world.history.filter(entry=>entry.objectId!==key),refs:Object.entries(this.world.blobRefs).filter(([id])=>id!==key),versions:otherRefs});
   if(manifestDigest&&!surviving.includes(manifestDigest)&&await this.storage.remove(record.location))this.world.retiredBlobs.add(manifestDigest);
  }}));this.cache.delete(manifestDigest);return{deleted:true,permanent:true,id:key};
 }
 async diff(key,{against='current'}={}){
  const before=await this.read(key),after=against==='current'?await this.capture():await this.read(against),left=objectMap(before),right=objectMap(after);
  const content=object=>{const{revision,updated,...rest}=object;return rest;},objects=changes([...left.values()].map(content),[...right.values()].map(content),object=>object.id);
  objects.changed=objects.changed.map(id=>({id,fields:Object.keys(right.get(id)).filter(field=>!['revision','updated'].includes(field)&&json(left.get(id)[field])!==json(right.get(id)[field]))}));
  const clean=doc=>({id:doc.metadata.id,namespace:doc.metadata.namespace,key:doc.metadata.key,kind:doc.metadata.kind,value:doc.metadata.kind==='text'?doc.snapshot.text:liveRegisters(doc)}),a=before.documents.map(clean),b=after.documents.map(clean),documents=changes(a,b,doc=>doc.id);
  const aDocs=new Map(a.map(doc=>[doc.id,doc])),bDocs=new Map(b.map(doc=>[doc.id,doc]));documents.changed=documents.changed.map(id=>{const old=aDocs.get(id),next=bDocs.get(id),fields=next.kind==='text'?['text']:[...new Set([...Object.keys(old.value),...Object.keys(next.value)])].filter(path=>json(old.value[path])!==json(next.value[path]));return{id,namespace:next.namespace,key:next.key,kind:next.kind,fields};});
  const apps=[...new Set([...objects.added,...objects.removed,...objects.changed.map(row=>row.id)])].filter(id=>(right.get(id)||left.get(id)).kind==='app'&&(right.get(id)||left.get(id)).namespace==='os').map(id=>({id,before:left.has(id)?JSON.parse(left.get(id).body).releaseId||null:null,after:right.has(id)?JSON.parse(right.get(id).body).releaseId||null:null}));
  return{before:key,after:against,worldVersion:after.world.version,objects,documents,apps,assets:{added:after.locations.filter(value=>!before.locations.includes(value)),removed:before.locations.filter(value=>!after.locations.includes(value))}};
 }
}
