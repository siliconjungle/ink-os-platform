import{desktopFile}from'../shared/desktop-placements.mjs';import{fileInfo}from'../shared/file-types.mjs';import{hash}from'./world.mjs';import{appManifest,installedApps}from'../shared/app-desktop.mjs';import{fileApps,fileType,preferredFileApp}from'../shared/file-apps.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function associationType(value){if(typeof value!=='string'||! /^(\.[a-z0-9][a-z0-9.+_-]{0,20}|[a-z][a-z0-9-]{0,63}|[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*))$/.test(value))fail(400,'Use a file extension, MIME type or kind');return value;}
const recordId=type=>hash('ink-os-file-default:'+type).slice(0,32);
export function fileDefaults(world,objects=world.all()){const apps=publishedApps(world,objects);return {...Object.fromEntries(Object.entries(policy(world,objects)?.automatic||{}).filter(([,id])=>apps.some(app=>app.id===id))),...Object.fromEntries(objects.filter(object=>object.namespace==='os'&&object.kind==='state'&&!object.archived&&object.tags.includes('file-default')&&object.id===recordId(object.title)).flatMap(object=>{try{const value=JSON.parse(object.body);return typeof value.appId==='string'?[[object.title,value.appId]]:[];}catch{return[];}}))};}
export async function setFileDefault(platform,input){
 const file=input.fileId?platform.world.get(input.fileId):null,type=associationType(input.type||file&&fileType(file));
 if(input.fileId&&(!file||!desktopFile(file)))fail(404,'File not found');
 if(file){const info=fileInfo(file);if(![info.extension,info.mime,info.mime.split('/')[0]+'/*',file.kind].includes(type))fail(400,'The association type must match the selected file');}
 const current=platform.world.get(recordId(type));
 if(input.appId===null){await platform.world.put({...(current||{}),id:recordId(type),namespace:'os',kind:'state',title:type,tags:['file-default'],archived:true,body:JSON.stringify({appId:null})},{writer:'os',expected:current?.revision||0,actor:'Owner',action:'cleared file default'});return fileDefaults(platform.world);}
 const app=installedApps(platform.world.all()).find(app=>app.id===input.appId);if(!app)fail(404,'Application not found');
 const types=appManifest(app).desktop.fileTypes||[],direct=types.some(accepted=>accepted==='*'||accepted===type||accepted.endsWith('/*')&&type.startsWith(accepted.slice(0,-1)));
 const samples=file?[file]:platform.world.all().filter(object=>desktopFile(object)&&fileType(object)===type);
 if(!direct&&!samples.some(object=>fileApps([app],object).length))fail(400,'This app has not declared support for that file type');
 if(file&&!fileApps([app],file).length)fail(400,'This app cannot open this file');
 await platform.world.put({id:recordId(type),namespace:'os',kind:'state',title:type,body:JSON.stringify({appId:app.id}),tags:['file-default'],archived:false},{writer:'os',expected:current?.revision||0,actor:'Owner',action:'changed file default'});
 return fileDefaults(platform.world);
}
export async function clearAppDefaults(platform,appId){for(const[type,id]of Object.entries(fileDefaults(platform.world)))if(id===appId)await setFileDefault(platform,{type,appId:null});}

export function fileDefaultsConfigured(world,objects=world.all()){return objects.some(object=>object.namespace==='os'&&object.kind==='state'&&object.tags.includes('file-default')&&object.id===recordId(object.title));}

const policyId=hash('ink-os-file-associations-v1').slice(0,32);
function policy(world,objects){try{return JSON.parse((objects?objects.find(object=>object.id===policyId):world.get(policyId))?.body||'null');}catch{return null;}}
const publishedApps=(world,objects=world.all())=>installedApps(objects).filter(app=>{const meta=appManifest(app);return meta.releaseId||meta.url;});
// Resolve all extension/MIME samples in one pass. Matching a handler needs
// metadata, never a repeated parse of a document's potentially large body.
function fileIndex(objects){const samples=new Map(),types=new Set();for(const file of objects){if(!desktopFile(file))continue;const info=fileInfo(file),type=info.extension||info.mime||file.kind,sample={id:file.id,kind:file.kind,namespace:file.namespace,source:file.source,title:file.title,body:JSON.stringify({originalName:info.name,mime:info.mime,bytes:info.bytes})};for(const key of [type,info.mime]){types.add(key);if(!samples.has(key))samples.set(key,sample);}if(info.mime.includes('/')&&info.mime!=='application/octet-stream')types.add(info.mime.split('/')[0]+'/*');}return{types,sample:type=>samples.get(type)||{kind:type.includes('/')||type.startsWith('.')?'file':type,namespace:'os',source:type.startsWith('.')?'file'+type:'',body:JSON.stringify({mime:type.includes('/')?type:'application/octet-stream'})}};}

function settings(platform,objects=platform.world.all()){
 const state=policy(platform.world,objects),apps=publishedApps(platform.world,objects),defaults=fileDefaults(platform.world,objects),suggestions=[],index=fileIndex(objects);
 for(const app of apps)if(state?.candidates.includes(app.id))for(const[type,currentAppId]of Object.entries(defaults)){
  if(currentAppId===app.id||state.dismissed.includes(app.id+':'+type)||!fileApps([app],index.sample(type)).length)continue;
  suggestions.push({appId:app.id,type,currentAppId});
 }
 return{defaults,configured:fileDefaultsConfigured(platform.world,objects),suggestions};
}
function serialized(platform,run){const task=(platform.fileDefaultsTail||Promise.resolve()).then(run);platform.fileDefaultsTail=task.catch(()=>{});return task;}
async function reconcileNow(platform){
 const world=platform.world;let objects=world.all();const apps=publishedApps(world,objects),current=objects.find(object=>object.id===policyId),prior=policy(world,objects),state=prior?structuredClone(prior):{version:1,baseline:apps.map(app=>app.id),candidates:[],dismissed:[],automatic:{}};
 for(const app of apps)if(!state.baseline.includes(app.id)&&!state.candidates.includes(app.id))state.candidates.push(app.id);
 const index=fileIndex(objects),types=new Set([...apps.flatMap(app=>appManifest(app).desktop.fileTypes||[]).filter(type=>type!=='*'),...index.types]);
 const before=fileDefaults(world,objects);
 for(const type of types){const file=index.sample(type),valid=fileApps(apps,file);if(state.automatic[type]&&valid.some(app=>app.id===state.automatic[type]))continue;const chosen=preferredFileApp(apps,file,before);if(chosen)state.automatic[type]=chosen.id;else delete state.automatic[type];}
 if(!current||JSON.stringify(state)!==current.body){const updated=await world.put({id:policyId,kind:'state',namespace:'os',title:'File associations',tags:['file-associations'],body:JSON.stringify(state)},{writer:'os',expected:current?.revision||0,actor:'File defaults'});objects=[...objects.filter(object=>object.id!==policyId),updated];}
 const result=settings(platform,objects);platform.fileDefaultsCache={version:world.version,result};platform.fileDefaultsReconciled=world.version;return structuredClone(result);
}
export function reconcileFileDefaults(platform){if(platform.fileDefaultsPending)return platform.fileDefaultsPending;const task=serialized(platform,()=>platform.fileDefaultsReconciled===platform.world.version&&platform.fileDefaultsCache?.version===platform.world.version?structuredClone(platform.fileDefaultsCache.result):reconcileNow(platform));const pending=task.finally(()=>{if(platform.fileDefaultsPending===pending)platform.fileDefaultsPending=undefined;});platform.fileDefaultsPending=pending;return pending;}
export function fileDefaultSettings(platform){if(platform.fileDefaultsCache?.version!==platform.world.version)platform.fileDefaultsCache={version:platform.world.version,result:settings(platform)};return structuredClone(platform.fileDefaultsCache.result);}
export function resolveFileDefault(platform,fileId){return serialized(platform,async()=>{await reconcileNow(platform);const file=platform.world.get(fileId);if(!file||!desktopFile(file))fail(404,'File not found');const app=preferredFileApp(publishedApps(platform.world),file,fileDefaults(platform.world));return{appId:app?.id||null,defaults:fileDefaults(platform.world)};});}
export function dismissFileDefault(platform,input){return serialized(platform,async()=>{await reconcileNow(platform);const type=associationType(input.type),current=platform.world.get(policyId),state=policy(platform.world),key=input.appId+':'+type;if(!state.dismissed.includes(key)){state.dismissed.push(key);await platform.world.update(policyId,{body:JSON.stringify(state)},{writer:'os',expected:current.revision,actor:'Owner',action:'kept file default'});}return settings(platform);});}
