import{mkdir,readFile,writeFile,rename,open}from'node:fs/promises';import{join}from'node:path';import{randomBytes}from'node:crypto';
const failure=(status,message)=>Object.assign(Error(message),{status});
const identity=()=>randomBytes(16).toString('hex');
// Private host state, excluded from shared data and OS version snapshots.
export class RuntimePool{
 constructor({directory,provider,runtime,environment,origin,maxModuleSlots=100,maxOCISlots=100,maxLeases=100,maxMachines=100,accountLimit=100,idleMs=120000,now=Date.now}){Object.assign(this,{directory,provider,runtime,environment,origin,maxModuleSlots,maxOCISlots,maxLeases,maxMachines,accountLimit,idleMs,now});this.path=join(directory,'runtime-pool.json');this.slots=[];this.tail=Promise.resolve();this.pending=new Map();this.requests=new Map();this.verified=new Map();this.timer=null;this.admissions=new Set();this.admissionClosed=false;this.maintenancePreparing=false;this.maintenanceTask=null;this.retiring=new Set();this.retirements=[];}
 async open({sweep=true}={}){await mkdir(this.directory,{recursive:true});try{const data=JSON.parse(await readFile(this.path,'utf8'));if(data.version!==1||!Array.isArray(data.slots)||data.retirements!==undefined&&(!Array.isArray(data.retirements)||data.retirements.length>10000))throw Error('Invalid runtime pool state');this.slots=data.slots;this.retirements=data.retirements||[];for(const slot of this.slots)if(['starting','draining'].includes(slot.status))slot.status='uncertain';}catch(error){if(error.code!=='ENOENT')throw error;}if(sweep){this.timer=setInterval(()=>void this.reap().catch(()=>{}),Math.max(1000,Math.min(15000,this.idleMs/2)));this.timer.unref();}return this;}
 async close(){clearInterval(this.timer);this.timer=null;await Promise.all([...this.pending.values(),...this.retiring,this.reaping,this.maintenanceTask].filter(Boolean));await this.tail;}
 async save(){const text=JSON.stringify({version:1,slots:this.slots,retirements:this.retirements});await writeFile(this.path+'.next',text,{mode:0o600,flush:true});await rename(this.path+'.next',this.path);const handle=await open(this.directory,'r');try{await handle.sync();}finally{await handle.close();}}
 change(run){const task=this.tail.then(async()=>{const result=await run();await this.save();return result;});this.tail=task.catch(()=>{});return task;}
 assertAdmission(){if(this.admissionClosed)throw failure(503,'Compute admission is held for maintenance');}
 enterAdmission(){this.assertAdmission();const token=Symbol();this.admissions.add(token);return()=>this.admissions.delete(token);}
 retainedDeployment(slot,deployment=slot.deployment){return deployment?{...deployment,...(!deployment.leaseId&&slot.leaseId?{leaseId:slot.leaseId}:{}),...(!deployment.appId&&slot.appId?{appId:slot.appId}:{}),...(!deployment.releaseId&&slot.releaseId?{releaseId:slot.releaseId}:{})}:deployment;}
 active(leaseId,appId,releaseId){return this.slots.some(slot=>slot.leaseId===leaseId&&slot.appId===appId&&slot.releaseId===releaseId&&['starting','ready','uncertain'].includes(slot.status));}
 publicSlot(slot){return{slotId:slot.id,kind:slot.kind,status:slot.status,appId:slot.appId||null,releaseId:slot.releaseId||null,leaseId:slot.leaseId||null,startedAt:slot.startedAt,lastUsedAt:slot.lastUsedAt,inFlight:this.requests.get(slot.leaseId)||0,holds:slot.holds||[],allowIdle:slot.allowIdle===true,assignmentCount:slot.assignmentCount||0,machineId:slot.deployment?.machineId,backendMachineId:slot.deployment?.backendMachineId};}
 budget(){return Math.min(this.maxMachines,this.provider.poolCapacity?this.capacitySnapshot?.maxPoolMachines??0:this.maxMachines);}
 async refreshCapacity(){if(this.provider.poolCapacity)this.capacitySnapshot=await this.provider.poolCapacity(this.slots,{accountLimit:this.accountLimit});return this.capacitySnapshot;}
 async inspect(){await this.refreshCapacity();return this.describe();}
 describe(){const machines=this.budget();return{capacity:this.capacitySnapshot,configured:{backendLeases:this.maxLeases,machines:this.maxMachines},limits:{backendLeases:Math.min(this.maxLeases,machines),machines,moduleSlots:Math.min(this.maxModuleSlots,machines),ociSlots:Math.min(this.maxOCISlots,Math.floor(machines/2)),idleMs:this.idleMs},allocatedMachines:this.slots.reduce((n,s)=>n+(s.kind==='oci'?2:1),0),slots:this.slots.map(slot=>this.publicSlot(slot))};}
 find(leaseId){const slot=this.slots.find(s=>s.leaseId===leaseId&&['starting','ready','uncertain'].includes(s.status));if(!slot)throw failure(409,'Compute lease has expired');return slot;}
 async hold(leaseId,label){const leave=this.enterAdmission();try{if(typeof label!=='string'||!label.trim()||label.length>120)throw failure(400,'Give this background job a short name');const id=identity();await this.change(()=>{this.assertAdmission();const slot=this.find(leaseId);if((slot.holds||[]).length>=100)throw failure(429,'Too many background holds');slot.holds=[...(slot.holds||[]),{id,label,createdAt:this.now()}];});return{id,label};}finally{leave();}}
 async releaseHold(leaseId,id){await this.change(()=>{const slot=this.find(leaseId);slot.holds=(slot.holds||[]).filter(hold=>hold.id!==id);slot.lastUsedAt=this.now();});return{released:true};}
 async allowIdle(leaseId){await this.change(()=>{this.find(leaseId).allowIdle=true;});return{idleAllowed:true};}
 async ensure(appId,releaseId,meta){const leave=this.enterAdmission();try{const key=appId+':'+releaseId;if(this.pending.has(key))return await this.pending.get(key);const task=this.ensureNow(appId,releaseId,meta).finally(()=>this.pending.delete(key));this.pending.set(key,task);return await task;}finally{leave();}}
 async ensureNow(appId,releaseId,meta){
  this.assertAdmission();
  const kind=meta.backend?.image?'oci':'module';let slot=this.slots.find(s=>s.appId===appId&&s.releaseId===releaseId&&['ready','starting','uncertain'].includes(s.status));
  if(slot?.status==='ready'&&this.verified.get(slot.id)===slot.leaseId)return slot;
  if(slot){try{const status=await this.provider.poolStatus(slot,this.runtime.leaseToken(appId,releaseId,slot.leaseId));if(status.appId===appId&&status.releaseId===releaseId&&status.leaseId===slot.leaseId&&!status.draining){if(slot.status!=='ready')await this.change(()=>{slot.status='ready';});this.verified.set(slot.id,slot.leaseId);return slot;}}catch{}// Never discard an unresponsive running worker.
   if(!await this.provider.poolStopped(slot)){if(this.provider.resumePoolSlot){const deployment=await this.provider.resumePoolSlot({slot,appId,releaseId,meta,key:this.runtime.leaseToken(appId,releaseId,slot.leaseId),origin:this.origin,environment:this.environment.values(appId)});await this.change(()=>{this.assertAdmission();slot.deployment=this.retainedDeployment(slot,deployment);slot.status='ready';});this.verified.set(slot.id,slot.leaseId);return slot;}throw failure(503,'Existing compute is busy or unavailable; its work was preserved');}await this.change(()=>{this.assertAdmission();slot.deployment=this.retainedDeployment(slot);slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];});
  }
  const reserve=async()=>{this.assertAdmission();if(!this.slots.some(s=>s.kind===kind&&s.status==='idle'))await this.refreshCapacity();return this.change(()=>{this.assertAdmission();let idle=this.slots.find(s=>s.kind===kind&&s.status==='idle');if(!idle){if(this.slots.length>=this.maxLeases||this.slots.reduce((n,s)=>n+(s.kind==='oci'?2:1),0)+(kind==='oci'?2:1)>this.budget()||this.slots.filter(s=>s.kind===kind).length>=(kind==='oci'?this.maxOCISlots:this.maxModuleSlots))return null;idle={id:identity(),kind,status:'idle'};this.slots.push(idle);}Object.assign(idle,{status:'starting',appId,releaseId,leaseId:identity(),lastUsedAt:this.now(),startedAt:this.now(),holds:[],allowIdle:false,assignmentCount:(idle.assignmentCount||0)+1});return idle;});};
  slot=await reserve();if(!slot){await this.reap({continuation:true});slot=await reserve();}if(!slot)throw failure(503,'Compute pool is fully leased; active and background work was preserved');
  await this.runtime.prepare(appId);const leaseId=slot.leaseId;
  try{const deployment=await this.provider.assignPoolSlot({slot,appId,releaseId,meta,key:this.runtime.leaseToken(appId,releaseId,leaseId),origin:this.origin,environment:this.environment.values(appId)});await this.change(()=>{this.assertAdmission();if(slot.leaseId!==leaseId)throw failure(409,'Compute assignment changed');slot.deployment=this.retainedDeployment(slot,deployment);slot.status='ready';});this.verified.set(slot.id,slot.leaseId);return slot;}
  catch(error){await this.change(()=>{slot.status='uncertain';slot.lastError='Assignment did not become ready';});throw error;}
 }
 async invoke(appId,releaseId,meta,input){
  let slot,leaseId;const leave=this.enterAdmission();
  try{for(;;){slot=await this.ensure(appId,releaseId,meta);leaseId=slot.leaseId;const admitted=await this.change(()=>{this.assertAdmission();if(slot.status!=='ready'||slot.leaseId!==leaseId)return false;this.requests.set(leaseId,(this.requests.get(leaseId)||0)+1);slot.lastUsedAt=this.now();return true;});if(admitted)break;}}finally{leave();}
  try{return await this.provider.poolInvoke(slot,this.runtime.leaseToken(appId,releaseId,leaseId),input);}
  catch(error){this.verified.delete(slot.id);throw error;}
  finally{await this.change(()=>{const count=this.requests.get(leaseId)-1;if(count)this.requests.set(leaseId,count);else this.requests.delete(leaseId);if(slot.leaseId===leaseId)slot.lastUsedAt=this.now();});}
 }
 reap({continuation=false}={}){if(this.reaping)return this.reaping;if(this.admissionClosed||this.maintenancePreparing&&!continuation)return Promise.resolve({released:[],maintenance:true,...this.describe()});this.reaping=this.reapNow().finally(()=>{this.reaping=null;});return this.reaping;}
 retireRelease(appId,releaseId){if(this.admissionClosed)return Promise.reject(failure(409,'Compute retirement is held for maintenance'));const task=this.retireReleaseNow(appId,releaseId).finally(()=>this.retiring.delete(task));this.retiring.add(task);return task;}
 async retireReleaseNow(appId,releaseId){
  if(this.admissionClosed)throw failure(409,'Compute retirement is held for maintenance');
  for(const slot of this.slots.filter(slot=>slot.appId===appId&&slot.releaseId===releaseId)){
   const leaseId=slot.leaseId;
   if(this.requests.get(leaseId)||(slot.holds||[]).length)throw failure(409,'Backend cleanup is waiting for active work to finish');
   if(!await this.provider.poolStopped(slot)){
    const key=this.runtime.leaseToken(appId,releaseId,leaseId),status=await this.provider.poolStatus(slot,key);
    if(status.activeRequests||status.resources||status.startPinned&&!slot.allowIdle)throw failure(409,'Backend cleanup is waiting for background work to finish');
    const claimed=await this.change(()=>{if(this.requests.get(leaseId)||(slot.holds||[]).length||slot.leaseId!==leaseId)return false;slot.status='draining';return true;});
    if(!claimed)throw failure(409,'Backend cleanup is waiting for active work to finish');
    const drained=await this.provider.drainPoolSlot(slot,key,{allowIdle:slot.allowIdle});
    if(!drained.idle){await this.change(()=>{slot.status='ready';});throw failure(409,'Backend cleanup is waiting for active work to finish');}
    if(!await this.provider.stopPoolSlot(slot)){await this.change(()=>{slot.status='uncertain';});throw failure(409,'Backend cleanup has not confirmed an idle stopped worker');}
   }
   await this.provider.removeStopped?.(slot);
   await this.change(()=>{slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];delete slot.deployment;});
  }
 }
 async reapNow(){const released=[];for(const slot of [...this.slots]){
   const leaseId=slot.leaseId;if(slot.status==='uncertain'){if(await this.provider.poolStopped(slot)){await this.change(()=>{slot.deployment=this.retainedDeployment(slot);slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];});}continue;}
   if(slot.status!=='ready'||this.requests.get(leaseId)||this.now()-slot.lastUsedAt<this.idleMs)continue;
   const key=this.runtime.leaseToken(slot.appId,slot.releaseId,leaseId);let status;try{status=await this.provider.poolStatus(slot,key);}catch{if(await this.provider.poolStopped(slot))await this.change(()=>{if(slot.status==='ready'&&slot.leaseId===leaseId&&!this.requests.get(leaseId)){slot.deployment=this.retainedDeployment(slot);slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];}});continue;}
   if((slot.holds||[]).length||status.leaseId!==leaseId||status.activeRequests||status.resources||status.startPinned&&!slot.allowIdle||status.draining)continue;
   const claimed=await this.change(()=>{if(slot.status!=='ready'||slot.leaseId!==leaseId||this.requests.get(leaseId)||(slot.holds||[]).length||this.now()-slot.lastUsedAt<this.idleMs)return false;slot.status='draining';return true;});if(!claimed)continue;
   try{const drained=await this.provider.drainPoolSlot(slot,key,{allowIdle:slot.allowIdle});if(!drained.idle){await this.change(()=>{slot.status='ready';});continue;}if(!await this.provider.stopPoolSlot(slot))throw Error('Pool slot could not be safely stopped');await this.change(()=>{slot.deployment=this.retainedDeployment(slot);slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];slot.lastUsedAt=this.now();});released.push(slot.id);}
   catch{await this.change(()=>{slot.status='uncertain';slot.lastError='Idle release could not be confirmed';});}
  }return{released, ...this.describe()};}
 maintenanceQuiesce({retireRuntimeImage=false,fromRuntimeImage,targetRuntimeImage}={}){
  if(typeof retireRuntimeImage!=='boolean'||[fromRuntimeImage,targetRuntimeImage].some(value=>value!==undefined&&(typeof value!=='string'||!value||value.length>2048||/[\x00-\x20\x7f]/.test(value)))||retireRuntimeImage&&(!fromRuntimeImage||!targetRuntimeImage||fromRuntimeImage===targetRuntimeImage))return Promise.reject(failure(400,'Provide explicit distinct runtime image identities for retirement'));
  const options={retireRuntimeImage,fromRuntimeImage,targetRuntimeImage},key=JSON.stringify(options);
  if(this.maintenanceTask){if(this.maintenanceKey!==key)return Promise.reject(failure(409,'Another maintenance inspection is in progress'));return this.maintenanceTask;}
  this.maintenancePreparing=true;this.maintenanceKey=key;const task=this.maintenanceQuiesceNow(options).finally(()=>{this.maintenancePreparing=false;this.maintenanceTask=null;this.maintenanceKey=null;});this.maintenanceTask=task;return task;
 }
 releaseMaintenance(){if(this.maintenanceTask)throw failure(409,'Wait for the maintenance inspection to finish');this.admissionClosed=false;return{admissionClosed:false};}
 async maintenanceQuiesceNow({retireRuntimeImage,fromRuntimeImage,targetRuntimeImage}){
  const busy=new Set(),unknown=new Set(),diagnostics=[],retired=[];
  const local=()=>({pending:this.pending.size+this.retiring.size+(this.reaping?1:0),requests:[...this.requests.values()].reduce((sum,n)=>sum+n,0),admissions:this.admissions.size,held:this.slots.reduce((sum,slot)=>sum+(slot.holds||[]).length,0)});
  const oldSlots=()=>this.slots.filter(slot=>slot.deployment&&(!fromRuntimeImage||!slot.deployment.runtimeImage||slot.deployment.runtimeImage===fromRuntimeImage));
  const result=()=>{const counters=local();return{admissionClosed:this.admissionClosed,active:Math.max(busy.size,counters.pending,counters.requests,counters.admissions),held:counters.held,uncertain:unknown.size,oldRuntimeSlotsRemaining:oldSlots().length,retired,...counters,customRuntimeSlots:this.slots.filter(slot=>slot.deployment?.runtimeImage&&fromRuntimeImage&&slot.deployment.runtimeImage!==fromRuntimeImage).map(slot=>slot.id),diagnostics};};
  const uncertain=(slot,reason)=>{unknown.add(slot?.id||'pool');diagnostics.push({slotId:slot?.id||null,reason});};
  const validStatus=(slot,status)=>status&&status.appId===slot.appId&&status.releaseId===slot.releaseId&&status.leaseId===slot.leaseId&&Number.isSafeInteger(status.activeRequests)&&status.activeRequests>=0&&Number.isSafeInteger(status.resources)&&status.resources>=0&&typeof status.startPinned==='boolean'&&typeof status.draining==='boolean';
  const idleStatus=(slot,status)=>!status.activeRequests&&!status.resources&&(!status.startPinned||slot.allowIdle===true);
  const clearStopped=slot=>{slot.deployment=this.retainedDeployment(slot);this.verified.delete(slot.id);slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];slot.lastUsedAt=this.now();};
  const providerSlot=slot=>({...slot,leaseId:slot.leaseId||slot.deployment?.leaseId,appId:slot.appId||slot.deployment?.appId,releaseId:slot.releaseId||slot.deployment?.releaseId});
  let current;
  try{
   await this.reaping;await this.tail;
   const slots=[...this.slots],fingerprint=()=>JSON.stringify(this.slots.map(slot=>[slot.id,slot.status,slot.appId,slot.releaseId,slot.leaseId,slot.deployment,slot.holds||[]]));const before=fingerprint(),states=new Map();
   // This pass never closes admission or drains a worker. Continuations can
   // finish and release their holds while every remote slot is inspected.
   for(const slot of slots){current=slot;try{
    const stopped=await this.provider.poolStopped(providerSlot(slot));if(stopped!==true&&stopped!==false){uncertain(slot,'provider-stop-truth-unavailable');continue;}
    states.set(slot.id,{stopped});
    if(this.requests.get(slot.leaseId))busy.add(slot.id);
    if(stopped)continue;
    if(!slot.appId||!slot.releaseId||!slot.leaseId||!['ready','starting','uncertain'].includes(slot.status)){uncertain(slot,'running-slot-assignment-unverified');continue;}
    const status=await this.provider.poolStatus(slot,this.runtime.leaseToken(slot.appId,slot.releaseId,slot.leaseId));
    if(!validStatus(slot,status)||status.draining){uncertain(slot,'worker-status-unverified');continue;}
    if(!idleStatus(slot,status))busy.add(slot.id);
   }catch{uncertain(slot,'provider-status-unavailable');}}
   const counters=local();if(busy.size||unknown.size||counters.pending||counters.requests||counters.admissions||counters.held){this.admissionClosed=false;return result();}
   const closed=await this.change(()=>{const now=local();if(fingerprint()!==before||now.pending||now.requests||now.admissions||now.held)return false;this.admissionClosed=true;return true;});
   if(!closed){this.admissionClosed=false;uncertain(null,'pool-admission-changed-during-preflight');return result();}
   for(const slot of slots){current=slot;
    if(!states.get(slot.id)?.stopped){
     const leaseId=slot.leaseId,key=this.runtime.leaseToken(slot.appId,slot.releaseId,leaseId);
     await this.change(()=>{const now=local();if(now.pending||now.requests||now.admissions||now.held||slot.leaseId!==leaseId)throw failure(409,'Pool activity changed before drain');slot.status='draining';});
     const drained=await this.provider.drainPoolSlot(slot,key,{allowIdle:slot.allowIdle===true});
     if(!validStatus(slot,drained)||drained.idle!==true||!idleStatus(slot,drained)||drained.draining!==true){
      this.admissionClosed=false;
      if(validStatus(slot,drained)&&drained.idle===false&&!drained.draining){busy.add(slot.id);await this.change(()=>{slot.status='ready';});}
      else{slot.status='uncertain';uncertain(slot,'final-drain-unverified');await this.save();}
      return result();
     }
     if(await this.provider.stopPoolSlot(slot)!==true||await this.provider.poolStopped(slot)!==true){slot.status='uncertain';uncertain(slot,'idle-stop-unconfirmed');this.admissionClosed=false;await this.save();return result();}
    }
    await this.change(()=>clearStopped(slot));
   }
   // Retirement is a separate irreversible phase, reached only after the
   // whole pool is idle and stopped. Its intent survives response loss.
   if(retireRuntimeImage)for(const slot of [...oldSlots()]){current=slot;
    if(!slot.deployment?.runtimeImage){uncertain(slot,'runtime-image-identity-missing');continue;}
    if(typeof this.provider.removeStopped!=='function'){uncertain(slot,'stopped-slot-retirement-unsupported');continue;}
    const authority={slotId:slot.id,fromRuntimeImage,targetRuntimeImage,deployment:structuredClone(slot.deployment)};let record=this.retirements.findLast(row=>row.slotId===slot.id);
    if(record&&JSON.stringify(record.authority)!==JSON.stringify(authority)){if(record.state==='blocked-legacy-authority')record=null;else{uncertain(slot,'retirement-authority-changed');continue;}}
    if(!record){if(this.retirements.length>=10000){uncertain(slot,'retirement-journal-full');continue;}record={authority,slotId:slot.id,state:'intent',createdAt:this.now()};await this.change(()=>this.retirements.push(record));}
    try{
     if(record.state==='blocked-legacy-authority')await this.change(()=>{record.state='intent';delete record.reason;});
     if(await this.provider.poolStopped(providerSlot(slot))!==true)throw failure(409,'Retirement stopped truth changed');
     const proof=await this.provider.removeStopped(providerSlot(slot));if(proof===false)throw failure(409,'Stopped slot removal was not confirmed');
     if(await this.provider.poolStopped(providerSlot(slot))!==true)throw failure(409,'Stopped slot removal was not confirmed');
     await this.change(()=>{record.state='removed';record.removedAt=this.now();record.proof=proof&&typeof proof==='object'?proof:{removed:true};});
     await this.change(()=>{this.slots=this.slots.filter(value=>value.id!==slot.id);});retired.push(slot.id);
    }catch(error){const legacy=error.code==='LEGACY_POOL_RETIREMENT_AUTHORITY_MISSING';if(legacy)await this.change(()=>{record.state='blocked-legacy-authority';record.reason='legacy-retirement-authority-missing';});uncertain(slot,legacy?'legacy-retirement-authority-missing':'stopped-slot-retirement-unconfirmed');}
   }
   for(const slot of this.slots){current=slot;try{if(await this.provider.poolStopped(providerSlot(slot))!==true)uncertain(slot,'final-stopped-truth-unconfirmed');}catch{uncertain(slot,'final-stopped-truth-unavailable');}}
   const final=local();if(final.pending||final.requests||final.admissions||final.held||unknown.size||busy.size){this.admissionClosed=false;return result();}
   this.admissionClosed=true;return result();
  }catch{this.admissionClosed=false;if(current){current.status='uncertain';current.lastError='Maintenance state could not be confirmed';}uncertain(current,'maintenance-state-or-persistence-unconfirmed');try{await this.save();}catch{}return result();}
 }
}
