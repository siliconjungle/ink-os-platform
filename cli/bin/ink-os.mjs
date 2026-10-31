#!/usr/bin/env node
import { projectCLI } from './projects.mjs';
import{continuationFromEnvironment,continuationHeaders,redactConnectionSecrets}from '../../shared/continuation.mjs';
import{appInteractionCLI,APP_INTERACTIONS}from'./app-api.mjs';
import { backupCLI } from './backup.mjs';
import { nativeCLI } from './native.mjs';
import { migrationCLI, maintenanceCLI } from './migrations.mjs';
import{workflowCLI,commandCLI}from './workflows.mjs';
import { initInk, buildInk, deployInk, committedSource, previewInkCLI } from './ink.mjs';
import { prepareProjectSnapshot } from './project-checkout.mjs';
import{commandAssets}from './command-assets.mjs';
import{artifactManifest,uploadArtifact}from './artifacts.mjs';
import{parseEnv}from'node:util';
import{spawnSync}from'node:child_process';
import{randomBytes}from'node:crypto';
import {gitRuntime} from '../../server/git-runtime.mjs';
const bundledGit = gitRuntime();
const gitSync = args => spawnSync(bundledGit.executable,args,{encoding:'utf8',env:{...process.env,...bundledGit.environment}});
import{realpathSync}from'node:fs';
import{readFile,writeFile,mkdir,readdir,lstat,realpath,copyFile,chmod,open,rename,rm}from'node:fs/promises';import{join,resolve,relative,isAbsolute,sep}from'node:path';import{homedir,tmpdir}from'node:os';import{pathToFileURL}from'node:url';
function connectionURL(value){
 if(typeof value!=='string'||!value||value.length>2048||/[\x00-\x20\x7f\\]/.test(value)||value.includes('?')||value.includes('#'))throw Error('Provide a root Ink OS URL without whitespace, query or fragment');
 if(!/^https?:\/\//i.test(value)||value.slice(value.indexOf('://')+3).split('/')[0].includes('@'))throw Error('Provide an absolute http or https Ink OS URL without user information');
 let parsed;try{parsed=new URL(value);}catch{throw Error('Provide an absolute http or https Ink OS URL');}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.origin==='null')throw Error('Provide a root http or https Ink OS URL without user information');
 return parsed;
}
async function healthIdentity(url){
 let response;try{response=await fetch(new URL('/api/health',url),{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});}catch{throw Error('Ink OS identity check failed; no credentials were sent');}
 if(!response.ok||new URL(response.url).origin!==new URL(url).origin){await response.body?.cancel();throw Error('Ink OS identity check failed; no credentials were sent');}
 let size=0;const chunks=[];try{if(Number(response.headers.get('content-length'))>65536)throw Error();for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error();chunks.push(chunk);}}catch{await response.body?.cancel().catch(()=>{});throw Error('Ink OS identity response exceeds its bounded JSON contract');}
 let health;try{health=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('Ink OS identity response must be JSON');}
 if(!health||health.ok!==true||health.engine!=='Ink'||health.instanceId!==undefined&&!/^[a-f0-9]{32}$/.test(health.instanceId))throw Error('Ink OS identity response is invalid; no credentials were sent');
 return health.instanceId;
}
function savedConnectionBinding(config){
 const desktop=config.format==='ink-os-desktop-client-v1',hasExpected=Object.hasOwn(config,'expectedInstanceId'),hasInstance=Object.hasOwn(config,'instanceId'),validID=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
 if(desktop){const allowed=['format','profileId','kind','url','mode','expectedInstanceId','credentialVersion','token','instanceId','session'];if(config.kind!=='remote'||!validID(config.profileId)||!Number.isInteger(config.credentialVersion)||config.credentialVersion<0||config.credentialVersion>=64||!hasExpected||!['instance','origin-compatibility'].includes(config.mode)||Object.keys(config).some(key=>!allowed.includes(key)))throw Error('Saved desktop connection binding is invalid; update it in Connections');
  if(Object.hasOwn(config,'session')){const value=config.session,hasToken=Object.hasOwn(config,'token');if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='accountHash,generation'||value.accountHash!==null&&(typeof value.accountHash!=='string'||!/^[a-f0-9]{64}$/.test(value.accountHash))||!Number.isInteger(value.generation)||value.generation<0||value.generation>=64||value.generation>config.credentialVersion||(value.accountHash!==null)!==hasToken||hasToken&&(typeof config.token!=='string'||!config.token))throw Error('Saved desktop session metadata is invalid; update it in Connections');}
 }
 if(hasExpected&&hasInstance&&config.expectedInstanceId!==config.instanceId)throw Error('Saved instance identity fields conflict; no credentials were sent');
 if(!desktop&&!hasExpected&&!hasInstance)return null;
 const expected=hasExpected?config.expectedInstanceId:config.instanceId,mode=config.mode??'instance';
 if(mode==='origin-compatibility'){if(expected!==null)throw Error('Origin compatibility cannot carry a saved instance identity');return{mode,expectedInstanceId:null};}
 if(mode!=='instance'||!validID(expected))throw Error('Saved instance identity is invalid; log in explicitly');
 return{mode,expectedInstanceId:expected};
}
async function saveConnection(path,value){
 const parent=resolve(path,'..');await mkdir(parent,{recursive:true,mode:0o700});const directory=await lstat(parent);
 if(!directory.isDirectory()||process.getuid&&directory.uid!==process.getuid())throw Error('Choose an owned private directory for INK_OS_CONFIG');
 if((directory.mode&0o777)!==0o700&&[resolve(homedir()),resolve(tmpdir()),'/'].includes(parent))throw Error('Choose a dedicated private INK_OS_CONFIG directory instead of changing shared directory permissions');
 await chmod(parent,0o700);const temporary=join(parent,'.ink-os-connection-'+randomBytes(12).toString('hex'));let file;
 try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=null;await rename(temporary,path);const handle=await open(parent,'r');try{await handle.sync();}finally{await handle.close();}}
 finally{await file?.close();await rm(temporary,{force:true});}
}
export async function filesFrom(directory){const files=[];async function visit(path){for(const entry of await readdir(path,{withFileTypes:true})){if(entry.name==='node_modules'||entry.name==='.git'||/^\.(env|dev.vars|npmrc)(\.|$)/.test(entry.name))continue;const full=join(path,entry.name);if(entry.isSymbolicLink())throw Error('Release files cannot contain symlinks');if(entry.isDirectory())await visit(full);else files.push({path:relative(directory,full).split(sep).join('/'),base64:(await readFile(full)).toString('base64')});}}await visit(directory);return files;}
export async function desktopFromManifest(manifest,directory,override){if(!manifest.desktop&&override===undefined)return undefined;const desktop={...manifest.desktop};let icon=override??desktop.icon;const path=typeof icon==='object'&&icon?.svg&&!icon.svg.trim().startsWith('<')?icon.svg:typeof icon==='string'&&/\.svg$/i.test(icon)?icon:undefined;if(path){const full=resolve(directory,path),inside=relative(directory,full);if(inside.startsWith('..'+sep)||inside==='..'||(await lstat(full)).isSymbolicLink())throw Error('The app icon must be a source file inside its repository');icon={svg:await readFile(full,'utf8')};}if(icon!==undefined)desktop.icon=icon;return desktop;}
export async function boundedReleasePaths(manifest,directory){
 const root=await realpath(directory),inside=(parent,path)=>{const name=relative(parent,path);return !isAbsolute(name)&&name!=='..'&&!name.startsWith('..'+sep);};
 if(manifest.directory!==undefined&&(typeof manifest.directory!=='string'||!manifest.directory||/[\x00-\x1f\x7f]/.test(manifest.directory)))throw Error('Select a frontend directory inside the source repository');
 const requested=resolve(root,manifest.directory||'.'),info=await lstat(requested),assetDirectory=await realpath(requested);
 if(!inside(root,requested)||!inside(root,assetDirectory)||!info.isDirectory()||info.isSymbolicLink())throw Error('The frontend directory must be a real directory inside the source repository');
 let backendFile;
 if(manifest.backend?.entry!==undefined){
  const entry=manifest.backend.entry;if(typeof entry!=='string'||!entry||entry.length>4096||/[:\\\x00-\x1f\x7f]/.test(entry)||entry.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('The backend entry must be a relative file inside the frontend directory');
  const requestedBackend=resolve(assetDirectory,entry),backendInfo=await lstat(requestedBackend);backendFile=await realpath(requestedBackend);
  if(!inside(assetDirectory,requestedBackend)||!inside(assetDirectory,backendFile)||!backendInfo.isFile()||backendInfo.isSymbolicLink())throw Error('The backend entry must be a real file inside the frontend directory');
 }
 return{assetDirectory,backendFile};
}
export function deploymentBackend(input,{runtimeImage,installedBackend}={}){
 if(input!=null&&(typeof input!=='object'||Array.isArray(input)))throw Error('Provide a backend configuration object');
 const backend=input?{...input}:undefined;
 if(backend?.entry&&backend.image)throw Error('Select a module backend entry or a standalone image');
 if(runtimeImage!==undefined&&(!backend?.entry||backend.image))throw Error('A runtime image override requires a module backend entry');
 if(runtimeImage==='default')delete backend.runtimeImage;
 else if(runtimeImage!==undefined)backend.runtimeImage=runtimeImage;
 else if(backend?.entry&&backend.runtimeImage===undefined&&installedBackend?.entry&&!installedBackend.image&&installedBackend.runtimeImage!==undefined)backend.runtimeImage=installedBackend.runtimeImage;
 if(backend?.runtimeImage!==undefined&&(!backend.entry||backend.image||!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(backend.runtimeImage)))throw Error('Select a runtime image pinned by its full sha256 digest, or use --runtime-image default');
 return backend;
}
export async function main(args=process.argv.slice(2)){
 const options={};const positional=[];for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const option=args[i].slice(2),equals=option.indexOf('=');if(equals!==-1)options[option.slice(0,equals)]=option.slice(equals+1);else options[option]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}else positional.push(args[i]);}
 const [command='help',sub,value]=positional;
 if(command==='backup')return backupCLI({sub,options});
 const continuation=continuationFromEnvironment(process.env);
 const configPath=process.env.INK_OS_CONFIG||join(homedir(),'.config/ink-os/config.json');let config={};try{config=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let url,token,connection,identity;const explicitToken=process.env.INK_OS_TOKEN;
 async function authenticate({login=false}={}){if(!connection)connection=(async()=>{
  const selected=options.url||process.env.INK_OS_URL||config.url;if(!selected||!explicitToken&&!config.token)throw Error('Run ink-os login --url URL with INK_OS_TOKEN set');const target=connectionURL(selected);url=target.origin;token=explicitToken||config.token;
  if(typeof token!=='string'||!token||/[\r\n\x00]/.test(token))throw Error('Provide INK_OS_TOKEN explicitly or select a valid saved connection');
  if(!explicitToken){if(!config.url||connectionURL(config.url).origin!==url)throw Error('Saved credentials belong to a different origin; provide INK_OS_TOKEN explicitly or select a matching INK_OS_CONFIG');
   const binding=savedConnectionBinding(config);if(binding){identity=healthIdentity(url);const advertised=await identity;if(binding.mode==='instance'&&advertised!==binding.expectedInstanceId)throw Error('Saved instance identity does not match this host; no credentials were sent');if(binding.mode==='origin-compatibility'&&advertised!==undefined)throw Error('This host now advertises an instance identity; update its pinned connection before sending saved credentials');}
  }
 })();await connection;if(login){identity||=healthIdentity(url);await identity;}return{url,token};}
 async function projectTarget(){await authenticate();identity||=healthIdentity(url);return{origin:url,instanceId:(await identity)??null};}
 const errorMessage=message=>redactConnectionSecrets(message,[token,config.token,continuation?.token]);
 const authenticatedHeaders=target=>({Authorization:'Bearer '+token,...continuationHeaders(target,continuation)});
 async function request(path,method='GET',body){await authenticate();const target=new URL('/api/v1/'+path,url),response=await fetch(target,{method,redirect:'error',headers:{...authenticatedHeaders(target),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json().catch(()=>{throw Error('Ink OS API response must be JSON');});if(!response.ok)throw Object.assign(Error(errorMessage(result?.error||response.statusText)),{status:response.status,current:result?.current});return result;}
 const print=value=>console.log(JSON.stringify(value,null,2));
 if(command==='maintenance')return maintenanceCLI({sub,id:value,options,request,print});
 if(command==='migrations')return migrationCLI({sub,action:value,operation:positional[3],options,request,print});
 if(command==='projects')return projectCLI({sub,id:value,options,request,print,getTarget:projectTarget});
 if(command==='native')return nativeCLI({sub,appId:value,jobId:positional[3],options,request,print});
 if(command==='workflows')return workflowCLI({sub,id:value,options,request,print});
 if(command==='commands')return commandCLI({sub,appId:value,id:positional[3],options,request,print});
 if(command==='login'){await authenticate({login:true});await request('me');const instanceId=await identity;await saveConnection(configPath,{url,token,...(instanceId?{instanceId}:{})});console.log('Authenticated. Account credentials stored with mode 0600.');return;}
 if(command==='keys'){const account=options.account?'?account='+encodeURIComponent(String(options.account)):'';if(sub==='create')return print(await request('keys'+account,'POST',{name:value||'Local agent',...(options.scopes?{scopes:String(options.scopes).split(',')}:{}),expiresInDays:Number(options.days||90)}));if(sub==='rotate'||sub==='revoke'){if(!/^[a-f0-9]{24}$/.test(value||''))throw Error('Provide an API key ID');return print(await request('keys/'+value+(sub==='rotate'?'/rotate':'')+account,sub==='rotate'?'POST':'DELETE',sub==='rotate'?{}:undefined));}return print(await request('keys'+account));}
 if(command==='runtimes'){if(!sub||sub==='list')return print(await request('runtimes'));if(['reap','migrate'].includes(sub))return print(await request('runtimes/'+sub,'POST',{}));throw Error('Use runtimes list, reap or migrate');}
 if(command==='whoami')return print(await request('me'));
 if(command==='computer'){if(sub==='create')return print(await request('computer/sessions','POST',{width:Number(options.width)||1280,height:Number(options.height)||800}));if(sub==='list')return print(await request('computer/sessions'));if(sub==='close')return print(await request('computer/sessions/'+value,'DELETE'));const result=await request('computer/sessions/'+value+'/'+(sub==='action'?'action':'observe'),sub==='action'?'POST':'GET',sub==='action'?{action:JSON.parse(options.action||'{}')}:undefined);if(options.output&&result.image){await writeFile(resolve(options.output),Buffer.from(result.image.base64,'base64'));delete result.image;result.screenshot=resolve(options.output);}return print(result);}
 if(command==='versions'){
  if(['show','export','diff','delete','undelete'].includes(sub)&&!/^[a-f0-9]{32}$/.test(value||''))throw Error('Provide a saved OS version ID');
  if(sub==='create')return print(await request('versions','POST',{label:value||'Saved OS version',...(options.parent?{parent:options.parent}:{} )}));
  if(sub==='show')return print(await request('versions/'+value));
  if(sub==='export'){if(!options.output)throw Error('Specify --output PATH');const snapshot=await request('versions/'+value+'/export');await writeFile(resolve(String(options.output)),JSON.stringify(snapshot,null,2)+'\n',{flag:options.force?'w':'wx',mode:0o600});return print({path:resolve(String(options.output)),id:snapshot.id});}
  if(sub==='diff')return print(await request('versions/'+value+'/diff?against='+encodeURIComponent(options.against||'current')));
  if(sub==='delete')return print(await request('versions/'+value+(options.permanent?'?permanent=true':''),'DELETE'));
  if(sub==='undelete')return print(await request('versions/'+value+'/unarchive','POST',{}));
  if(sub&&sub!=='list')throw Error('Unknown versions command; whole-OS checkout is not available yet');
  return print(await request('versions'+(options['include-deleted']?'?archived=true':'')));
 }
 if(command==='query')return print(await request('query','POST',sub?JSON.parse(sub):Object.fromEntries(['namespace','kind','tag','space','q','limit','offset','since','order'].filter(key=>options[key]!==undefined).map(key=>[key,options[key]]))));
 if(command==='files'){
  if(sub==='defaults')return print(await request('file-defaults'));
  if(sub==='default'){if(!value||!options.clear&&!options.app)throw Error('Provide a type and --app APP_ID (or --clear)');return print(await request('file-defaults', 'PUT', {type:value,appId:options.clear?null:options.app}));}

  if(sub==='delete')return print(await request('files/'+value+(options.permanent?'?permanent=true':''),'DELETE'));
  if(sub==='restore')return print(await request('files/'+value+'/restore','POST',{}));
  if(sub==='upload'){const path=resolve(value),bytes=await readFile(path);if(bytes.length>24*1024*1024)throw Error('Keep each file below 24 MiB');return print(await request('files','POST',{files:[{name:path.split(sep).at(-1),mime:options.mime||'application/octet-stream',base64:bytes.toString('base64')}]}));}
  if(sub==='download'){if(!options.output)throw Error('Specify --output PATH');await authenticate();const target=new URL('/api/v1/files/'+value+'/content?download=1',url),response=await fetch(target,{redirect:'error',headers:authenticatedHeaders(target)});if(!response.ok)throw Error(errorMessage((await response.json()).error||'Download failed'));await writeFile(resolve(String(options.output)),Buffer.from(await response.arrayBuffer()),{flag:options.force?'w':'wx'});return print({path:resolve(String(options.output))});}
  return print(await request(options.deleted?'trash':'files'));
 }
 if(command==='call'||command==='apps'&&APP_INTERACTIONS.includes(sub))return print(await appInteractionCLI({command,sub,id:value,name:positional[3],options,request,redact:errorMessage}));
 if(command==='apps'&&sub&&!['list','icon','rename','restore','delete','duplicate','status','create','token'].includes(sub))throw Error('Unknown apps command; use apps list, api, read, send, open, action or ink-os help');
 if(command==='apps'){if(sub==='icon'){const file=options.file||positional[3];if(!file&&!options.icon)throw Error('Use apps icon ID --file icon.svg or --icon layers');const icon=file?{svg:await readFile(resolve(file),'utf8')}:options.icon;return print(await request('apps/'+value,'PATCH',{desktop:{icon}}));}if(sub==='rename')return print(await request('apps/'+value,'PATCH',{title:options.title}));if(sub==='restore')return print(await request('apps/'+value+'/restore','POST',{}));if(sub==='delete')return print(await request('apps/'+value+(options.permanent?'?permanent=true':''),'DELETE'));if(sub==='duplicate')return print(await request('apps/'+value+'/duplicate','POST',{title:options.title,copyData:!options['no-data']}));if(sub==='status')return print(await request('apps/'+value+'/status'));if(sub==='create')return print(await request('apps','POST',{slug:value,title:options.title||value,repository:options.repository,sourceCommit:options.commit}));if(sub==='token')return print(await request('apps/'+value+'/token','POST',{}));return print(await request('apps'+(options['include-deleted']?'?archived=true':'')));}
 if(command==='env'){
  if(!/^[a-f0-9]{32}$/.test(value||''))throw Error('Provide an app ID: ink-os env '+(sub||'list')+' APP_ID');
  const path='apps/'+value+'/env';
  if(sub==='list')return print(await request(path));
  if(sub==='unset'){const names=positional.slice(3);if(!names.length)throw Error('Provide variable names to remove');for(const name of names)await request(path+'/'+encodeURIComponent(name),'DELETE');return print(await request(path));}
  let values;
  if(sub==='import'){let source;if(options.file)source=await readFile(resolve(String(options.file)),'utf8');else if(options.stdin){source='';for await(const chunk of process.stdin){source+=chunk;if(Buffer.byteLength(source)>256*1024)throw Error('Environment input exceeds 256 KiB');}}else throw Error('Use --file .env or --stdin');if(Buffer.byteLength(source)>256*1024)throw Error('Environment input exceeds 256 KiB');values=parseEnv(source);}
  else if(sub==='set'){const entries=positional.slice(3);if(!entries.length)throw Error('Provide NAME=VALUE or use env import --stdin');values=Object.fromEntries(entries.map(entry=>{const at=entry.indexOf('=');if(at<1)throw Error('Use NAME=VALUE for each variable');return[entry.slice(0,at),entry.slice(at+1)];}));}
  else throw Error('Use env list, set, import, or unset');
  return print(await request(path,'PUT',{values}));
 }
 if(command==='build')return print(await buildInk(sub||'.',options));
 if(command==='ink'&&['preview','preview-run','preview-status','preview-close'].includes(sub))return print(await previewInkCLI(sub,value,positional[3],options,request,await projectTarget()));
 if(command==='ink'){if(!value)throw Error('Provide an app ID');if(sub==='describe')return print(await request('apps/'+value+'/ink'));if(sub==='checkpoint')return print(await request('apps/'+value+'/ink/checkpoint'));if(sub==='migrate'){if(!options.file)throw Error('Provide --file with explicit migration releases, entries and revisions.');return print(await request('apps/'+value+'/ink/migrate','POST',JSON.parse(await readFile(resolve(String(options.file)),'utf8'))));}if(sub==='run'){const input=options['input-file']?await readFile(resolve(options['input-file']),'utf8'):options.input||'[]';return print(await request('apps/'+value+'/ink/run','POST',{entry:positional[3]||options.entry,input,...(options.backend?{backend:options.backend}:{})}));}throw Error('Use ink describe APP_ID, ink checkpoint APP_ID, ink migrate APP_ID --file migration.json, or ink run APP_ID ENTRY --input JSON_ARRAY');}
 if(command==='deploy'){
  const directory=resolve(sub||'.'),manifest=JSON.parse(await readFile(join(directory,'ink-app.json'),'utf8'));if(manifest.language==='ink')return print(await deployInk(directory,options,request,await projectTarget()));
  const paths=await boundedReleasePaths(manifest,directory),repository=options.repository||manifest.repository,creationDesktop=await desktopFromManifest(manifest,directory,options.icon);
  const runtimeImage=options['runtime-image']??process.env.INK_OS_APP_RUNTIME_IMAGE;
  deploymentBackend(manifest.backend,{runtimeImage});
  let status=options.app?await request('apps/'+options.app+'/status'):undefined,app=status?.app||(options.app?undefined:(await request('apps')).find(a=>JSON.parse(a.body).slug===manifest.slug)),source;
  if(options.app&&app?.id!==options.app)throw Error('The selected application status is invalid');
  const installed=app&&JSON.parse(app.body),projectId=installed?.projectId||options.project;
  if(manifest.backend?.entry&&manifest.backend.runtimeImage===undefined&&runtimeImage===undefined&&installed?.releaseId&&!status)status=await request('apps/'+app.id+'/status');
  const active=status?.releases?.find(release=>release.id===installed?.releaseId);
  if(manifest.backend?.entry&&manifest.backend.runtimeImage===undefined&&runtimeImage===undefined&&installed?.releaseId&&!active)throw Error('The selected runtime metadata is unavailable; inspect app status before redeploying');
  const backend=deploymentBackend(manifest.backend,{runtimeImage,installedBackend:active&&JSON.parse(active.body).backend});
  if(options.project&&installed&&installed.projectId!==options.project)throw Error('Select the application’s existing source project or deploy a new app');
  if(projectId||!repository){
   if(installed?.repository&&!installed.projectId)throw Error('This app uses repository source; keep that source binding or create a new project app');
   const snapshot=await committedSource(directory);
   if(options.commit&&options.commit!==snapshot.commit)throw Error('The selected commit must match the clean source checkout before snapshot deployment');
   const settingsFile=snapshot.files.find(file=>file.path==='ink-project.json'),settings=settingsFile&&JSON.parse(Buffer.from(settingsFile.base64,'base64').toString('utf8'));
   const base=await prepareProjectSnapshot({directory,snapshot,projectId,request,target:await projectTarget()});
   const project=await request(projectId?'projects/'+projectId+'/snapshot':'projects/import','POST',{title:manifest.title,files:snapshot.files,tree:snapshot.tree,originCommit:snapshot.commit,expectedCommit:base.expectedCommit,...(settings?{settings}:{})});
   await base.complete(project);
   source={projectId:project.id,commit:project.commit,originCommit:snapshot.commit};
  }else{
   const revision=options.commit||manifest.sourceCommit||gitSync(['-C',directory,'rev-parse','HEAD']).stdout?.trim();if(!/^[a-f0-9]{40}$/.test(revision||''))throw Error('Deploy a committed application source tree');
   source={repository,commit:revision};const inGit=gitSync(['-C',directory,'rev-parse','--is-inside-work-tree']);if(inGit.status===0){const dirty=gitSync(['-C',directory,'status','--porcelain','--','.']);if(dirty.status!==0||dirty.stdout.trim())throw Error('Commit application source changes before deployment so the release matches its source revision');}
  }
  if(!app)app=await request('apps','POST',{slug:manifest.slug,title:manifest.title,...(source.projectId?{projectId:source.projectId}:{repository}),sourceCommit:source.commit,desktop:creationDesktop,commands:manifest.commands,capabilities:manifest.capabilities});

  if(options['env-file']){const source=await readFile(resolve(String(options['env-file'])),'utf8');if(Buffer.byteLength(source)>256*1024)throw Error('Environment input exceeds 256 KiB');await request('apps/'+app.id+'/env','PUT',{values:parseEnv(source)});}
  const retained=new Map();try{for(const part of await request('apps/'+app.id+'/artifacts'))if(part.id&&/^[a-f0-9]{64}$/.test(part.sha256))retained.set(part.sha256,part);}catch{}
  const desktop=creationDesktop;const artifacts=await artifactManifest(paths.assetDirectory,{...await commandAssets(manifest,directory),upload:async(digest,bytes)=>{await authenticate();try{return retained.get(digest)||await uploadArtifact(new URL('/api/v1/apps/'+app.id+'/artifacts/'+digest,url),bytes,{token,continuation,onRetry:({attempt,error})=>console.error('Retrying artifact upload ('+attempt+'/7; '+(error.cause?.code||error.status||error.name)+')')});}catch(error){error.message=errorMessage(error.message);throw error;}},onProgress:progress=>console.error('Prepared '+(progress.bytes/1024/1024).toFixed(1)+' MiB')});const files=[{path:'ink-assets.json',base64:Buffer.from(JSON.stringify(artifacts)).toString('base64')}];if(paths.backendFile)files.push({path:manifest.backend.entry,base64:(await readFile(paths.backendFile)).toString('base64')});const release=await request('apps/'+app.id+'/releases','POST',{files,entry:manifest.entry||'index.html',backend,desktop,commands:manifest.commands,capabilities:manifest.capabilities,source});
  if(options['preview-only'])return print({appId:app.id,releaseId:release.id,status:'ready'});
  const result=await request(`apps/${app.id}/releases/${release.id}/publish`,'POST',{});return print({appId:app.id,releaseId:release.id,url:JSON.parse(result.body).url});
 }
 if(command==='releases')return print(await request('apps/'+sub+'/releases'));
 if(command==='publish'||command==='rollback')return print(await request(`apps/${sub}/releases/${value}/publish`,'POST',{}));
 if(command==='launch')return print(await request('apps/'+sub+'/launch','POST',options.release?{releaseId:options.release}:{}));
 if(command==='invoke')return print(await request('apps/'+sub+'/invoke','POST',{path:value||'/',method:options.method||'GET',...(options.body?{body:JSON.parse(options.body)}:{})}));
 if(command==='data'){if(sub==='list')return print(await request('data?'+new URLSearchParams(Object.fromEntries(['namespace','kind','q'].filter(key=>options[key]).map(key=>[key,options[key]])))));if(sub==='get')return print(await request('data/'+value));if(sub==='create')return print(await request('data','POST',JSON.parse(await readFile(value,'utf8'))));if(sub==='update')return print(await request('data/'+value,'PATCH',{changes:JSON.parse(options.changes||'{}'),expected:Number(options.expected)}));}
 if(command==='state'){if(sub==='get')return print(await request('state/'+encodeURIComponent(value)+(options.namespace?'?namespace='+encodeURIComponent(options.namespace):'')));if(sub==='set')return print(await request('state/'+encodeURIComponent(value),'PUT',{value:JSON.parse(options.value||'null'),expected:Number(options.expected)}));}
 if(command==='init'&&options.language!=='javascript')return print(await initInk(sub||'my-app',options));
 if(command==='init'){
  const directory=resolve(sub||'my-app');await mkdir(directory,{recursive:true});for(const name of['ink-app.json','index.html','server.mjs','sdk.js','desktop-keys.mjs','live-query.mjs']){try{await lstat(join(directory,name));throw Error('Refusing to overwrite existing app file '+name);}catch(error){if(error.code!=='ENOENT')throw error;}}await writeFile(join(directory,'ink-app.json'),JSON.stringify({slug:options.slug||'my-app',title:options.title||'My app',entry:'index.html',desktop:{entry:'app',icon:'layers'},capabilities:['world.read','world.write','desktop.open'],...(options.repository?{repository:options.repository}:{}),backend:{entry:'server.mjs'}},null,2));
  for(const name of['index.html','server.mjs','sdk.js','desktop-keys.mjs','live-query.mjs'])await copyFile(new URL('../templates/'+name,import.meta.url),join(directory,name));console.log('Created '+directory);return;
 }
 console.log('ink-os maintenance seal OPERATION --file INPUT\nink-os maintenance prepare --file INPUT\nink-os maintenance status OPERATION\nink-os maintenance complete OPERATION --file INPUT\nink-os maintenance cancel OPERATION --file INPUT\nink-os migrations automation plan --file INPUT --output PLAN\nink-os migrations automation apply --file INPUT --plan PLAN\nink-os migrations automation status OPERATION\nink-os migrations automation preview-schedule --file INPUT\nink-os migrations automation review-schedule --file REVIEW --approve\nink-os migrations storage-aliases apply --file INPUT\nink-os migrations namespaces status OPERATION\nink-os migrations namespaces plan --file INPUT --output PLAN\nink-os migrations namespaces apply --file INPUT --plan PLAN\nink-os backup create --offline --directory DIR --output FILE --password-stdin\nink-os backup restore --offline --directory DIR --input FILE --password-stdin\nink-os ink checkpoint APP_ID\nink-os ink migrate APP_ID --file migration.json\nink-os projects [list | checkout ID --directory NEW_DIRECTORY | create --file settings.json | configure ID --file settings.json | duplicate ID --file settings.json | credentials ID --stdin | credentials ID --from-env NAME | credentials ID --clear | read-remote ID | source-plan ID | pull ID [--expected-remote FULL_SHA] | publication ID | publish ID [--create] [--expected-remote FULL_SHA]]\nink-os workflows [list | show ID | create --file PATH | update ID --revision N --file PATH | export ID --output PATH | preview ID --inputs-file PATH | run ID --inputs-file PATH [--approve] [--wait] | runs [ID] | status RUN_ID | wait RUN_ID | cancel RUN_ID | resume RUN_ID --approve | archive ID --revision N]\nink-os commands [list --q TEXT | show APP_ID COMMAND_ID | run APP_ID COMMAND_ID --inputs-file PATH [--approve]]\nink-os versions [list | create LABEL | show ID | diff ID --against ID | export ID --output PATH | delete ID [--permanent] | undelete ID]\nink-os keys [create NAME --scopes apps:read,apps:deploy,world:read,computer | rotate KEY_ID | revoke KEY_ID] [--account ACCOUNT_ID]\nink-os whoami\nink-os computer create [--width 1280 --height 800]\nink-os computer observe SESSION_ID --output screen.png\nink-os computer action SESSION_ID --action JSON --output screen.png\nink-os computer close SESSION_ID\nink-os login --url URL (INK_OS_TOKEN from environment)\nink-os init DIR --slug NAME (Ink source + local Git)\nink-os build DIR [--output PATH]\nink-os native status\nink-os native build APP_ID [--wait]\nink-os native jobs APP_ID\nink-os native get APP_ID JOB_ID\nink-os ink describe APP_ID\nink-os ink run APP_ID ENTRY --input JSON_ARRAY [--backend auto|native|javascript]\nink-os deploy DIR [--app ID] [--project PROJECT_ID] [--runtime-image IMAGE@sha256:DIGEST|default] [--preview-only] [--env-file .env]\nink-os apps api APP_ID\nink-os apps read APP_ID READ_NAME [--body JSON]\nink-os apps send APP_ID MESSAGE_NAME [--body JSON]\nink-os apps open APP_ID [--data JSON]\nink-os apps action REQUEST_ID\nink-os call APP_ID /path [--method METHOD] [--body JSON]\nink-os apps [list | create SLUG --repository URL | rename ID --title NAME | icon ID --file icon.svg | token ID | delete ID | restore ID | duplicate ID | status ID]\nink-os files defaults\nink-os files default TYPE --app APP_ID (or --clear)\nink-os files [list | upload PATH --mime TYPE | download ID --output PATH | delete ID [--permanent] | restore ID]\nink-os apps delete ID [--permanent]\nink-os env list APP_ID\nink-os env set APP_ID NAME=VALUE\nink-os env import APP_ID --file .env (or --stdin)\nink-os env unset APP_ID NAME...\nink-os query --kind note --namespace APP_ID --q TEXT\nink-os releases APP_ID\nink-os publish APP_ID RELEASE_ID\nink-os rollback APP_ID RELEASE_ID\nink-os launch APP_ID [--release RELEASE_ID]\nink-os invoke APP_ID /path [--method POST] [--body JSON]\nink-os data list [--namespace ID]\nink-os state get KEY [--namespace ID]');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(error=>{console.error(error.status?`${error.status}: ${error.message}`:error.message);process.exitCode=1;});
