import{poolMethods}from'./fly-pool.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class FlyProvider{
 constructor({token=process.env.FLY_API_TOKEN,org=process.env.FLY_ORG,region=process.env.FLY_REGION||'syd',runtimeImage=process.env.INK_OS_RUNTIME_IMAGE,prefix=process.env.INK_OS_APP_PREFIX||'ink-app'}={}){Object.assign(this,{token,org,region,runtimeImage,prefix});}
 async api(path,body,method='POST',{sensitive=false,lease}={}){try{const response=await fetch('https://api.machines.dev/v1'+path,{method,signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json',...(lease?{'fly-machine-lease-nonce':lease}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();let result;try{result=text?JSON.parse(text):{};}catch{if(sensitive)throw Error('Invalid Fly secret-vault response');result={error:text.slice(0,300)};}if(!response.ok)throw Object.assign(Error(sensitive?'Fly secret-vault request failed ('+response.status+').':'Fly '+response.status+': '+(result.error||result.message||response.status)),{status:502,flyStatus:response.status});return result;}catch(error){if(sensitive)throw Object.assign(Error('Fly secret-vault request failed'+(error.flyStatus?' ('+error.flyStatus+')':'')+'.'),{status:502,flyStatus:error.flyStatus});throw error;}}
 async syncEnvironment(name,values){
  const path='/apps/'+name+'/secrets',options={sensitive:true},current=await this.api(path,undefined,'GET',options);
  if(!Array.isArray(current.secrets))throw Object.assign(Error('Fly returned invalid secret metadata.'),{status:502});
  let version=0;
  for(const secret of current.secrets){const key=secret.name;if(typeof key!=='string'||!/^[A-Z_][A-Z0-9_]*$/.test(key)||/^(INK_|FLY_|NODE_|LD_|DYLD_)/.test(key))continue;if(!Object.hasOwn(values,key)){const result=await this.api(path+'/'+encodeURIComponent(key),undefined,'DELETE',options);version=Math.max(version,result.version??result.Version??0);}}
  if(Object.keys(values).length){const result=await this.api(path,{values},'POST',options);if(!Array.isArray(result.secrets)||Object.keys(values).some(key=>!result.secrets.some(secret=>secret.name===key)))throw Object.assign(Error('Fly did not confirm stored secret metadata.'),{status:502});version=Math.max(version,result.version??result.Version??0);}
  return version;
 }
 environmentTargets(appId,releaseId,meta){const name=`${this.prefix}-${appId.slice(0,8)}-${releaseId.slice(0,8)}`;if(meta.deployment?.app!==name)throw Error('Wrong environment deployment identity');return meta.backend?.image?[name+'-srv']:[name];}
 async stageEnvironment({appId,releaseId,meta,values}){const versions={};for(const name of this.environmentTargets(appId,releaseId,meta))versions[name]=Math.max(await this.syncEnvironment(name,values),meta.environmentVersions?.[name]||meta.deployment?.environmentVersions?.[name]||0);await this.prepareEnvironment({appId,releaseId,meta,versions,deferConflicts:true});return versions;}
 async prepareEnvironment({appId,releaseId,meta,versions=meta.environmentVersions||meta.deployment?.environmentVersions,deferConflicts=false}){
  if(!versions)return;
  for(const name of this.environmentTargets(appId,releaseId,meta)){
   const version=versions[name];if(!Number.isSafeInteger(version)||version<=0)continue;
   const base='/apps/'+name+'/machines',options={sensitive:true},machines=await this.api(base,undefined,'GET',options);
   for(const previous of machines){
    if(previous.state!=='stopped'||previous.config?.metadata?.ink_env_version===String(version))continue;
    const path=base+'/'+previous.id;let grant;try{grant=await this.api(path+'/lease?ttl=30',undefined,'POST',options);}catch(error){if(deferConflicts&&error.flyStatus===409)continue;throw error;}const lease=grant.data?.nonce;
    if(!lease)throw Object.assign(Error('Fly did not grant the environment update lease.'),{status:502});
    try{const machine=await this.api(path,undefined,'GET',{...options,lease});if(machine.state!=='stopped')continue;
     await this.api(path,{config:{...machine.config,metadata:{...machine.config?.metadata,ink_env_version:String(version)}},current_version:machine.version,min_secrets_version:version,skip_launch:true},'POST',{...options,lease});
    }catch(error){if(!deferConflicts||error.flyStatus!==409)throw error;}finally{await this.api(path+'/lease',undefined,'DELETE',{...options,lease});}
   }
  }
 }
 async ensureApp(name,network=name){try{await this.api('/apps/'+name,undefined,'GET');}catch(e){if(!String(e.message).includes('404')&&!String(e.message).includes('not found'))throw e;await this.api('/apps',{app_name:name,org_slug:this.org,network});}}
 async publicAddress(app){const response=await fetch('https://api.fly.io/graphql',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({query:'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }',variables:{input:{appId:app,type:'shared_v4',region:''}}})});const result=await response.json();if(result.errors&&!result.errors.every(e=>/already|exists/i.test(e.message)))throw Error('Fly public address: '+result.errors.map(e=>e.message).join(';'));}
 async machine(app,config,minSecretsVersion=0){const machines=await this.api('/apps/'+app+'/machines',undefined,'GET');let machine=machines.find(m=>m.name==='runtime');if(machine){if(machine.state==='stopped'){if(minSecretsVersion)return this.api('/apps/'+app+'/machines/'+machine.id,{config:machine.config,current_version:machine.version,min_secrets_version:minSecretsVersion});await this.api('/apps/'+app+'/machines/'+machine.id+'/start',{});}return machine;}return this.api('/apps/'+app+'/machines',{name:'runtime',region:this.region,config,...(minSecretsVersion?{min_secrets_version:minSecretsVersion}:{})});}
 async park(deployment,{appId,releaseId,requireCapacity=false}){
  if(deployment.provider!=='fly'||deployment.backendURL||deployment.app!==`${this.prefix}-${appId.slice(0,8)}-${releaseId.slice(0,8)}`||!/@sha256:[a-f0-9]{64}$/.test(deployment.runtimeImage||''))return false;
  const path='/apps/'+deployment.app+'/machines',machines=await this.api(path,undefined,'GET');
  if(requireCapacity&&!machines.length)return false;
  if(machines.some(machine=>machine.state!=='stopped'||machine.name!=='runtime'||machine.config?.mounts?.length||machine.config?.image!==deployment.runtimeImage||machine.config?.files?.length||machine.config?.init?.exec?.length||machine.config?.init?.cmd?.length||machine.config?.env?.INK_OS_BACKEND_URL||machine.config?.env?.INK_OS_APP_ID!==appId||machine.config?.env?.INK_OS_RELEASE_ID!==releaseId))return false;
  for(const machine of machines)try{await this.api(path+'/'+machine.id,undefined,'DELETE');}catch(error){if(error.flyStatus!==404)return false;}
  return !(await this.api(path,undefined,'GET')).length;
 }
 async retire(deployment){const names=[deployment.app,...(deployment.backendURL?[new URL(deployment.backendURL).hostname.replace(/\.internal$/,'')]:[])];for(const name of names){if(typeof name!=='string'||!name.startsWith(this.prefix+'-'))throw Error('Refusing cleanup outside Ink OS app scope');let machines;try{machines=await this.api('/apps/'+name+'/machines',undefined,'GET');}catch(error){if(error.message.includes('404'))continue;throw error;}for(const machine of machines){try{await this.api('/apps/'+name+'/machines/'+machine.id+'?force=true',undefined,'DELETE');}catch(error){if(!error.message.includes('404'))throw error;}}try{await this.api('/apps/'+name+'?force=true',undefined,'DELETE');}catch(error){if(!error.message.includes('404'))throw error;}}}
 async deploy({appId,releaseId,meta,key,origin,environment}){
  if(!this.token||!(meta.deployment?.runtimeImage||this.runtimeImage))throw Error('Fly token and runtime image must be configured');const name=`${this.prefix}-${appId.slice(0,8)}-${releaseId.slice(0,8)}`;await this.ensureApp(name);await this.publicAddress(name);let backendURL,backendSecretsVersion=0;
  if(meta.backend?.image){const backendName=name+'-srv';await this.ensureApp(backendName,name);const version=environment===undefined?0:await this.syncEnvironment(backendName,environment);backendSecretsVersion=version;await this.machine(backendName,{image:meta.backend.image,env:{PORT:String(meta.backend.port),INK_OS_URL:origin,INK_OS_APP_TOKEN:key,INK_OS_APP_ID:appId,INK_OS_NAMESPACE:appId},...(meta.backend.command?{init:{exec:meta.backend.command}}:{}),guest:{cpu_kind:'shared',cpus:1,memory_mb:256},restart:{policy:'always'},services:[]},version);backendURL=`http://${backendName}.internal:${meta.backend.port}`;}
  const runtimeImage=meta.deployment?.runtimeImage||this.runtimeImage;
  const secretsVersion=environment===undefined||meta.backend?.image?0:await this.syncEnvironment(name,environment);
  const machine=await this.machine(name,{image:runtimeImage,env:{PORT:'8080',INK_OS_URL:origin,INK_OS_APP_ID:appId,INK_OS_RELEASE_ID:releaseId,INK_OS_APP_TOKEN:key,...(backendURL?{INK_OS_BACKEND_URL:backendURL}:{})},guest:{cpu_kind:'shared',cpus:1,memory_mb:256},restart:{policy:'always'},services:[{protocol:'tcp',internal_port:8080,autostart:true,autostop:'stop',min_machines_running:1,ports:[{port:80,handlers:['http']},{port:443,handlers:['tls','http']}],http_checks:[{path:'/_ink/health',interval:'30s',timeout:'5s',grace_period:'30s',method:'GET'}]}]},secretsVersion);
  const environmentVersions=backendSecretsVersion?{[name+'-srv']:backendSecretsVersion}:secretsVersion?{[name]:secretsVersion}:{};
  const url='https://'+name+'.fly.dev';for(let attempt=0;attempt<40;attempt++){try{const response=await fetch(url+'/_ink/health',{signal:AbortSignal.timeout(10000)});if(response.ok)return{provider:'fly',app:name,machineId:machine.id,url,backendURL,runtimeImage,network:name,...(Object.keys(environmentVersions).length?{environmentVersions}:{})};}catch{}await sleep(1500);}throw Error('App deployment did not become healthy: '+name);
 }
}

Object.assign(FlyProvider.prototype,poolMethods);
