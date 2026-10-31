import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, hash } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { Versions } from '../server/versions.mjs';
import { NamespaceMigrations, namespaceMigrationDigest } from '../server/namespace-migrations.mjs';
import { SharedState } from '../shared/state.mjs';
import { SharedText } from '../shared/text.mjs';

const appId='a'.repeat(32), objectId='b'.repeat(32), fileId='c'.repeat(32), unrelatedId='d'.repeat(32), operation='e'.repeat(32), lease='01234567-89ab-cdef-0123-456789abcdef';
async function host(directory,{fault,existing}={}) {
  const world=await new World(directory).open(),storage=await new Storage(directory,{env:{}}).open();
  if(!existing)await world.put({id:appId,kind:'app',namespace:'os',title:'Fixture',body:JSON.stringify({slug:'fixture',desktop:{entry:'app'},capabilities:['world.read','world.write']})},{writer:'os'});
  const collaboration=new Collaboration({directory,world,storage});
  const migrations=new NamespaceMigrations({directory,world,collaboration,storage,fault});await migrations.recover();await collaboration.recover();
  return{directory,world,storage,collaboration,migrations};
}
async function setup(t,{fault,archived=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'ink-namespace-migration-'));
  const source=await host(join(directory,'source')),target=await host(join(directory,'target'),{fault});
  const owners=[source,target];t.after(async()=>{for(const owner of owners){try{await owner.collaboration.close();}catch{}}await rm(directory,{recursive:true,force:true});});
  await source.world.put({id:objectId,namespace:appId,kind:'note',title:'Causal text',body:'Alpha😀Beta'},{writer:appId});
  const text=await source.collaboration.document(appId,'object:'+objectId,'text');
  const allocated=await source.collaboration.reserveActors({owner:true},appId,text.key,lease,4);
  const edit=new SharedText({actor:allocated.start}), snapshot=await source.collaboration.snapshot(text);await edit.restore({...snapshot,bytes:Buffer.from(snapshot.bytes,'base64')});
  await source.collaboration.submit({owner:true},appId,text.key,'text',edit.splice(5,2,'🙂'),{leaseId:lease});await source.collaboration.projectCommitted(text);
  const state=new SharedState({actor:77n}), updates=[...state.set('/live',{value:9}),...state.set('/deleted','gone'),...state.delete('/deleted')];
  await source.collaboration.submit({owner:true},appId,'state','state',updates);
  const bytes=Buffer.from('bound file exact bytes\n'),blob=await source.storage.put(bytes,'text/plain');await target.storage.put(bytes,'text/plain');
  await source.world.put({id:fileId,namespace:appId,kind:'file',title:'Draft source',body:JSON.stringify({mime:'text/plain',bytes:bytes.length}),location:blob.location,tags:['imported']},{writer:appId});
  await source.collaboration.document(appId,'draft:file','text',{seedFile:fileId});
  const desktop=new SharedState({actor:88n});await source.collaboration.submit({owner:true},'os','desktop','state',desktop.set('/selected/setting',{enabled:true}));
  const baseline=new SharedState({actor:99n});await target.collaboration.submit({owner:true},'os','desktop','state',baseline.set('/bootstrap/setting',true));await target.collaboration.projectCommitted(await target.collaboration.document('os','desktop','state'));
  await target.world.put({id:unrelatedId,namespace:'os',kind:'note',title:'Unselected bootstrap',body:'preserve me'},{writer:'os'});
  if(archived){await source.world.update(objectId,{archived:true},{writer:appId});await source.world.update(fileId,{archived:true},{writer:appId});}
  const versions=new Versions({world:source.world,collaboration:source.collaboration,storage:source.storage});const version=await versions.create({label:'Immutable fixture cut'}),manifest=await versions.read(version.id);
  const sourceVersionCut={id:manifest.id,manifestDigest:hash(JSON.stringify(manifest)),worldVersion:manifest.world.version,core:manifest.world.core,capturedAt:manifest.capturedAt};
  const selected=manifest.documents.filter(doc=>doc.metadata.namespace===appId||doc.metadata.namespace==='os'&&doc.metadata.key==='desktop');
  const request={operation,sourceVersion:manifest,sourceVersionCut,namespaces:[appId,'os'],recordIds:[objectId,fileId],documentIds:selected.map(doc=>doc.metadata.id),bootstrapDocumentIds:[hash('os\0desktop')]};
  const plan=await target.migrations.plan(request);request.expected=plan.expected;
  return{source,target,request,manifest,owners,directory,selected};
}

test('imports real causal checkpoints/tombstones/text/file bindings and exact IDs through a scoped forward World transaction',async t=>{
  const f=await setup(t),baseline=f.target.world.get(unrelatedId),sourceText=await f.source.collaboration.snapshot(await f.source.collaboration.document(appId,'object:'+objectId,'text'));
  const receipt=await f.target.migrations.apply(f.request);assert.equal(receipt.mode,'preserve-causal-snapshots');assert.equal(receipt.documents,4);
  assert.deepEqual(f.target.world.get(unrelatedId),baseline);assert.equal(JSON.parse(f.target.world.get(appId).body).releaseId,undefined);
  const imported=await f.target.collaboration.snapshot(await f.target.collaboration.document(appId,'object:'+objectId,'text'));
  assert.equal(imported.bytes,sourceText.bytes);assert.deepEqual(imported.versions,sourceText.versions);assert.deepEqual(imported.heads,sourceText.heads);assert.equal(imported.text,'Alpha🙂Beta');
  const state=await f.target.collaboration.snapshot(await f.target.collaboration.document(appId,'state','state'));assert.equal(state.registers.find(row=>row.path==='/deleted').deleted,true);assert.deepEqual(JSON.parse(state.registers.find(row=>row.path==='/live').value),{value:9});
  const draft=await f.target.collaboration.document(appId,'draft:file','text');assert.equal(draft.seedFile,fileId);assert.equal(draft.seedRevision,1);assert.equal(await draft.replica.view(),'bound file exact bytes\n');
  assert.deepEqual(Buffer.from(await f.target.storage.get(f.target.world.get(fileId).location)),Buffer.from('bound file exact bytes\n'));
  assert.ok(f.target.world.restorations['namespace:'+operation]);assert.equal((await f.target.migrations.apply(f.request)).replayed,true);
  const sourceUpdates=new SharedState({actor:100n});await f.source.collaboration.submit({owner:true},appId,'independent','state',sourceUpdates.set('/still-running',true));
  assert.equal(f.target.collaboration.documentMetadata.has(hash(appId+'\0independent')),false);
});

test('import survives host reopen and worker reset; new actor allocation avoids all imported actors',async t=>{
  const f=await setup(t);await f.target.migrations.apply(f.request);await f.target.collaboration.close();
  const reopened=await host(f.target.directory,{existing:true});f.owners.splice(f.owners.indexOf(f.target),1,reopened);
  const doc=await reopened.collaboration.document(appId,'object:'+objectId,'text'),before=await reopened.collaboration.snapshot(doc);
  await reopened.collaboration.textWorkers.request(doc.id,'reset');doc.replica.generation=-1;
  assert.equal(await doc.replica.view(),before.text);assert.equal((await reopened.collaboration.snapshot(doc)).bytes,before.bytes);
  const actors=await reopened.collaboration.reserveActors({owner:true},appId,doc.key,'11111111-2222-3333-4444-555555555555',4);
  for(const actor of Object.keys(before.versions))assert.ok(Number(actor)<actors.start||Number(actor)>=actors.start+actors.count);
  const edit=new SharedText({actor:actors.start});await edit.restore({...before,bytes:Buffer.from(before.bytes,'base64')});await reopened.collaboration.submit({owner:true},appId,doc.key,'text',edit.splice(edit.text.length,0,'!'),{leaseId:'11111111-2222-3333-4444-555555555555'});
  assert.equal(await doc.replica.view(),before.text+'!');assert.equal((await f.source.collaboration.snapshot(await f.source.collaboration.document(appId,doc.key,'text'))).text,before.text);
});

test('source membership/content digest, destination drift, bootstrap consent and published target guards fail without clobber',async t=>{
  const f=await setup(t),original=f.target.world.get(unrelatedId);
  await assert.rejects(f.target.migrations.apply({...f.request,mode:'replace-whole-os'}),{status:400});
  await assert.rejects(f.target.migrations.apply({...f.request,records:[]}),{status:400});
  const bad=structuredClone(f.request);bad.sourceVersion.documents[0].snapshot.bytes='AA==';await assert.rejects(f.target.migrations.apply(bad),{status:400});
  const noBootstrap={...f.request,bootstrapDocumentIds:[]};await assert.rejects(f.target.migrations.apply(noBootstrap),{status:409});assert.deepEqual(f.target.world.get(unrelatedId),original);
  await f.target.world.update(unrelatedId,{body:'new owner work'},{writer:'os'});await assert.rejects(f.target.migrations.apply(f.request),{status:409});assert.equal(f.target.world.get(unrelatedId).body,'new owner work');
  f.request.expected=(await f.target.migrations.plan(f.request)).expected;await f.target.world.update(appId,{body:JSON.stringify({slug:'fixture',releaseId:'f'.repeat(32)})},{writer:'os'});await assert.rejects(f.target.migrations.apply(f.request),{status:409});
});

for(const point of ['intent','document','decision'])test('durable '+point+' interruption recovers by World decision before document serving',async t=>{
  let fired=false;const f=await setup(t,{fault:stage=>{if(stage===point&&!fired){fired=true;throw Object.assign(Error('Fixture crash boundary'),{simulateCrash:true});}}});
  await assert.rejects(f.target.migrations.apply(f.request));assert.equal(f.target.migrations.ready,false);
  await assert.rejects(f.target.collaboration.document(appId,'state','state'),{status:503});
  // This models process loss: no active callbacks remain, all old owned journal
  // handles have either been closed by the swap or are explicitly closed here.
  for(const promise of f.target.collaboration.documents.values()){const doc=await promise;clearTimeout(doc.projectTimer);try{await doc.journal.close();}catch{}}
  await f.target.collaboration.textWorkers.close();f.target.collaboration.documents.clear();
  const recovered=await host(f.target.directory,{existing:true});f.owners.splice(f.owners.indexOf(f.target),1,recovered);
  if(point==='decision'){assert.ok(recovered.world.restorations['namespace:'+operation]);assert.equal((await recovered.migrations.apply(f.request)).replayed,true);const doc=await recovered.collaboration.document(appId,'object:'+objectId,'text');assert.equal(await doc.replica.view(),'Alpha🙂Beta');}
  else{assert.equal(recovered.world.get(objectId),null);assert.equal(recovered.collaboration.documentMetadata.has(hash(appId+'\0state')),false);assert.deepEqual((await recovered.collaboration.snapshot(await recovered.collaboration.document('os','desktop','state'))).registers.map(row=>row.path),['/bootstrap/setting']);}
});

test('completed receipt never clobbers later target edits and mismatched operation input conflicts',async t=>{
  const f=await setup(t);await f.target.migrations.apply(f.request);const state=await f.target.collaboration.state({owner:true},'live',appId);await f.target.collaboration.state({owner:true},'live',appId,{value:10},state.revision,true);
  assert.equal((await f.target.migrations.apply(f.request)).replayed,true);assert.deepEqual((await f.target.collaboration.state({owner:true},'live',appId)).value,{value:10});
  const changed={...f.request,bootstrapDocumentIds:[]};await assert.rejects(f.target.migrations.apply(changed),{status:409});
  const blob=f.target.world.get(fileId).location;await f.target.storage.remove(blob);
  assert.equal((await f.target.migrations.apply(f.request)).replayed,true,'a completed receipt does not reread or repair later-deleted blobs');
});

test('ordinary install failure rolls back World/documents before allowing a retry',async t=>{
  let failed=false;const f=await setup(t,{fault:point=>{if(point==='document'&&!failed){failed=true;throw Error('Fixture I/O failure');}}});
  await assert.rejects(f.target.migrations.apply(f.request));assert.equal(f.target.migrations.ready,true);
  assert.equal(f.target.world.get(objectId),null);assert.equal(f.target.world.deleting.size,0);
  assert.deepEqual((await f.target.collaboration.snapshot(await f.target.collaboration.document('os','desktop','state'))).registers.map(row=>row.path),['/bootstrap/setting']);
  assert.equal((await f.target.migrations.apply(f.request)).format,'ink-os-namespace-receipt-v1');
});

test('destination blob bytes and explicit remap digest are verified before any import mutation',async t=>{
  const f=await setup(t),file=f.manifest.world.objects.find(row=>row.id===fileId),before=f.target.world.version;
  const remap={...f.request,locationRemap:{[file.location]:'blob:'+'f'.repeat(64)}};await assert.rejects(f.target.migrations.apply(remap),{status:400});
  await writeFile(join(f.target.directory,'blobs',file.location.slice(5)),'wrong bytes');
  await assert.rejects(f.target.migrations.apply(f.request),{status:409});assert.equal(f.target.world.version,before);assert.equal(f.target.world.get(objectId),null);
});

test('document sidecar symlinks and aggregate staging limits fail without replacing bootstrap data',async t=>{
  const f=await setup(t),path=join(f.target.collaboration.directory,hash('os\0desktop'),'actors.json'),outside=join(f.directory,'protected.json');
  await writeFile(outside,JSON.stringify({version:1,leases:[]}),{mode:0o600});await symlink(outside,path);
  await assert.rejects(f.target.migrations.apply(f.request));assert.equal(await readFile(outside,'utf8'),JSON.stringify({version:1,leases:[]}));assert.equal(f.target.world.get(objectId),null);
  await unlink(path);f.target.migrations.limits.stagedBytes=1;
  await assert.rejects(f.target.migrations.apply(f.request),{status:413});assert.equal(f.target.world.get(objectId),null);
});

test('tampered selected text headers/registers are rejected even if the outer cut hash is recomputed',async t=>{
  const f=await setup(t),bad=structuredClone(f.request),text=bad.sourceVersion.documents.find(doc=>doc.metadata.kind==='text');text.snapshot.text='invented text';bad.sourceVersionCut.manifestDigest=hash(JSON.stringify(bad.sourceVersion));
  await assert.rejects(f.target.migrations.apply(bad),{status:400});assert.equal(f.target.world.get(objectId),null);
  const state=structuredClone(f.request),doc=state.sourceVersion.documents.find(doc=>doc.metadata.kind==='state');doc.snapshot.registers[0].value='"invented value"';state.sourceVersionCut.manifestDigest=hash(JSON.stringify(state.sourceVersion));
  await assert.rejects(f.target.migrations.apply(state),{status:400});
});

test('archived object and file-bound causal drafts stay inaccessible until ordinary restore, then retain exact content',async t=>{
  const f=await setup(t,{archived:true});await f.target.migrations.apply(f.request);
  assert.equal(f.target.world.get(objectId).archived,true);assert.equal(f.target.world.get(fileId).archived,true);
  await assert.rejects(f.target.collaboration.document(appId,'object:'+objectId,'text'),{status:404});
  await assert.rejects(f.target.collaboration.document(appId,'draft:file','text'),{status:404});
  const saved=await f.target.collaboration.captureVersion(()=>f.target.world.captureVersion());
  assert.equal(saved.documents.find(doc=>doc.metadata.key==='draft:file').snapshot.text,'bound file exact bytes\n');
  await f.target.world.update(objectId,{archived:false},{writer:appId});await f.target.world.update(fileId,{archived:false},{writer:appId});
  assert.equal(await(await f.target.collaboration.document(appId,'object:'+objectId,'text')).replica.view(),'Alpha🙂Beta');
  assert.equal(await(await f.target.collaboration.document(appId,'draft:file','text')).replica.view(),'bound file exact bytes\n');
});

test('World core changes use checked logical records while causal checkpoint identity remains strict',async t=>{
  const f=await setup(t),input=structuredClone(f.request);input.sourceVersion.world.core='f'.repeat(64);input.sourceVersionCut.core='f'.repeat(64);input.sourceVersionCut.manifestDigest=hash(JSON.stringify(input.sourceVersion));
  assert.equal((await f.target.migrations.apply(input)).mode,'preserve-causal-snapshots');
  assert.equal(f.target.world.get(objectId).body,'Alpha🙂Beta');
});

test('World persistence failure before its decision restores both the logical state and document baseline',async t=>{
  const f=await setup(t),persist=f.target.world.persist.bind(f.target.world);let failed=false;
  f.target.world.persist=async()=>{if(!failed){failed=true;throw Error('Fixture persist failure');}return persist();};
  await assert.rejects(f.target.migrations.apply(f.request));assert.equal(f.target.world.get(objectId),null);assert.equal(f.target.world.restorations['namespace:'+operation],undefined);
  assert.equal((await f.target.migrations.apply(f.request)).format,'ink-os-namespace-receipt-v1');
});
