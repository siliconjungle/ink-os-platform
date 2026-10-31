import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LocalProvider } from '../infra/local-provider.mjs';
import { unboundDeployment } from './provider-bindings.mjs';

const fail=(code,message,status=503)=>{throw Object.assign(Error(message),{code,status});};
const check=(condition,code,message,status)=>{if(!condition)fail(code,message,status);};
const terminal=new Set(['succeeded','failed','cancelled','interrupted']);
const nativeStates=new Set(['queued','running','recovering','succeeded','failed','interrupted']);
const nativeActive=new Set(['queued','running','recovering']);
const pin=value=>typeof value==='string'&&value.length<=1024&&/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)&&!value.includes('://');
const counter=value=>{check(Number.isSafeInteger(value)&&value>=0,'MAINTENANCE_COUNTER_UNVERIFIED','Host activity counter could not be verified');return value;};
const sum=values=>values.reduce((total,value)=>total+counter(value),0);
const values=collection=>collection instanceof Map||collection instanceof Set?[...collection.values()]:[];
const ref=value=>typeof value==='function'?value():value;
const promise=value=>value&&typeof value.then==='function';
const allZero=activity=>Object.values(activity).every(value=>value===0);
const unchanged=()=>fail('MAINTENANCE_ACTIVITY_CHANGED','Host activity changed while checkpointing; continue draining admitted work',409);

/** Admission and checkpoint proof adapter; worker lifecycle stays owned by the
 * runtime pool. HTTP/WS authentication must consult externalClosed. */
export function createMaintenanceHostAdapter({platform,world=platform?.world,storage=platform?.storage,code=platform?.code,requests,responses,sockets,externalClosed}={}){
  check(platform&&world&&typeof world.persist==='function'&&typeof world.transact==='function'&&typeof externalClosed==='function','MAINTENANCE_ADAPTER_CONFIG','Provide live host stores, tracked requests and the external admission gate');
  check(requests instanceof Set||typeof requests==='function','MAINTENANCE_ADAPTER_CONFIG','Provide tracked ordinary HTTP request tasks');
  check(responses instanceof Set||typeof responses==='function','MAINTENANCE_ADAPTER_CONFIG','Provide tracked ordinary HTTP responses');
  const observations=new WeakMap();let closed=false,backgroundError=false;
  if(platform.provider instanceof LocalProvider)platform.provider.bindAdmission(externalClosed);
  function observation(task){if(!promise(task))return null;let state=observations.get(task);if(!state){state={state:'pending'};observations.set(task,state);task.then(value=>{state.state='fulfilled';state.value=value;},()=>{state.state='rejected';});}return state;}
  async function pending(tasks){const states=[...new Set(tasks.filter(Boolean))].map(task=>{check(promise(task),'MAINTENANCE_QUEUE_UNVERIFIED','Host mutation queue has an unsupported shape');return observation(task);});await nextTurn();check(states.every(state=>state.state!=='rejected'),'MAINTENANCE_QUEUE_FAILED','An admitted host task failed before its durable completion');return states.filter(state=>state.state==='pending').length;}
  function tracked(value,label){const current=ref(value);check(current instanceof Set,'MAINTENANCE_TRACKING_UNVERIFIED','Ordinary HTTP '+label+' tracking is unavailable');return current;}
  function pool(){return platform.provider?.pool;}
  function queues(){const c=platform.collaboration,p=platform.projects,runtime=platform.runtime,compute=pool();return{
    publications:[platform.publishTail,...values(platform.releaseTails),...values(p?.operations)],
    writers:[world.tail,platform.keysTail,runtime?.tail,platform.apiKeys?.tail,platform.environment?.tail,p?.tail,p?.publisher?.tail,p?.credentials?.store?.tail,platform.versions?.tail,platform.desktopActions?.tail,platform.nativeJobs?.tail,platform.workflows?.tail,platform.schedules?.tail,platform.fileDefaultsPending,c?.indexing,c?.versionTail,...values(c?.objectTails),...values(c?.documents),platform.namespaceMigrations?.tail,platform.automationMigrations?.tail,storage?.aliases?.tail,...values(storage?.blobTails),compute?.tail],
    code:[...values(code?.tasks),...values(code?.compilations),...values(platform.nativeJobs?.native?.compilations)],
    assignments:[...values(compute?.pending),...values(compute?.retiring),compute?.reaping,compute?.maintenanceTask],
    native:[platform.nativeJobs?.pumping,platform.nativeJobs?.native?.tail],
  };}
  function documents(){const result=[];for(const item of values(platform.collaboration?.documents)){if(promise(item)){const state=observation(item);if(state?.state==='fulfilled')result.push(state.value);}else if(item)result.push(item);}return result;}
  async function healthy(){
    for(const service of[platform.namespaceMigrations,platform.automationMigrations])if(service)check(service.ready===true,'MAINTENANCE_MIGRATION_UNREADY','A migration needs recovery before maintenance');
    check(!platform.collaboration?.migrationBlocked?.size&&!platform.workflows?.migrationBlocked&&!platform.schedules?.migrationBlocked,'MAINTENANCE_MIGRATION_BLOCKED','A migration still holds its destination admission gates');
    if(storage?.aliases)check(storage.aliases.ready===true,'MAINTENANCE_ALIASES_UNREADY','Storage aliases need recovery before maintenance');
    check(!backgroundError&&!platform.nativeJobs?.error,'MAINTENANCE_BACKGROUND_FAILED','An admitted background queue needs review');
    const root=world.directory||platform.directory;check(typeof root==='string','MAINTENANCE_DIRECTORY_UNVERIFIED','Private host directory could not be verified');
    for(const name of['namespace-migrations/pending.json','automation-migrations/pending.json','restoration/pending.json','storage-aliases.lock']){try{await lstat(join(root,name));fail('MAINTENANCE_PENDING_WAL','A private migration or storage journal still needs recovery');}catch(error){if(error.code!=='ENOENT')throw error;}}
    for(const doc of documents())check(!doc.writeError&&!doc.deleted,'MAINTENANCE_DOCUMENT_UNREADY','A collaborative journal needs recovery');
  }
  function startAccepted(){
    if(platform.workflows?.runs?.some(run=>run.status==='queued')&&!platform.workflows.pumping)Promise.resolve(platform.workflows.pump()).catch(()=>{backgroundError=true;});
    const jobs=platform.nativeJobs;if(jobs?.jobs?.some(job=>nativeActive.has(job.status))&&!jobs.pumping)Promise.resolve(jobs.pump()).catch(()=>{backgroundError=true;});
  }
  async function markerCount(map){let unknown=0;const tasks=[];for(const marker of values(map)){const task=promise(marker)?marker:marker?.promise;if(task)tasks.push(task);else unknown++;}return unknown+await pending(tasks);}
  async function activity(){
    await healthy();if(closed)startAccepted();const q=queues();const requestTasks=[...tracked(requests,'request'),...values(platform.provider?.requests)];
    const [http,publicationCount,writerCount,codeCount,assignmentCount,nativeCount,workflowWorkers,scheduleWorkers]=await Promise.all([pending(requestTasks),pending(q.publications),pending(q.writers),pending(q.code),pending(q.assignments),pending(q.native),markerCount(platform.workflows?.active),markerCount(platform.schedules?.active)]);
    const c=platform.collaboration,compute=pool(),jobs=platform.nativeJobs?.jobs||[];check(jobs.every(job=>nativeStates.has(job.status)),'MAINTENANCE_NATIVE_QUEUE_UNVERIFIED','Native queue contains an unsupported state');
    await healthy();const docTasks=documents().map(doc=>doc.tail);const docWriters=await pending(docTasks);let projectTimers=0;for(const doc of documents())if(doc.projectTimer&&!doc.projectTimer._destroyed)projectTimers++;
    let transports=0;for(const response of new Set([...tracked(responses,'response'),...values(platform.provider?.responses)]))if(!response.destroyed&&!response.writableEnded&&!response.writableFinished)transports++;
    // Fetch the optional WS ref so a late/throwing integration cannot go unnoticed.
    const ws=ref(sockets);if(ws!==undefined&&ws!==null)check(ws.clients instanceof Set,'MAINTENANCE_WS_UNVERIFIED','WebSocket tracking is unavailable');
    return{
      requests:http+transports,
      writers:writerCount+docWriters+projectTimers+counter(c?.activeMessages??0)+sum(values(platform.runtime?.writers))+counter(platform.runtime?.draining?.size||0)+counter(world.deleting?.size||0)+counter(world.deletingNamespaces?.size||0)+sum(values(storage?.inflight)),
      publications:publicationCount+sum(values(platform.runtime?.candidates)),
      workflows:workflowWorkers+counter(platform.workflows?.pumping?1:0)+counter(platform.workflows?.runs?.filter(run=>!terminal.has(run.status)).length||0)+counter(platform.workflows?.pendingProjection?.size||0),
      schedules:scheduleWorkers+counter(platform.schedules?.ticking?1:0)+counter(platform.schedules?.runs?.filter(run=>!terminal.has(run.status)).length||0),
      nativeJobs:nativeCount+jobs.filter(job=>nativeActive.has(job.status)).length,
      codeTasks:codeCount,
      poolAssignments:assignmentCount+counter(compute?.admissions?.size||0),
      poolRequests:sum(values(compute?.requests)),
    };
  }
  function external(expected){check(closed&&externalClosed()===expected,'MAINTENANCE_ADMISSION_MISMATCH','Maintenance admission gates disagree',409);}
  function closeAdmission({poolClosed=false}={}){check(typeof poolClosed==='boolean','MAINTENANCE_ADAPTER_CONFIG','Choose an explicit pool admission state');closed=true;platform.schedules?.close();platform.workflows?.close();if(platform.nativeJobs)platform.nativeJobs.accepting=!poolClosed;
    for(const response of tracked(responses,'response'))if(String(response.getHeader?.('content-type')||'').startsWith('text/event-stream')&&!response.writableEnded)response.end();
    if(poolClosed&&pool())pool().admissionClosed=true;
  }
  function releasePool(){const compute=pool();if(!compute)return;if(typeof compute.releaseMaintenance==='function')compute.releaseMaintenance();else check(compute.admissionClosed!==true,'MAINTENANCE_POOL_UNSUPPORTED','This pool cannot release its maintenance gate');}
  function continueDraining(){external(true);releasePool();if(platform.nativeJobs)platform.nativeJobs.accepting=true;}
  function resumeAdmission(){check(externalClosed()===false,'MAINTENANCE_ADMISSION_MISMATCH','External maintenance admission is still closed',409);releasePool();closed=false;if(platform.nativeJobs)platform.nativeJobs.accepting=true;platform.workflows?.start();platform.schedules?.start();}
  async function inventory(request,{snapshot=false}={}){
    const diagnostics=[],custom=new Set(),apps=new Map(),releases=new Map(),callable=new Set();let incompatible=0;
    const localBackendsInactive=snapshot&&platform.provider instanceof LocalProvider&&await platform.provider.snapshotBackendsInactive();
    const records=world.all();
    for(const record of records)if(record.kind==='app'&&record.namespace==='os'&&!record.archived){
      let manifest;try{manifest=JSON.parse(record.body);}catch{}
      if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)){diagnostics.push({reason:'installed-app-metadata-unverified'});continue;}
      apps.set(record.id,manifest);
    }
    for(const record of records)if(record.kind==='release'){
      let meta;try{meta=JSON.parse(record.body);}catch{}
      if(!meta||typeof meta!=='object'||Array.isArray(meta)){diagnostics.push({reason:'release-metadata-unverified'});continue;}
      releases.set(record.id,meta);const deployment=meta.deployment;if(!deployment)continue;
      // Historical and parked releases remain explicitly callable. Archive is
      // not a sufficient barrier: invoke/launch do not reject that flag.
      if(apps.has(meta.appId))callable.add(record.id);
      if(deployment.legacyBackend||deployment.backendURL||deployment.legacy?.backendURL||deployment.legacy&&!deployment.legacy.parked||deployment.provider==='fly'&&meta.backend||deployment.provider!=='pool'&&deployment.provider!=='local'&&!deployment.parked)diagnostics.push({reason:'unpooled-legacy-deployment'});
      if(deployment.provider==='pool'&&meta.backend&&!pool())diagnostics.push({reason:'pooled-backend-without-pool'});
      if(deployment.provider==='local'&&meta.backend&&!pool()&&!localBackendsInactive)diagnostics.push({reason:'unpooled-local-backend'});
      if(!['pool','local','fly'].includes(deployment.provider)&&!unboundDeployment(deployment))diagnostics.push({reason:'deployment-provider-unverified'});
    }
    for(const[appId,manifest]of apps){
      if(!manifest.releaseId)continue;
      const release=world.get(manifest.releaseId),meta=releases.get(manifest.releaseId);
      if(release?.kind!=='release'||meta?.appId!==appId){diagnostics.push({reason:'installed-release-identity-unverified'});continue;}
      callable.add(release.id);
    }
    for(const releaseId of callable){
      const image=releases.get(releaseId).backend?.runtimeImage;if(!image)continue;
      if(!pin(image)){diagnostics.push({reason:'callable-runtime-pin-unverified'});continue;}
      if(request.retireRuntimeImage&&image===request.fromImages.runtime)incompatible++;else if(image!==request.fromImages.runtime)custom.add(image);
    }
    const provider=platform.provider,compute=pool();if(provider instanceof LocalProvider){if(provider.servers.size&&(!snapshot||!provider.snapshotAdmissionClosed()))diagnostics.push({reason:'independent-local-release-server'});if(provider.compute&&!compute)diagnostics.push({reason:'untracked-local-compute'});}else if(provider&&!compute)diagnostics.push({reason:'provider-maintenance-unavailable'});
    check(custom.size<=1000,'MAINTENANCE_RUNTIME_INVENTORY_BOUND','Callable custom runtime inventory exceeds its proof bound');
    return{diagnostics,customRuntimeImages:[...custom].sort(),incompatibleRuntimeOverrides:incompatible};
  }
  function poolProof(result){if(result.admissionClosed&&['active','held','uncertain','oldRuntimeSlotsRemaining','incompatibleRuntimeOverrides'].every(key=>result[key]===0)&&platform.nativeJobs)platform.nativeJobs.accepting=false;return result;}
  async function quiescePool(request,{snapshot=false}={}){external(true);await healthy();check(request&&typeof request.retireRuntimeImage==='boolean'&&(snapshot?request.retireRuntimeImage===false:pin(request.fromImages?.runtime)&&pin(request.targetImages?.runtime)&&request.retireRuntimeImage===(request.fromImages.runtime!==request.targetImages.runtime)),'MAINTENANCE_IMAGE_BINDING','Provide the exact source and target runtime pins');const compute=pool(),extra=await inventory(request,{snapshot});
    const base={admissionClosed:false,active:0,held:compute?.slots?.reduce((total,slot)=>total+(slot.holds?.length||0),0)||0,uncertain:extra.diagnostics.length+(extra.incompatibleRuntimeOverrides&&compute?.slots?.length?1:0),oldRuntimeSlotsRemaining:request.retireRuntimeImage?compute?.slots?.filter(slot=>slot.deployment&&(!slot.deployment.runtimeImage||slot.deployment.runtimeImage===request.fromImages.runtime)).length||0:0,retired:[],...extra};
    if(extra.diagnostics.length||extra.incompatibleRuntimeOverrides)return base;
    if(!compute){check(!platform.provider||platform.provider instanceof LocalProvider,'MAINTENANCE_POOL_UNSUPPORTED','Runtime maintenance is unsupported for this provider');return poolProof({...base,admissionClosed:true});}
    if(typeof compute.maintenanceQuiesce!=='function')return{...base,uncertain:Math.max(1,base.uncertain),diagnostics:[...extra.diagnostics,{reason:'pool-maintenance-unavailable'}]};
    const result=await compute.maintenanceQuiesce({retireRuntimeImage:request.retireRuntimeImage,fromRuntimeImage:request.fromImages.runtime,targetRuntimeImage:request.targetImages.runtime});
    check(result&&typeof result.admissionClosed==='boolean'&&['active','held','uncertain','oldRuntimeSlotsRemaining'].every(key=>Number.isSafeInteger(result[key])&&result[key]>=0)&&Array.isArray(result.retired),'MAINTENANCE_POOL_PROOF','Runtime pool did not provide a complete maintenance proof');
    return poolProof({...result,oldRuntimeSlotsRemaining:request.retireRuntimeImage?result.oldRuntimeSlotsRemaining:0,incompatibleRuntimeOverrides:extra.incompatibleRuntimeOverrides,customRuntimeImages:extra.customRuntimeImages,diagnostics:[...(result.diagnostics||[]),...extra.diagnostics]});
  }
  async function flush(){external(true);await healthy();if(!allZero(await activity()))unchanged();
    const c=platform.collaboration;check(c&&typeof c.captureVersion==='function'&&typeof c.projectCommitted==='function'&&typeof c.checkpoint==='function','MAINTENANCE_COLLABORATION_UNVERIFIED','A live collaboration checkpoint adapter is required');
    const initial=queues();if(await pending([...initial.writers,...initial.publications]))unchanged();await Promise.all([...initial.writers,...initial.publications].filter(Boolean));
    // captureVersion opens all indexed initialized documents while holding their
    // journals; projection work starts only after that barrier has released.
    await c.captureVersion(()=>world.captureVersion());
    for(const item of c.documents.values()){
      const doc=await item;check(!doc.deleted&&!doc.writeError,'MAINTENANCE_DOCUMENT_UNREADY','A collaborative journal needs recovery');clearTimeout(doc.projectTimer);doc.projectTimer=null;doc.projectionEpoch=(doc.projectionEpoch||0)+1;await doc.tail;await c.projectCommitted(doc);await doc.tail;await c.checkpoint(doc);await doc.journal.sync();const directory=await open(doc.dir,'r');try{await directory.sync();}finally{await directory.close();}
    }
    await healthy();const after=queues();if(await pending([...after.writers,...after.publications]))unchanged();await Promise.all([...after.writers,...after.publications].filter(Boolean));if(!allZero(await activity()))unchanged();
    await world.transact(()=>world.persist());await healthy();if(!allZero(await activity()))unchanged();return{flushed:true};
  }
  const quiesceSnapshot=()=>quiescePool({retireRuntimeImage:false,fromImages:{},targetImages:{}},{snapshot:true});
  return{closeAdmission,resumeAdmission,continueDraining,activity,quiescePool,quiesceSnapshot,flush};
}
