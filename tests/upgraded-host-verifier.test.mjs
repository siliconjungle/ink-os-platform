import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat, realpath, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyUpgradedHost } from '../scripts/verify-upgraded-host.mjs';
import edgeWorker, { sign } from '../infra/edge/worker.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const owner='fixture-private-upgrade-owner',edgeToken='fixture-private-upgrade-edge';
const instanceId='1'.repeat(32),foreignId='f'.repeat(32),archivedId='e'.repeat(32);
const image=(name,n)=>'example.test/'+name+'@sha256:'+n.repeat(64);
const images={os:image('os','a'),runtime:image('runtime','b')};
async function fixture(t,{lose,busy=false,reuse=false,inspectionImages=images,healthInstance=instanceId}={}){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'ink-upgraded-host-'))),journal=join(directory,'journal.json'),output=join(directory,'proof.json');
  const apps=new Map([[foreignId,{id:foreignId,title:'Existing busy app',namespace:'os',kind:'app',body:JSON.stringify({slug:'existing-busy',releaseId:'d'.repeat(32),commands:[{id:'paid',effect:'paid'}]})}],[archivedId,{id:archivedId,title:'Archived user app',archived:true,body:JSON.stringify({slug:'archived-app'})}]]);
  const records=new Map([['9'.repeat(32),{id:'9'.repeat(32),namespace:foreignId,kind:'state',title:'Do not change',body:'{"credits":37}',tags:[]}]]),foreignData=JSON.stringify([...records.values()]),foreignApps=JSON.stringify([...apps.values()]);
  const foreignSlot={slotId:'8'.repeat(32),appId:foreignId,releaseId:'d'.repeat(32),leaseId:'7'.repeat(32),status:'ready',inFlight:2,holds:[{id:'owner-held',label:'Running paid job'}]},foreignSlotBytes=JSON.stringify(foreignSlot);
  const releases=new Map(),objects=new Map(),state=new Map(),mutations=[],invocations=[],ownerRequests=[],calls=[];
  const model={images:structuredClone(inspectionImages),bootId:'3'.repeat(32),healthInstance,ready:true,admissionClosed:false,activeOperation:null,slot:null,idleAllowed:false,idlePolls:0,lost:false,busy,reuse,purges:0};
  let backend,sourceBytes,bundle,sourceAssetId,canaryId;
  const env={EDGE_TOKEN:edgeToken,APP_DOMAIN:'example.test',APP_HOST_SUFFIX:'inkos-upgrade-proof',ASSETS:{get:async key=>objects.has(key)?new Response(objects.get(key)):null,put:async(key,value)=>objects.set(key,value)}};
  const json=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
  async function invoke(appId,input){
    assert.notEqual(appId,foreignId,'foreign app backend must never be invoked');assert.equal(appId,canaryId);invocations.push({appId,path:input.path,method:input.method});
    model.slot={slotId:'4'.repeat(32),appId,releaseId:'2'.repeat(32),leaseId:'5'.repeat(32),status:'ready',inFlight:0,holds:model.busy?[{id:'canary-held'}]:[]};
    const ink={state:{get:async key=>({namespace:appId,key,value:state.get(key)||null,revision:state.has(key)?1:0}),set:async(key,value,expected)=>{assert.equal(expected,state.has(key)?1:0);state.set(key,value);const id=hash(appId+'\0state\0'+key).slice(0,32),document=hash(appId+'\0state');records.set(id,{id,namespace:appId,kind:'state',title:key,tags:[],body:JSON.stringify(value)});records.set(document.slice(0,32),{id:document.slice(0,32),namespace:appId,kind:'collaboration',title:'state',tags:[],body:JSON.stringify({key:'state',kind:'state',cursor:1}),location:'ink-collaboration:'+document});return{value,revision:1};}},compute:{allowIdle:async()=>{assert.equal(model.busy,false);model.idleAllowed=true;}}};
    const result=await backend.fetch(new Request('https://backend.test'+input.path,{method:input.method||'GET',...(input.body===undefined?{}:{body:JSON.stringify(input.body),headers:{'Content-Type':'application/json'}})}),{ink});
    return{status:result.status,headers:Object.fromEntries(result.headers),body:await result.json()};
  }
  const server=createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://fixture');let input;const chunks=[];for await(const chunk of request)chunks.push(chunk);if(chunks.length)input=JSON.parse(Buffer.concat(chunks));
      calls.push({path:url.pathname,method:request.method,authorization:request.headers.authorization});
      if(url.pathname==='/api/health'){assert.equal(request.headers.authorization,undefined);return json(response,{ok:true,instanceId:model.healthInstance});}
      if(url.pathname==='/_ink/edge/invoke'){assert.equal(request.headers.authorization,'Bearer '+edgeToken);return json(response,await invoke(input.appId,input));}
      assert.equal(request.headers.authorization,'Bearer '+owner);ownerRequests.push(url.pathname);
      const path=url.pathname.slice('/api/v1/'.length),method=request.method;
      if(method!=='GET')mutations.push({path,method,input});
      if(path==='maintenance')return json(response,{format:'ink-os-maintenance-inspection-v1',instanceId,bootId:model.bootId,images:model.images,admissionClosed:model.admissionClosed,activeOperation:model.activeOperation,ready:model.ready});
      if(path==='apps'&&method==='GET')return json(response,[...apps.values()]);
      if(path==='runtimes'){
        if(model.idleAllowed&&++model.idlePolls>=2&&!model.busy&&model.slot?.appId===canaryId)model.slot=model.reuse?{...foreignSlot,slotId:model.slot.slotId}:{slotId:model.slot.slotId,appId:null,releaseId:null,leaseId:null,status:'idle',inFlight:0,holds:[]};
        return json(response,{slots:[foreignSlot,...(model.slot?[model.slot]:[])]});
      }
      if(path==='apps'&&method==='POST'){
        const intent=JSON.parse(await readFile(journal));assert.equal(intent.phase,'create-intent');assert.deepEqual(intent.initialCatalogIds,[archivedId,foreignId]);
        assert.equal(input.slug,intent.slug);canaryId=hash('ink-os-app:'+input.slug).slice(0,32);assert.equal(canaryId,intent.appId);
        const app={id:canaryId,title:input.title,namespace:'os',kind:'app',body:JSON.stringify({slug:input.slug,capabilities:input.capabilities,commands:input.commands})};apps.set(canaryId,app);
        if(lose==='create'&&!model.lost){model.lost=true;return response.destroy();}return json(response,app,201);
      }
      const appId=path.split('/')[1],app=apps.get(appId);if(appId===foreignId&&method!=='GET')assert.fail('foreign mutation');
      if(path==='apps/'+appId+'/status')return app?json(response,{app,releases:[...releases.values()].filter(release=>JSON.parse(release.body).appId===appId)}):json(response,{error:'Missing'},404);
      if(path==='apps/'+appId+'/releases'&&method==='POST'){
        assert.equal(appId,canaryId);bundle=input;sourceBytes=Buffer.from(JSON.stringify(bundle));const digest=hash(sourceBytes),id='2'.repeat(32);sourceAssetId='6'.repeat(32);
        const record={id:sourceAssetId,namespace:appId,kind:'file',title:'App source '+digest.slice(0,12),tags:['app-source','release'],body:JSON.stringify({digest}),location:'r2://fixture/objects/'+digest};records.set(sourceAssetId,record);objects.set('objects/'+digest,sourceBytes);backend=await import('data:text/javascript;base64,'+bundle.files.find(file=>file.path==='server/main.mjs').base64);
        const release={id,body:JSON.stringify({appId,digest,runtimeAuth:2,commands:bundle.commands,backend:bundle.backend,entry:bundle.entry,bundleObjectId:sourceAssetId,bundleLocation:record.location})};releases.set(id,release);if(lose==='release'&&!model.lost){model.lost=true;return response.destroy();}return json(response,release,201);
      }
      if(path.startsWith('runtime/bundle/'))return json(response,bundle);
      if(path.startsWith('assets/'))return records.has(path.slice(7))?(response.writeHead(200),response.end(sourceBytes)):json(response,{error:'Missing'},404);
      if(path.endsWith('/publish')){assert.equal(appId,canaryId);const id=path.split('/')[3],meta=JSON.parse(releases.get(id).body);meta.deployment={provider:'pool',url:'http://'+id+'-'+env.APP_HOST_SUFFIX+'.'+env.APP_DOMAIN};releases.get(id).body=JSON.stringify(meta);app.body=JSON.stringify({...JSON.parse(app.body),releaseId:id});objects.set('edge/releases/'+id+'.json',JSON.stringify({appId,releaseId:id,digest:meta.digest,backend:bundle.backend,entry:bundle.entry}));if(lose==='publish'&&!model.lost){model.lost=true;return response.destroy();}return json(response,app);}
      if(path.endsWith('/invoke')){const result=await invoke(appId,input);if(lose==='invoke'&&input.path==='/count'&&!model.lost){model.lost=true;return response.destroy();}return json(response,result);}
      if(path.startsWith('state/')){assert.equal(url.searchParams.get('namespace'),canaryId);return json(response,{value:state.get(decodeURIComponent(path.slice(6)))||null,revision:state.size?1:0});}
      if(path.endsWith('/launch')){const releaseId=JSON.parse(app.body).releaseId,origin='http://'+releaseId+'-'+env.APP_HOST_SUFFIX+'.'+env.APP_DOMAIN,ticket=await sign({kind:'launch',appId,releaseId,exp:Date.now()+60000},edgeToken);return json(response,{releaseId,origin,url:origin+'/_ink/launch?ticket='+ticket});}
      if(path==='data')return json(response,[...records.values()].filter(record=>record.namespace===url.searchParams.get('namespace')));
      if(path.startsWith('data/')){const record=records.get(path.slice(5))||releases.get(path.slice(5));return record?json(response,record):json(response,{error:'Missing'},404);}
      if(path==='apps/'+appId&&method==='DELETE'){
        assert.equal(appId,canaryId);assert.notEqual(model.slot?.appId,canaryId,'only own naturally idle canary can be deleted');
        if(!url.searchParams.has('permanent')){app.archived=true;if(lose==='archive'&&!model.lost){model.lost=true;return response.destroy();}return json(response,app);}
        apps.delete(appId);for(const[id,record]of records)if(record.namespace===appId)records.delete(id);for(const[id,release]of releases)if(JSON.parse(release.body).appId===appId)releases.delete(id);state.clear();objects.delete('objects/'+hash(sourceBytes));objects.delete('edge/releases/'+'2'.repeat(32)+'.json');model.purges++;await model.afterPurge?.();if(lose==='purge'&&!model.lost){model.lost=true;return response.destroy();}return json(response,{deleted:true,permanent:true,removedBlobs:1});
      }
      json(response,{error:'Unexpected fixture request'},404);
    }catch(error){json(response,{error:error.message},500);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;env.OS_ORIGIN=url;
  const transport=async(input,init={})=>{const target=new URL(input);if(target.hostname.endsWith('.example.test')){assert.equal(new Headers(init.headers).get('authorization'),null);return edgeWorker.fetch(new Request(input,init),env);}return fetch(input,init);};
  t.after(async()=>{await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});});
  const options={url,ownerToken:owner,expectedInstanceId:instanceId,currentImages:images,generation:1,upgradeReceiptSha256:'a'.repeat(64),journal,output,fetch:transport,idleTimeoutMs:30,pollMs:1,allowLoopbackHTTP:true};
  const preserved=()=>{assert.equal(JSON.stringify([...apps.values()].filter(app=>[foreignId,archivedId].includes(app.id))),foreignApps);assert.equal(JSON.stringify([...records.values()].filter(record=>record.namespace===foreignId)),foreignData);assert.equal(JSON.stringify(foreignSlot),foreignSlotBytes);assert.ok(invocations.every(item=>item.appId===canaryId));assert.ok(mutations.every(item=>item.path==='apps'||item.path.startsWith('apps/'+canaryId)));};
  return{options,model,apps,records,releases,state,mutations,invocations,ownerRequests,calls,directory,journal,output,preserved};
}

test('actual owner SDK and edge Worker verify a nonempty upgraded host while preserving busy foreign app/data/workers',async t=>{
  const f=await fixture(t,{reuse:true}),proof=await verifyUpgradedHost(f.options);assert.equal(proof.status,'passed');assert.equal(proof.generation,1);assert.deepEqual(proof.images,images);assert.equal(proof.upgradeReceiptSha256,f.options.upgradeReceiptSha256);assert.equal(proof.bootId,f.model.bootId);assert.equal(proof.initialCatalogCount,2);assert.equal(proof.sourceDeletionAcknowledged,true);assert.equal(proof.canaryWorkersRemaining,0);assert.equal(proof.catalogIdsUnchanged,true);assert.match(proof.sdkSourcesSha256,/^[a-f0-9]{64}$/);f.preserved();assert.equal(f.apps.size,2);assert.equal(f.records.size,1);assert.equal(f.model.slot.appId,foreignId);
  const text=await readFile(f.output,'utf8');for(const secret of[owner,edgeToken,f.options.url])assert.ok(!text.includes(secret));assert.equal((await stat(f.journal)).mode&0o777,0o600);
  const before=f.calls.length;assert.deepEqual(await verifyUpgradedHost({...f.options,fetch:()=>assert.fail('completed replay is historical')}),proof);assert.equal(f.calls.length,before);
});

for(const lose of ['create','release','publish','invoke','archive','purge'])test('lost '+lose+' reply resumes only its owned canary and never duplicates a release or foreign mutation',async t=>{
  const f=await fixture(t,{lose});await assert.rejects(verifyUpgradedHost(f.options));const first=JSON.parse(await readFile(f.journal)),proof=await verifyUpgradedHost(f.options);
  assert.equal(proof.canaryId,first.appId);assert.equal(proof.status,lose==='purge'?'cleanup-acknowledgement-pending':'passed');assert.equal(proof.sourceDeletionAcknowledged,lose!=='purge');assert.equal(f.mutations.filter(item=>item.path==='apps').length,1);assert.equal(f.mutations.filter(item=>item.path.endsWith('/releases')).length,1);assert.equal(f.model.purges,1);f.preserved();assert.equal(f.apps.size,2);
  if(lose==='purge')assert.equal((await verifyUpgradedHost({...f.options,fetch:()=>assert.fail('pending acknowledgement replay is historical')})).status,'cleanup-acknowledgement-pending');
});

test('wrong public instance never receives owner credentials and wrong current images block all writes',async t=>{
  const wrong=await fixture(t,{healthInstance:'9'.repeat(32)});await assert.rejects(verifyUpgradedHost(wrong.options),{code:'INK_UPGRADE_PROOF_INSTANCE'});assert.equal(wrong.ownerRequests.length,0);assert.deepEqual(wrong.mutations,[]);
  const imagesMismatch=await fixture(t,{inspectionImages:{...images,runtime:image('foreign','e')}});await assert.rejects(verifyUpgradedHost(imagesMismatch.options),{code:'INK_UPGRADE_PROOF_IMAGES'});assert.deepEqual(imagesMismatch.mutations,[]);imagesMismatch.preserved();
  const closed=await fixture(t);closed.model.admissionClosed=true;await assert.rejects(verifyUpgradedHost(closed.options),{code:'INK_UPGRADE_PROOF_INSPECTION'});assert.deepEqual(closed.mutations,[]);
});

test('busy canary is preserved without global reap or foreign worker guards; explicit cleanup can finish later',async t=>{
  const f=await fixture(t,{busy:true});await assert.rejects(verifyUpgradedHost(f.options),{code:'INK_UPGRADE_PROOF_CANARY_WORKER_PRESERVED'});assert.equal(f.apps.size,3);assert.equal(f.mutations.filter(item=>item.method==='DELETE').length,0);assert.equal(f.model.idleAllowed,false);f.preserved();
  f.model.busy=false;f.model.slot.holds=[];const proof=await verifyUpgradedHost({...f.options,phase:'cleanup'});assert.equal(proof.status,'cleaned');assert.equal(f.apps.size,2);f.preserved();
});

test('explicit cleanup on a changed image/boot removes only owned remnants and never passes acceptance',async t=>{
  const f=await fixture(t,{lose:'invoke'});await assert.rejects(verifyUpgradedHost(f.options));f.model.images={...images,os:image('new-os','e')};f.model.bootId='9'.repeat(32);
  const before=f.mutations.length;await assert.rejects(verifyUpgradedHost(f.options),{code:'INK_UPGRADE_PROOF_IMAGES'});assert.equal(f.mutations.length,before);
  const proof=await verifyUpgradedHost({...f.options,phase:'cleanup'});assert.equal(proof.status,'cleaned');assert.deepEqual(proof.images,images);assert.deepEqual(proof.observedImages,f.model.images);f.preserved();
});

test('final image/boot changes and concurrent foreign catalog changes cannot produce passed proof',async t=>{
  for(const change of [f=>f.model.bootId='9'.repeat(32),f=>f.model.images={...images,runtime:image('new-runtime','e')},f=>f.apps.set('a'.repeat(32),{id:'a'.repeat(32),title:'Concurrent owner app',body:'{"slug":"concurrent"}'})]){
    const f=await fixture(t);f.model.afterPurge=()=>change(f);await assert.rejects(verifyUpgradedHost(f.options));assert.equal(JSON.parse(await readFile(f.output)).status,'failed');assert.equal(f.model.purges,1);f.preserved();
  }
});

test('changed canary identity, foreign release or namespace content blocks destructive cleanup',async t=>{
  const f=await fixture(t,{lose:'create'});await assert.rejects(verifyUpgradedHost(f.options));const app=[...f.apps.values()].find(app=>![foreignId,archivedId].includes(app.id));app.title='Foreign replacement';await assert.rejects(verifyUpgradedHost({...f.options,phase:'cleanup'}),{code:'INK_UPGRADE_PROOF_CANARY_IDENTITY'});assert.equal(f.mutations.filter(item=>item.method==='DELETE').length,0);
  const g=await fixture(t,{lose:'invoke'});await assert.rejects(verifyUpgradedHost(g.options));const intent=JSON.parse(await readFile(g.journal));g.records.set('b'.repeat(32),{id:'b'.repeat(32),namespace:intent.appId,kind:'file',title:'Unexpected owner data',tags:[],body:'{}'});await assert.rejects(verifyUpgradedHost({...g.options,phase:'cleanup'}),{code:'INK_UPGRADE_PROOF_NAMESPACE_IDENTITY'});assert.equal(g.mutations.filter(item=>item.method==='DELETE').length,0);g.preserved();
  for(const corrupt of [meta=>meta.backend.runtimeImage=image('foreign-runtime','e'),meta=>meta.deployment.legacy={provider:'fly',url:'https://foreign.example.test'},meta=>meta.deployment.url='http://foreign.example.test']){
    const h=await fixture(t,{lose:'invoke'});await assert.rejects(verifyUpgradedHost(h.options));const release=[...h.releases.values()][0],meta=JSON.parse(release.body);corrupt(meta);release.body=JSON.stringify(meta);await assert.rejects(verifyUpgradedHost({...h.options,phase:'cleanup'}));assert.equal(h.mutations.filter(item=>item.method==='DELETE').length,0);h.preserved();
  }
});

test('journal binding, private permissions, symlinks and locks reject before mutation',async t=>{
  const f=await fixture(t,{lose:'create'});await assert.rejects(verifyUpgradedHost(f.options));const count=f.mutations.length;
  await assert.rejects(verifyUpgradedHost({...f.options,generation:2}),{code:'INK_UPGRADE_PROOF_JOURNAL_IDENTITY'});await assert.rejects(verifyUpgradedHost({...f.options,upgradeReceiptSha256:'b'.repeat(64)}),{code:'INK_UPGRADE_PROOF_JOURNAL_IDENTITY'});assert.equal(f.mutations.length,count);
  await chmod(f.journal,0o644);await assert.rejects(verifyUpgradedHost(f.options),{code:'INK_UPGRADE_PROOF_PRIVATE_FILE'});await chmod(f.journal,0o600);
  await writeFile(f.journal+'.lock','reserved',{mode:0o600});await assert.rejects(verifyUpgradedHost(f.options),{code:'INK_UPGRADE_PROOF_LOCKED'});await rm(f.journal+'.lock');
  const original=await readFile(f.journal);await rm(f.journal);const other=join(f.directory,'other.json');await writeFile(other,original,{mode:0o600});await symlink(other,f.journal);await assert.rejects(verifyUpgradedHost(f.options));assert.equal(f.mutations.length,count);f.preserved();
});

test('bounded responses and invalid explicit bindings are rejected before any host write',async t=>{
  const f=await fixture(t);await assert.rejects(verifyUpgradedHost({...f.options,generation:0}),{code:'INK_UPGRADE_PROOF_BINDING'});await assert.rejects(verifyUpgradedHost({...f.options,fetch:async()=>new Response('x'.repeat(1024*1024+1))}),{code:'INK_UPGRADE_PROOF_RESPONSE_LIMIT'});assert.deepEqual(f.mutations,[]);f.preserved();
});

test('cleanup cannot pass with orphan release metadata and output cannot overwrite private credentials',async t=>{
  const orphan=await fixture(t);orphan.model.afterPurge=()=>orphan.releases.set('2'.repeat(32),{id:'2'.repeat(32),body:'{"orphan":true}'});await assert.rejects(verifyUpgradedHost(orphan.options),{code:'INK_UPGRADE_PROOF_SOURCE_CLEANUP'});orphan.preserved();
  const output=await fixture(t),secret=JSON.stringify({format:'ink-cloud-secrets-v1',ownerToken:'do-not-overwrite-private-token'});await writeFile(output.output,secret,{mode:0o600});await assert.rejects(verifyUpgradedHost(output.options),{code:'INK_UPGRADE_PROOF_FILE_IDENTITY'});assert.equal(await readFile(output.output,'utf8'),secret);assert.equal(output.mutations.length,0);output.preserved();
});
