import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../sdk/src/server.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>sha(canonical(value));
const hex=(value,n=64)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(value);
const pin=value=>typeof value==='string'&&value.length<=1024&&/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)&&!value.includes('://');
const images=value=>value&&Object.keys(value).sort().join(',')==='os,runtime'&&pin(value.os)&&pin(value.runtime);
const fail=code=>{throw Object.assign(Error(code),{code});};
const check=(value,code)=>{if(!value)fail(code);};
const parse=value=>{try{return JSON.parse(value);}catch{fail('INK_UPGRADE_PROOF_JSON');}};
const bodyOf=value=>parse(value.body);
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const encode=(path,text)=>({path,base64:Buffer.from(text).toString('base64')});
const stateKey='upgraded-canary';

export function upgradedCanaryBundle(nonce){
  check(hex(nonce,32),'INK_UPGRADE_PROOF_NONCE');
  const html='<!doctype html><title>Ink upgrade acceptance</title><p data-proof="'+nonce+'">Private upgrade canary</p>';
  const source=`const marker=${JSON.stringify(nonce)};export async function fetch(request,{ink}){const path=new URL(request.url).pathname;if(path==='/allow-idle'&&request.method==='POST'){await ink.compute.allowIdle();return Response.json({marker,idleAllowed:true});}if(path!=='/count')return new Response(null,{status:404});const state=await ink.state.get('${stateKey}');if(request.method==='POST'){const input=await request.json();if(input.operation!==marker)return new Response(null,{status:400});if(!state.value)await ink.state.set('${stateKey}',{marker,count:1,operation:marker},state.revision);else if(state.value.marker!==marker||state.value.operation!==marker||state.value.count!==1)return new Response(null,{status:409});}else if(request.method!=='GET')return new Response(null,{status:405});const current=await ink.state.get('${stateKey}');return Response.json({marker,count:current.value?.count||0});}`;
  return{commands:[],files:[encode('index.html',html),encode('server/main.mjs',source)],entry:'index.html',backend:{idleSafe:true,entry:'server/main.mjs'}};
}

async function privateParent(file){await mkdir(dirname(file),{recursive:true,mode:0o700});const info=await lstat(dirname(file));check(info.isDirectory()&&!info.isSymbolicLink()&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid())&&await realpath(dirname(file))===dirname(file),'INK_UPGRADE_PROOF_PRIVATE_DIRECTORY');}
async function privateRead(file){const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await handle.stat();check(info.isFile()&&info.nlink===1&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid())&&info.size<=1024*1024,'INK_UPGRADE_PROOF_PRIVATE_FILE');const bytes=await handle.readFile();check(bytes.length===info.size,'INK_UPGRADE_PROOF_PRIVATE_FILE');return parse(bytes);}finally{await handle.close();}}
async function atomicJSON(file,value){
  try{const previous=await privateRead(file);check(previous?.format===value.format,'INK_UPGRADE_PROOF_FILE_IDENTITY');}catch(error){if(error.code!=='ENOENT')throw error;}
  const next=file+'.next-'+randomBytes(8).toString('hex');let handle;
  try{handle=await open(next,'wx',0o600);const bytes=JSON.stringify(value,null,2)+'\n';check(Buffer.byteLength(bytes)<=1024*1024,'INK_UPGRADE_PROOF_JOURNAL_LIMIT');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await rename(next,file);const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}}
  finally{await handle?.close();await unlink(next).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function verifierSources(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),sdkRoot=resolve(root,'sdk/src'),continuation=resolve(root,'shared/continuation.mjs'),pending=[resolve(sdkRoot,'server.js')],found=new Map();let size=0;
  while(pending.length){const path=pending.pop();if(found.has(path))continue;check((path.startsWith(sdkRoot+'/')||path===continuation)&&/\.(?:mjs|js)$/.test(path)&&found.size<32,'INK_UPGRADE_PROOF_SOURCE_GRAPH');const text=await readFile(path,'utf8');size+=Buffer.byteLength(text);check(size<=4*1024*1024,'INK_UPGRADE_PROOF_SOURCE_GRAPH');found.set(path,sha(text));for(const match of text.matchAll(/(?:^|[;\n])\s*(?:import|export)\s*(?:[^;'"\n]*?\bfrom\s*)?['"]([^'"]+)['"]/g)){check(match[1].startsWith('./')||match[1].startsWith('../'),'INK_UPGRADE_PROOF_SOURCE_GRAPH');pending.push(resolve(dirname(path),match[1]));}}
  return{verifierSourceSha256:sha(await readFile(fileURLToPath(import.meta.url))),sdkSourcesSha256:hash(Object.fromEntries([...found].map(([path,digest])=>[relative(root,path),digest]).sort(([a],[b])=>a.localeCompare(b))))};
}
async function boundedResponse(response){let size=0;const chunks=[];for await(const chunk of response.body||[]){size+=chunk.length;check(size<=1024*1024,'INK_UPGRADE_PROOF_RESPONSE_LIMIT');chunks.push(Buffer.from(chunk));}return new Response([204,304].includes(response.status)?null:Buffer.concat(chunks),{status:response.status,headers:response.headers});}

/** Owner mutations are restricted to the nonce-owned canary. No global pool or
 * maintenance mutation is available to this verifier. */
export async function verifyUpgradedHost({url,ownerToken,expectedInstanceId,currentImages,generation,upgradeReceiptSha256,journal:journalFile,output,phase='run',fetch:transport=globalThis.fetch,idleTimeoutMs=180000,pollMs=1000,allowLoopbackHTTP=false}={}){
  const host=new URL(url);
  check(host.pathname==='/'&&!host.search&&!host.hash&&!host.username&&!host.password&&(host.protocol==='https:'||allowLoopbackHTTP&&host.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(host.hostname)),'INK_UPGRADE_PROOF_URL');
  check(typeof ownerToken==='string'&&ownerToken.length>=16&&ownerToken.length<=16384&&!/[\r\n]/.test(ownerToken),'INK_UPGRADE_PROOF_CREDENTIAL');
  check(hex(expectedInstanceId,32)&&images(currentImages)&&Number.isSafeInteger(generation)&&generation>=1&&hex(upgradeReceiptSha256),'INK_UPGRADE_PROOF_BINDING');
  check(typeof journalFile==='string'&&typeof output==='string'&&resolve(journalFile)!==resolve(output)&&['run','cleanup'].includes(phase),'INK_UPGRADE_PROOF_INPUT');
  check(Number.isFinite(idleTimeoutMs)&&idleTimeoutMs>=0&&idleTimeoutMs<=900000&&Number.isFinite(pollMs)&&pollMs>=1&&pollMs<=30000,'INK_UPGRADE_PROOF_TIMEOUT');
  journalFile=resolve(journalFile);output=resolve(output);check(output!==journalFile+'.lock'&&journalFile!==output+'.lock','INK_UPGRADE_PROOF_INPUT');await privateParent(journalFile);await privateParent(output);
  try{check((await privateRead(output))?.format==='ink-os-upgraded-host-proof-v1','INK_UPGRADE_PROOF_FILE_IDENTITY');}catch(error){if(error.code!=='ENOENT')throw error;}
  const sources=await verifierSources(),binding={instanceId:expectedInstanceId,hostOriginSha256:sha(host.origin),images:currentImages,generation,upgradeReceiptSha256,...sources};
  const lock=await open(journalFile+'.lock','wx',0o600).catch(()=>fail('INK_UPGRADE_PROOF_LOCKED'));let journal,stage='journal';
  const save=async changes=>{Object.assign(journal,changes,{updatedAt:new Date().toISOString()});const{digest,...body}=journal;journal={...body,digest:hash(body)};await atomicJSON(journalFile,journal);};
  const fetcher=async(input,init={})=>boundedResponse(await transport(input,{...init,redirect:'manual',signal:AbortSignal.timeout(90000)}));
  const canary=()=>upgradedCanaryBundle(journal.nonce);
  const expectedState=()=>({marker:journal.nonce,count:1,operation:journal.nonce});
  const sdk=createClient({url:host.origin,token:ownerToken,fetch:async(input,init={})=>{
    const target=new URL(input),path=target.pathname.slice('/api/v1/'.length),method=init.method||'GET',body=init.body===undefined?undefined:parse(init.body);
    check(target.origin===host.origin&&target.pathname.startsWith('/api/v1/')&&new Headers(init.headers).get('authorization')==='Bearer '+ownerToken,'INK_UPGRADE_PROOF_OWNER_ORIGIN');
    let allowed=method==='GET'&&target.pathname==='/api/v1/maintenance'&&!target.search;
    if(journal){
      const app='apps/'+journal.appId,release=journal.releaseId;
      if(method==='GET')allowed||=path==='apps'&&target.search==='?archived=true'||path==='runtimes'&&!target.search||path===app+'/status'&&!target.search||release&&path==='runtime/bundle/'+release&&!target.search||release&&path==='data/'+release&&!target.search||journal.sourceAssetId&&path==='assets/'+journal.sourceAssetId&&!target.search||path==='data'&&target.searchParams.size===1&&target.searchParams.get('namespace')===journal.appId||path==='state/'+stateKey&&target.searchParams.size===1&&target.searchParams.get('namespace')===journal.appId;
      else if(method==='POST'){
        if(path==='apps'&&!target.search&&phase==='run')allowed=canonical(body)===canonical({slug:journal.slug,title:journal.title,capabilities:['world.read','world.write'],commands:[]});
        if(path===app+'/releases'&&!target.search&&phase==='run')allowed=canonical(body)===canonical(canary());
        if(release&&path===app+'/releases/'+release+'/publish'&&!target.search&&phase==='run')allowed=canonical(body)==='{}';
        if(path===app+'/launch'&&!target.search&&phase==='run')allowed=canonical(body)==='{}';
        if(path===app+'/invoke'&&!target.search)allowed=canonical(body)===canonical({releaseId:release,path:'/allow-idle',method:'POST'})||phase==='run'&&(canonical(body)===canonical({releaseId:release,path:'/count',method:'POST',body:{operation:journal.nonce}})||canonical(body)===canonical({releaseId:release,path:'/count',method:'GET'}));
      }else if(method==='DELETE'&&path===app)allowed=!target.search||target.search==='?permanent=true';
    }
    check(allowed,'INK_UPGRADE_PROOF_REQUEST_SCOPE');return fetcher(input,init);
  }});
  const inspect=async(strict=true)=>{
    const response=await fetcher(new URL('/api/health',host));check(response.ok,'INK_UPGRADE_PROOF_HEALTH');const health=await response.json();check(health.ok===true&&health.instanceId===expectedInstanceId,'INK_UPGRADE_PROOF_INSTANCE');
    const value=await sdk.request('maintenance');check(value?.format==='ink-os-maintenance-inspection-v1'&&value.instanceId===expectedInstanceId&&hex(value.bootId,32)&&images(value.images)&&value.ready===true&&value.admissionClosed===false&&value.activeOperation===null,'INK_UPGRADE_PROOF_INSPECTION');
    if(strict)check(hash(value.images)===hash(currentImages),'INK_UPGRADE_PROOF_IMAGES');return value;
  };
  const catalog=async()=>{
    const apps=await sdk.apps.list({includeDeleted:true});check(Array.isArray(apps)&&apps.length<=1000&&apps.every(app=>hex(app.id,32))&&new Set(apps.map(app=>app.id)).size===apps.length,'INK_UPGRADE_PROOF_CATALOG');
    const app=apps.find(item=>item.id===journal.appId);
    if(app){const body=bodyOf(app);check(app.title===journal.title&&body.slug===journal.slug&&!body.repository&&!body.projectId&&!body.forkOf&&!body.sourceCommit&&body.code===undefined&&body.projection===undefined&&(!body.releaseId||body.releaseId===journal.releaseId)&&Array.isArray(body.commands)&&body.commands.length===0&&canonical(body.capabilities)===canonical(['world.read','world.write']),'INK_UPGRADE_PROOF_CANARY_IDENTITY');}
    return{app,foreign:apps.filter(item=>item.id!==journal.appId).map(item=>item.id).sort()};
  };
  const runtime=async()=>{
    const result=await sdk.runtimes.list();check(Array.isArray(result.slots)&&result.slots.length<=2000,'INK_UPGRADE_PROOF_RUNTIME');const own=result.slots.filter(slot=>slot.appId===journal.appId);
    check(own.every(slot=>hex(slot.slotId,32)&&slot.releaseId===journal.releaseId&&hex(slot.leaseId,32)&&Number.isSafeInteger(slot.inFlight)&&slot.inFlight>=0&&Array.isArray(slot.holds)),'INK_UPGRADE_PROOF_CANARY_WORKER_IDENTITY');return own;
  };
  const releaseMetadata=(release,app)=>{
    const meta=bodyOf(release),wanted=canary();check(hex(release.id,32)&&meta.appId===journal.appId&&meta.runtimeAuth===2&&canonical(meta.backend)===canonical(wanted.backend)&&canonical(meta.commands)==='[]'&&meta.entry===wanted.entry&&(!journal.releaseId||journal.releaseId===release.id)&&hex(meta.bundleObjectId,32)&&hex(meta.digest)&&typeof meta.bundleLocation==='string'&&/^r2:\/\/[^/]+\/objects\/[a-f0-9]{64}$/.test(meta.bundleLocation)&&meta.bundleLocation.endsWith('/objects/'+meta.digest),'INK_UPGRADE_PROOF_RELEASE_IDENTITY');
    if(meta.deployment){const deployment=meta.deployment,origin=new URL(deployment.url);check(Object.keys(deployment).sort().join(',')==='provider,url'&&deployment.provider==='pool'&&origin.protocol===host.protocol&&origin.origin!==host.origin&&origin.pathname==='/'&&!origin.search&&!origin.hash&&!origin.username&&!origin.password&&origin.hostname.startsWith(release.id+'-')&&(!journal.edgeOriginSha256||journal.edgeOriginSha256===sha(origin.origin)),'INK_UPGRADE_PROOF_DEPLOYMENT_IDENTITY');}
    if(bodyOf(app).releaseId)check(meta.deployment,'INK_UPGRADE_PROOF_DEPLOYMENT_IDENTITY');return meta;
  };
  const quiesce=async app=>{
    stage='quiescence';let slots=await runtime();if(!slots.length)return;
    check(app&&!app.archived&&journal.releaseId,'INK_UPGRADE_PROOF_CANARY_WORKER_PRESERVED');const deadline=Date.now()+idleTimeoutMs;
    while(slots.some(slot=>slot.status!=='ready'||slot.inFlight||slot.holds.length)){check(Date.now()<deadline,'INK_UPGRADE_PROOF_CANARY_WORKER_PRESERVED');await sleep(pollMs);slots=await runtime();if(!slots.length)return;}
    const result=await sdk.request('apps/'+journal.appId+'/invoke',{method:'POST',body:{releaseId:journal.releaseId,path:'/allow-idle',method:'POST'}});assert.deepEqual(result.body,{marker:journal.nonce,idleAllowed:true});
    while((await runtime()).length){check(Date.now()<deadline,'INK_UPGRADE_PROOF_IDLE_TIMEOUT');await sleep(pollMs);}
  };
  const edge=async()=>{
    stage='edge';const launch=await sdk.request('apps/'+journal.appId+'/launch',{method:'POST',body:{}}),origin=new URL(launch.origin),link=new URL(launch.url);
    check(origin.origin!==host.origin&&origin.protocol===host.protocol&&origin.pathname==='/'&&!origin.search&&!origin.hash&&!origin.username&&!origin.password&&link.origin===origin.origin&&link.pathname==='/_ink/launch'&&launch.releaseId===journal.releaseId&&origin.hostname.startsWith(journal.releaseId+'-'),'INK_UPGRADE_PROOF_EDGE_ORIGIN');check(!journal.edgeOriginSha256||journal.edgeOriginSha256===sha(origin.origin),'INK_UPGRADE_PROOF_EDGE_ORIGIN');
    check((await fetcher(origin)).status===401,'INK_UPGRADE_PROOF_EDGE_ANONYMOUS');const redirect=await fetcher(link);check([302,303].includes(redirect.status)&&redirect.headers.get('location')==='/','INK_UPGRADE_PROOF_EDGE_LAUNCH');const cookie=redirect.headers.get('set-cookie')||'';
    check(/^__Host-ink_app_session=[A-Za-z0-9_.-]+;/.test(cookie)&&/;\s*Secure(?:;|$)/i.test(cookie)&&/;\s*HttpOnly(?:;|$)/i.test(cookie)&&/;\s*Path=\/(?:;|$)/i.test(cookie)&&/;\s*SameSite=None(?:;|$)/i.test(cookie)&&/;\s*Partitioned(?:;|$)/i.test(cookie),'INK_UPGRADE_PROOF_EDGE_COOKIE');
    const headers={Cookie:cookie.split(';')[0]},page=await fetcher(origin,{headers});check(page.status===200&&await page.text()===Buffer.from(canary().files[0].base64,'base64').toString(),'INK_UPGRADE_PROOF_EDGE_HTML');check((await fetcher(new URL('/server/main.mjs',origin),{headers})).status===404,'INK_UPGRADE_PROOF_SOURCE_PRIVACY');const backend=await fetcher(new URL('/backend/count',origin),{headers});check(backend.status===200,'INK_UPGRADE_PROOF_EDGE_BACKEND');assert.deepEqual(await backend.json(),{marker:journal.nonce,count:1});await save({edgeVerified:true,edgeOriginSha256:sha(origin.origin)});
  };
  try{
    try{journal=await privateRead(journalFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(journal){const{digest,...body}=journal;check(digest===hash(body)&&journal.format==='ink-os-upgraded-host-journal-v1'&&hash(journal.binding)===hash(binding)&&hex(journal.nonce,32)&&journal.slug==='ink-upgrade-'+journal.nonce.slice(0,24)&&journal.title==='Upgrade acceptance '+journal.nonce&&journal.appId===sha('ink-os-app:'+journal.slug).slice(0,32)&&Array.isArray(journal.initialCatalogIds)&&journal.initialCatalogIds.length<=1000&&journal.initialCatalogIds.every(id=>hex(id,32))&&new Set(journal.initialCatalogIds).size===journal.initialCatalogIds.length&&!journal.initialCatalogIds.includes(journal.appId),'INK_UPGRADE_PROOF_JOURNAL_IDENTITY');
      if(journal.phase==='complete'){check(journal.proof&&journal.proofSha256===hash(journal.proof)&&['passed','cleaned','cleanup-acknowledgement-pending'].includes(journal.proof.status),'INK_UPGRADE_PROOF_JOURNAL_IDENTITY');await atomicJSON(output,journal.proof);return journal.proof;}}
    stage='inspection';const before=await inspect(phase==='run');
    if(!journal){check(phase==='run','INK_UPGRADE_PROOF_JOURNAL_REQUIRED');const nonce=randomBytes(16).toString('hex'),slug='ink-upgrade-'+nonce.slice(0,24);journal={format:'ink-os-upgraded-host-journal-v1',binding,nonce,slug,title:'Upgrade acceptance '+nonce,appId:sha('ink-os-app:'+slug).slice(0,32),phase:'catalog-intent',createdAt:new Date().toISOString(),bootId:before.bootId};const initial=await catalog();check(!initial.app,'INK_UPGRADE_PROOF_CANARY_COLLISION');journal.initialCatalogIds=initial.foreign;await save({});}
    if(phase==='run')check(before.bootId===journal.bootId,'INK_UPGRADE_PROOF_BOOT_CHANGED');
    let{app}=await catalog();const cleanupOnly=phase==='cleanup'||['cleanup-intent','purge-intent'].includes(journal.phase);
    if(!app&&!cleanupOnly){check(!journal.releaseId&&['catalog-intent','create-intent'].includes(journal.phase),'INK_UPGRADE_PROOF_CANARY_MISSING');stage='create';await save({phase:'create-intent'});await sdk.apps.create({slug:journal.slug,title:journal.title,capabilities:['world.read','world.write'],commands:[]});app=(await catalog()).app;check(app,'INK_UPGRADE_PROOF_CREATE');}
    if(app){
      stage='release';check(!app.archived||cleanupOnly,'INK_UPGRADE_PROOF_CANARY_ARCHIVED');const wanted=canary(),status=await sdk.apps.status(journal.appId);check(Array.isArray(status.releases)&&status.releases.length<=1,'INK_UPGRADE_PROOF_RELEASE_IDENTITY');let release=status.releases[0];
      if(!release&&!cleanupOnly){await save({phase:'release-intent'});release=await sdk.request('apps/'+journal.appId+'/releases',{method:'POST',body:wanted});}
      if(release){const meta=releaseMetadata(release,app);
        await save({releaseId:release.id,sourceAssetId:meta.bundleObjectId});assert.deepEqual(await sdk.request('runtime/bundle/'+release.id),wanted);const source=await sdk.assets.get(meta.bundleObjectId);check(sha(source)===meta.digest,'INK_UPGRADE_PROOF_SOURCE_BYTES');assert.deepEqual(parse(Buffer.from(source)),wanted);await save({bundleSha256:sha(JSON.stringify(wanted)),sourceDigest:meta.digest,sourceLocation:meta.bundleLocation});
        if(!cleanupOnly){await save({phase:'publish-intent'});if(bodyOf(app).releaseId!==release.id)await sdk.apps.publish(journal.appId,release.id);app=(await catalog()).app;check(bodyOf(app).releaseId===release.id,'INK_UPGRADE_PROOF_PUBLICATION');stage='invoke';await save({phase:'invoke-intent'});const result=await sdk.request('apps/'+journal.appId+'/invoke',{method:'POST',body:{releaseId:release.id,path:'/count',method:'POST',body:{operation:journal.nonce}}});check(result.status===200,'INK_UPGRADE_PROOF_BACKEND');assert.deepEqual(result.body,{marker:journal.nonce,count:1});const readback=await sdk.request('apps/'+journal.appId+'/invoke',{method:'POST',body:{releaseId:release.id,path:'/count',method:'GET'}});assert.deepEqual(readback.body,{marker:journal.nonce,count:1});const state=await sdk.state.get(stateKey,journal.appId);assert.deepEqual(state.value,expectedState());await save({backendVerified:true,stateSha256:hash(state.value)});await edge();}
      }else check(!journal.releaseId,'INK_UPGRADE_PROOF_RELEASE_MISSING');
    }
    await quiesce(app);stage='cleanup';app=(await catalog()).app;
    if(app){
      const current=await sdk.apps.status(journal.appId);check(Array.isArray(current.releases)&&current.releases.length===(journal.releaseId?1:0),'INK_UPGRADE_PROOF_RELEASE_IDENTITY');if(journal.releaseId){const meta=releaseMetadata(current.releases[0],app);check(meta.bundleObjectId===journal.sourceAssetId&&meta.digest===journal.sourceDigest&&meta.bundleLocation===journal.sourceLocation,'INK_UPGRADE_PROOF_RELEASE_IDENTITY');}
      const namespace=await sdk.data.list({namespace:journal.appId}),document=sha(journal.appId+'\0state');check(Array.isArray(namespace)&&namespace.length<=4&&namespace.every(record=>{if(record.namespace!==journal.appId)return false;if(record.id===journal.sourceAssetId)return record.kind==='file'&&record.tags?.includes('app-source')&&record.location===journal.sourceLocation&&bodyOf(record).digest===journal.sourceDigest;if(record.kind==='state')return record.id===sha(journal.appId+'\0state\0'+stateKey).slice(0,32)&&record.title===stateKey&&hash(bodyOf(record))===hash(expectedState());if(record.kind==='collaboration'){const meta=bodyOf(record);return record.id===document.slice(0,32)&&record.title==='state'&&record.location==='ink-collaboration:'+document&&meta.key==='state'&&meta.kind==='state'&&Number.isSafeInteger(meta.cursor)&&meta.cursor>=0;}return false;}),'INK_UPGRADE_PROOF_NAMESPACE_IDENTITY');if(journal.sourceAssetId)check(namespace.some(record=>record.id===journal.sourceAssetId),'INK_UPGRADE_PROOF_SOURCE_ASSET');
      await save({phase:'cleanup-intent'});if(!app.archived)await sdk.apps.delete(journal.appId);await save({phase:'purge-intent'});const removed=await sdk.request('apps/'+journal.appId+'?permanent=true',{method:'DELETE'});check(removed.deleted===true&&removed.permanent===true&&Number.isSafeInteger(removed.removedBlobs)&&removed.removedBlobs>=0&&(!journal.sourceAssetId||removed.removedBlobs>=1),'INK_UPGRADE_PROOF_SOURCE_CLEANUP');await save({removedBlobs:removed.removedBlobs,purgeAcknowledged:true});
    }
    const final=await catalog();check(!final.app,'INK_UPGRADE_PROOF_CLEANUP');check((await sdk.data.list({namespace:journal.appId})).length===0,'INK_UPGRADE_PROOF_SOURCE_CLEANUP');if(journal.sourceAssetId){let missing=false;try{await sdk.assets.get(journal.sourceAssetId);}catch(error){if(error.status!==404)throw error;missing=true;}check(missing,'INK_UPGRADE_PROOF_SOURCE_CLEANUP');}if(journal.releaseId){let missing=false;try{await sdk.data.get(journal.releaseId);}catch(error){if(error.status!==404)throw error;missing=true;}check(missing,'INK_UPGRADE_PROOF_SOURCE_CLEANUP');}check(!(await runtime()).length,'INK_UPGRADE_PROOF_CANARY_WORKER_PRESERVED');
    stage='final-inspection';const after=await inspect(phase==='run');check(before.bootId===after.bootId&&hash(before.images)===hash(after.images),'INK_UPGRADE_PROOF_BOOT_CHANGED');check(canonical(final.foreign)===canonical(journal.initialCatalogIds),'INK_UPGRADE_PROOF_CONCURRENT_CATALOG_CHANGE');
    const acknowledged=!journal.sourceAssetId||journal.purgeAcknowledged===true&&journal.removedBlobs>=1,status=!acknowledged?'cleanup-acknowledgement-pending':phase==='run'&&journal.backendVerified&&journal.edgeVerified?'passed':'cleaned';
    const proof={format:'ink-os-upgraded-host-proof-v1',status,...binding,bootId:before.bootId,observedImages:before.images,canaryId:journal.appId,releaseId:journal.releaseId||null,bundleSha256:journal.bundleSha256||null,edgeOriginSha256:journal.edgeOriginSha256||null,backendVerified:journal.backendVerified===true,edgeVerified:journal.edgeVerified===true,sourcePrivacyVerified:journal.edgeVerified===true,stateSha256:journal.stateSha256||null,canaryAppsRemaining:0,canaryWorkersRemaining:0,sourceAssetsRemaining:0,sourceDeletionAcknowledged:acknowledged,removedBlobs:journal.removedBlobs||0,catalogIdsUnchanged:true,initialCatalogCount:journal.initialCatalogIds.length,initialCatalogSha256:hash(journal.initialCatalogIds),finalCatalogSha256:hash(final.foreign),foreignMutationRequests:0,completedAt:new Date().toISOString(),scope:'historical-current-generation-runtime-proof',liveAudit:'not-performed',limits:['HTTP authentication and cookie checks do not prove graphical browser behavior.','Only the generated canary backend is exercised; installed app/custom runtime compatibility remains separate.','Catalog identity equality does not attribute concurrent user data changes.','A lost purge acknowledgement cannot prove source deletion and never yields passed acceptance.']};
    await save({phase:'complete',proof,proofSha256:hash(proof)});await atomicJSON(output,proof);return proof;
  }catch(error){const safe={format:'ink-os-upgraded-host-proof-v1',status:'failed',stage,code:error.name==='AssertionError'?'INK_UPGRADE_PROOF_CONTRACT':/^INK_UPGRADE_PROOF_[A-Z0-9_]+$/.test(error.code||'')?error.code:'INK_UPGRADE_PROOF_REQUEST',journalRetained:true};await atomicJSON(output,safe);throw Object.assign(Error(safe.code),{code:safe.code,stage});}
  finally{await lock.close();await unlink(journalFile+'.lock');}
}
