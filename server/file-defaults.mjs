import{desktopFile}from'../shared/desktop-placements.mjs';import{fileInfo}from'../shared/file-types.mjs';import{hash}from'./world.mjs';import{appManifest,installedApps}from'../shared/app-desktop.mjs';import{fileApps,fileType,preferredFileApp,fileActionTypes,previewableObject}from'../shared/file-apps.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function associationType(value){if(typeof value!=='string'||! /^(\.[a-z0-9][a-z0-9.+_-]{0,20}|[a-z][a-z0-9-]{0,63}|[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*))$/.test(value))fail(400,'Use a file extension, MIME type or kind');return value;}
const tag=action=>action==='preview'?'preview-default':'file-default';
const recordId=(type,action='open')=>hash('ink-os-'+tag(action)+':'+type).slice(0,32);
export function fileDefaults(world,objects=world.all(),action='open'){const apps=publishedApps(world,objects);return {...Object.fromEntries(Object.entries(policy(world,objects,action)?.automatic||{}).filter(([,id])=>apps.some(app=>app.id===id))),...Object.fromEntries(objects.filter(object=>object.namespace==='os'&&object.kind==='state'&&!object.archived&&object.tags.includes(tag(action))&&object.id===recordId(object.title,action)).flatMap(object=>{try{const value=JSON.parse(object.body);return typeof value.appId==='string'?[[object.title,value.appId]]:[];}catch{return[];}}))};}
export async function setFileDefault(platform,input,action='open'){
 const file=input.fileId?platform.world.get(input.fileId):null,type=associationType(input.type||file&&fileType(file));
 if(input.fileId&&(!file||!(action==='preview'?previewableObject(file):desktopFile(file))))fail(404,'File not found');
 if(file){const info=fileInfo(file);if(![info.extension,info.mime,info.mime.split('/')[0]+'/*',file.kind].includes(type))fail(400,'The association type must match the selected file');}
 const current=platform.world.get(recordId(type,action));
 if(input.appId===null){await platform.world.put({...(current||{}),id:recordId(type,action),namespace:'os',kind:'state',title:type,tags:[tag(action)],archived:true,body:JSON.stringify({appId:null})},{writer:'os',expected:current?.revision||0,actor:'Owner',action:'cleared file default'});return fileDefaults(platform.world,undefined,action);}
 const app=installedApps(platform.world.all()).find(app=>app.id===input.appId);if(!app)fail(404,'Application not found');
 const types=fileActionTypes(app,action),direct=types.some(accepted=>accepted==='*'||accepted===type||accepted.endsWith('/*')&&type.startsWith(accepted.slice(0,-1)));
 const samples=file?[file]:platform.world.all().filter(object=>desktopFile(object)&&fileType(object)===type);
 if(!direct&&!samples.some(object=>fileApps([app],object,action).length))fail(400,'This app has not declared support for that file type');
 if(file&&!fileApps([app],file,action).length)fail(400,'This app cannot open this file');
 await platform.world.put({id:recordId(type,action),namespace:'os',kind:'state',title:type,body:JSON.stringify({appId:app.id}),tags:[tag(action)],archived:false},{writer:'os',expected:current?.revision||0,actor:'Owner',action:'changed file default'});
 return fileDefaults(platform.world,undefined,action);
}
export async function clearAppDefaults(platform,appId){for(const action of ['open','preview'])for(const[type,id]of Object.entries(fileDefaults(platform.world,undefined,action)))if(id===appId)await setFileDefault(platform,{type,appId:null},action);}

export function fileDefaultsConfigured(world,objects=world.all(),action='open'){return objects.some(object=>object.namespace==='os'&&object.kind==='state'&&object.tags.includes(tag(action))&&object.id===recordId(object.title,action));}

const policyId=(action='open')=>hash(action==='open'?'ink-os-file-associations-v1':'ink-os-preview-associations-v1').slice(0,32);
function policy(world,objects,action='open'){try{return JSON.parse((objects?objects.find(object=>object.id===policyId(action)):world.get(policyId(action)))?.body||'null');}catch{return null;}}
const publishedApps=(world,objects=world.all())=>installedApps(objects).filter(app=>{const meta=appManifest(app);return meta.releaseId||meta.url;});
// Resolve all extension/MIME samples in one pass. Matching a handler needs
// metadata, never a repeated parse of a document's potentially large body.
function fileIndex(objects,action='open'){const samples=new Map(),types=new Set();for(const file of objects){if(!(action==='preview'?previewableObject(file):desktopFile(file)))continue;const info=fileInfo(file),type=fileType(file),sample={id:file.id,kind:file.kind,namespace:file.namespace,source:file.source,title:file.title,body:JSON.stringify({originalName:info.name,mime:info.mime,bytes:info.bytes})};for(const key of [type,info.mime]){types.add(key);if(!samples.has(key))samples.set(key,sample);}if(info.mime.includes('/')&&info.mime!=='application/octet-stream')types.add(info.mime.split('/')[0]+'/*');}return{types,sample:type=>samples.get(type)||{kind:type.includes('/')||type.startsWith('.')?'file':type,namespace:'os',source:type.startsWith('.')?'file'+type:'',body:JSON.stringify({mime:type.includes('/')?type:'application/octet-stream'})}};}

function settings(platform,objects=platform.world.all(),action='open'){
 const state=policy(platform.world,objects,action),apps=publishedApps(platform.world,objects),defaults=fileDefaults(platform.world,objects,action),suggestions=[],index=fileIndex(objects,action);
 for(const app of apps)if(state?.candidates.includes(app.id))for(const[type,currentAppId]of Object.entries(defaults)){
  if(currentAppId===app.id||state.dismissed.includes(app.id+':'+type)||!fileApps([app],index.sample(type),action).length)continue;
  suggestions.push({appId:app.id,type,currentAppId});
 }
 return{defaults,configured:fileDefaultsConfigured(platform.world,objects,action),suggestions};
}
function serialized(platform,run){const task=(platform.fileDefaultsTail||Promise.resolve()).then(run);platform.fileDefaultsTail=task.catch(()=>{});return task;}
async function reconcileNow(platform,action='open'){
 const world=platform.world;let objects=world.all();const apps=publishedApps(world,objects),current=objects.find(object=>object.id===policyId(action)),prior=policy(world,objects,action),state=prior?structuredClone(prior):{version:1,baseline:apps.map(app=>app.id),candidates:[],dismissed:[],automatic:{}};
 for(const app of apps)if(!state.baseline.includes(app.id)&&!state.candidates.includes(app.id))state.candidates.push(app.id);
 const index=fileIndex(objects,action),types=new Set([...apps.flatMap(app=>fileActionTypes(app,action)).filter(type=>type!=='*'),...index.types]);
 const before=fileDefaults(world,objects,action);
 for(const type of types){const file=index.sample(type),valid=fileApps(apps,file,action);if(state.automatic[type]&&valid.some(app=>app.id===state.automatic[type]))continue;const chosen=preferredFileApp(apps,file,before,action);if(chosen)state.automatic[type]=chosen.id;else delete state.automatic[type];}
 if(!current||JSON.stringify(state)!==current.body){const updated=await world.put({id:policyId(action),kind:'state',namespace:'os',title:'File associations',tags:[action==='preview'?'preview-associations':'file-associations'],body:JSON.stringify(state)},{writer:'os',expected:current?.revision||0,actor:'File defaults'});objects=[...objects.filter(object=>object.id!==policyId(action)),updated];}
 const result=settings(platform,objects,action);platform['defaultsCache:'+action]={version:world.version,result};platform['defaultsReconciled:'+action]=world.version;return structuredClone(result);
}
export function reconcileFileDefaults(platform,action='open'){if(platform['defaultsPending:'+action])return platform['defaultsPending:'+action];const task=serialized(platform,()=>platform['defaultsReconciled:'+action]===platform.world.version&&platform['defaultsCache:'+action]?.version===platform.world.version?structuredClone(platform['defaultsCache:'+action].result):reconcileNow(platform,action));const pending=task.finally(()=>{if(platform['defaultsPending:'+action]===pending)platform['defaultsPending:'+action]=undefined;});platform['defaultsPending:'+action]=pending;return pending;}
export function fileDefaultSettings(platform,action='open'){if(platform['defaultsCache:'+action]?.version!==platform.world.version)platform['defaultsCache:'+action]={version:platform.world.version,result:settings(platform,undefined,action)};return structuredClone(platform['defaultsCache:'+action].result);}
export function resolveFileDefault(platform,fileId,action='open'){return serialized(platform,async()=>{await reconcileNow(platform,action);const file=platform.world.get(fileId);if(!file||!(action==='preview'?previewableObject(file):desktopFile(file)))fail(404,'File not found');const app=preferredFileApp(publishedApps(platform.world),file,fileDefaults(platform.world,undefined,action),action);return{appId:app?.id||null,defaults:fileDefaults(platform.world,undefined,action)};});}
export function dismissFileDefault(platform,input,action='open'){return serialized(platform,async()=>{await reconcileNow(platform,action);const type=associationType(input.type),current=platform.world.get(policyId(action)),state=policy(platform.world,undefined,action),key=input.appId+':'+type;if(!state.dismissed.includes(key)){state.dismissed.push(key);await platform.world.update(policyId(action),{body:JSON.stringify(state)},{writer:'os',expected:current.revision,actor:'Owner',action:'kept file default'});}return settings(platform,undefined,action);});}
