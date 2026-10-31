import{workflowRoute}from './workflow-router.mjs';
import { buildProjectRelease, installedInk, runInstalledInk } from './ink-apps.mjs';
import { projectRoute } from './project-router.mjs';
import{commandRoute}from './app-commands.mjs';
import{scheduleRoute}from './schedule-router.mjs';
import{appAPI,callAppAPI}from './app-api.mjs';
import{loginDestination}from '../shared/app-links.mjs';
import{withAppCaller,appCaller}from './app-caller.mjs';
import{uploadArtifact,artifactRecords}from './artifacts.mjs';
import{fileDefaults,fileDefaultsConfigured,setFileDefault,reconcileFileDefaults,fileDefaultSettings,resolveFileDefault,dismissFileDefault}from './file-defaults.mjs';
import{uploadFiles,uploadBinary,fileContent,saveText}from './files.mjs';
import{desktopFile}from '../shared/desktop-placements.mjs';
import{deleteFile,purgeApp}from './deletion.mjs';
import{environmentInput}from './app-environment.mjs';
import{queryWorld}from './query.mjs';
import{authorizeRoute,KEY_SCOPES,isAdmin}from './api-keys.mjs';
import {sign,verify}from'./platform.mjs';
const error=(status,message)=>{throw Object.assign(Error(message),{status});};
export function platformRouter(platform,{send,body}){return async(req,res,url,principal)=>{
 const path=url.pathname.slice('/api/v1'.length),method=req.method;
 if(!principal)error(401,'Sign in to Ink OS');
 authorizeRoute(principal,path,method);
 if(await projectRoute(platform,req,res,url,principal,{send,body}))return;
 if(await commandRoute(platform,req,res,url,principal,{send,body}))return;
 if(await workflowRoute(platform,req,res,url,principal,{send,body}))return;
 if(await scheduleRoute(platform,req,res,url,principal,{send,body}))return;
 if(path.startsWith('/desktop/')){platform.owner(principal);const actions=platform.desktopActions;if(!actions)error(503,'Desktop action service unavailable');if(path==='/desktop/events'&&method==='GET')return actions.subscribe(principal,url.searchParams.get('clientId'),req,res);if(path==='/desktop/open'&&method==='POST'){const input=await body(req,100000);platform.app(input.appId);let source={id:'os',title:'Ink agent'};if(input.sourceAppId){const app=platform.app(input.sourceAppId);source={id:app.id,title:app.title};}return send(res,202,await actions.enqueue(principal,input,source));}if(path==='/desktop/actions/claim'&&method==='POST')return send(res,200,await actions.claim(principal,(await body(req)).clientId));const match=path.match(/^\/desktop\/actions\/([a-f0-9-]{36})(?:\/(ack))?$/);if(match&&method==='GET')return send(res,200,actions.get(principal,match[1]));if(match&&match[2]==='ack'&&method==='POST'){const input=await body(req);return send(res,200,await actions.ack(principal,match[1],input.clientId,input));}error(404,'Unknown desktop action');}
 if(path==='/runtimes'&&method==='GET'){platform.owner(principal);return send(res,200,await platform.provider?.pool?.inspect()||{slots:[],enabled:false});}
 if(path==='/runtimes/reap'&&method==='POST'){platform.owner(principal);if(!platform.provider?.pool)error(503,'Compute pool is unavailable');return send(res,200,await platform.provider.pool.reap());}
 if(path==='/runtimes/migrate'&&method==='POST'){platform.owner(principal);if(!platform.provider?.pooled)error(503,'Pooled hosting is unavailable');const migrated=[];for(const app of platform.apps()){const manifest=JSON.parse(app.body);if(manifest.releaseId){await platform.publish(app.id,manifest.releaseId,manifest.releaseId);migrated.push(app.id);}}return send(res,200,{migrated});}
 if(path.startsWith('/runtime/compute/')){if(!principal.leaseId||!platform.provider?.pool)error(403,'An active compute lease is required');const pool=platform.provider.pool;if(path==='/runtime/compute/hold'&&method==='POST')return send(res,201,await pool.hold(principal.leaseId,(await body(req)).label));if(path==='/runtime/compute/release'&&method==='POST')return send(res,200,await pool.releaseHold(principal.leaseId,(await body(req)).id));if(path==='/runtime/compute/allow-idle'&&method==='POST')return send(res,200,await pool.allowIdle(principal.leaseId));error(404,'Unknown compute operation');}
 if(path.startsWith('/calls/')){platform.owner(principal);if(method!=='POST')error(405,'Call operations require POST');const match=path.match(/^\/calls\/([a-f0-9]{32})\/(open|join|ready|signal|leave|close)$/);if(!match)error(404,'Unknown call operation');if(!platform.calls)error(503,'Calling is unavailable');return send(res,200,platform.calls.act(match[2],{...await body(req,120000),appId:match[1]}));}
 if(path==='/me'&&method==='GET')return send(res,200,{accountId:principal.accountId||'owner',accountName:principal.accountName||'Admin',admin:isAdmin(principal),appId:principal.appId,namespace:principal.namespace,keyId:principal.keyId,scopes:principal.keyId?principal.scopes:principal.owner?KEY_SCOPES:['world:read','world:write']});
 if(path==='/native'&&method==='GET'){if(!principal.owner){const app=JSON.parse(platform.app(principal.appId).body);if(!app.capabilities?.includes('code.execute'))error(403,'Ink execution not granted');}return send(res,200,await platform.nativeJobs.status());}
 if(path==='/accounts'||path.startsWith('/accounts/')){
  if(!isAdmin(principal))error(403,'Only the admin can grant account access');
  if(path==='/accounts'&&method==='GET')return send(res,200,platform.apiKeys.listAccounts());
  if(path==='/accounts'&&method==='POST')return send(res,201,await platform.apiKeys.createAccount(await body(req)));
  if(/^\/accounts\/[a-f0-9]{24}$/.test(path)&&method==='PATCH')return send(res,200,await platform.apiKeys.updateAccount(path.split('/')[2],await body(req)));
  error(404,'Unknown account operation');
 }
 if(path==='/keys'||path.startsWith('/keys/')){
  platform.owner(principal);
  const accountId=url.searchParams.get('account')||principal.accountId||'owner';
  if(accountId!==(principal.accountId||'owner')&&!isAdmin(principal))error(403,'You can manage only your own keys');
  if(!platform.apiKeys.account(accountId))error(404,'Account not found');
  if(path==='/keys'&&method==='GET')return send(res,200,platform.apiKeys.list(accountId));
  if(path==='/keys'&&method==='POST'){
   const input=await body(req);if(input.accountId!==undefined&&input.accountId!==accountId)error(400,'Account identity comes from the authenticated session');
   if(principal.keyId&&!isAdmin(principal)){if(!input.scopes)error(400,'Select key permissions');const remaining=(platform.apiKeys.find(principal.keyId).expiresAt-Date.now())/86400000;input.expiresInDays=Math.min(input.expiresInDays||90,remaining);}
   return send(res,201,await platform.apiKeys.create(input,accountId,isAdmin(principal)?undefined:principal.scopes));
  }
  const match=path.match(/^\/keys\/([a-f0-9]{24})(?:\/(rotate))?$/);
  if(match&&method==='POST'&&match[2]){
   const issued=await platform.apiKeys.rotate(match[1],accountId,isAdmin(principal)?undefined:principal.scopes);
   if(principal.keyId===match[1]&&req.headers.cookie&&platform.adminToken)res.setHeader('Set-Cookie',`ink_os_session=${sign({owner:true,keyId:issued.id,exp:Math.min(Date.now()+7*86400000,issued.expiresAt)},platform.adminToken)}; Path=/; HttpOnly; ${platform.origin?.startsWith('https:')?'Secure; ':''}SameSite=Lax`);
   return send(res,201,issued);
  }
  if(match&&method==='DELETE'&&!match[2])return send(res,200,await platform.apiKeys.revoke(match[1],accountId));
  error(404,'Unknown key operation');
 }
 if(path==='/computer/sessions'&&method==='POST'){platform.owner(principal);return send(res,201,await platform.computer.create(principal,await body(req)));}
 if(path==='/computer/sessions'&&method==='GET'){platform.owner(principal);return send(res,200,await platform.computer.request('/sessions?actor='+encodeURIComponent(platform.computer.actor(principal))));}
 const computerMatch=path.match(/^\/computer\/sessions\/([a-f0-9]{32})(?:\/(observe|action))?$/);
 if(computerMatch){platform.owner(principal);return send(res,200,await platform.computer.call(principal,computerMatch[1],method==='DELETE'?'close':computerMatch[2]||'observe',method==='POST'?await body(req):{}));}

 if(path==='/versions'||path.startsWith('/versions/')){
  if(method!=='GET')platform.owner(principal);if(!platform.versions)error(503,'OS version history is unavailable');
  if(path==='/versions'&&method==='GET')return send(res,200,platform.versions.list({includeDeleted:url.searchParams.get('archived')==='true'}));
  if(path==='/versions'&&method==='POST')return send(res,201,await platform.versions.create(await body(req)));
  const version=path.match(/^\/versions\/([a-f0-9]{32})(?:\/(export|diff|unarchive))?$/);if(!version)error(404,'OS version not found');
  const[,key,action]=version;
  if(action==='export'&&method==='GET')return send(res,200,await platform.versions.read(key));
  if(action==='diff'&&method==='GET')return send(res,200,await platform.versions.diff(key,{against:url.searchParams.get('against')||'current'}));
  if(action==='unarchive'&&method==='POST')return send(res,200,await platform.versions.archive(key,{restore:true}));
  if(!action&&method==='GET')return send(res,200,platform.versions.get(key));
  if(!action&&method==='DELETE')return send(res,200,await platform.versions.archive(key,{permanent:url.searchParams.get('permanent')==='true'}));
  error(405,'Unsupported OS version operation');
 }
 const asApp=id=>{platform.app(id);if(!principal.owner&&principal.appId!==id)error(403,'Wrong app identity');return principal.owner?{owner:false,appId:id,namespace:id}:{...principal,owner:false,appId:id,namespace:id};};
 const sync=path.match(/^\/sync\/(os|[a-f0-9]{32})\/([^/]+)$/);if(sync){const namespace=sync[1],key=decodeURIComponent(sync[2]),kind=url.searchParams.get('kind')||'state';if(method==='GET')return send(res,200,await platform.collaboration.snapshot(await platform.collaboration.openFor(principal,namespace,key,kind,{create:!!principal.owner||principal.namespace===namespace})));if(method==='POST')return send(res,200,await platform.collaboration.submit(principal,namespace,key,kind,(await body(req)).updates));}
 if(path==='/file-defaults'){platform.owner(principal);if(method==='GET')return send(res,200,fileDefaultSettings(platform));if(method==='PUT')return send(res,200,{defaults:await setFileDefault(platform,await body(req))});}
 if(path==='/file-defaults/reconcile'&&method==='POST'){platform.owner(principal);return send(res,200,await reconcileFileDefaults(platform));}
 if(path==='/file-defaults/resolve'&&method==='POST'){platform.owner(principal);return send(res,200,await resolveFileDefault(platform,(await body(req)).fileId));}
 if(path==='/file-defaults/dismiss'&&method==='POST'){platform.owner(principal);return send(res,200,await dismissFileDefault(platform,await body(req)));}
 if(path.startsWith('/file-defaults/')&&method==='DELETE'){platform.owner(principal);return send(res,200,{defaults:await setFileDefault(platform,{type:decodeURIComponent(path.slice('/file-defaults/'.length)),appId:null})});}
 if(path==='/trash'&&method==='GET'){platform.owner(principal);return send(res,200,platform.world.all().filter(o=>o.archived&&['note','image','task','code','space','app','view','link','audio','video','file'].includes(o.kind)).map(o=>platform.world.publicObject(o)));}
 if(path==='/files/upload'&&method==='POST')return send(res,201,await uploadBinary(platform,req,url,principal));
 if(path==='/files'&&method==='GET')return send(res,200,platform.world.publicAll().filter(desktopFile));
 if(path==='/files'&&method==='POST')return send(res,201,await uploadFiles(platform,await body(req,34*1024*1024),principal.namespace,principal.writeAccess));
 if(/^\/files\/[a-f0-9]{32}\/content$/.test(path)&&method==='PUT')return send(res,200,await saveText(platform,path.split('/')[2],await body(req,26*1024*1024),principal));
 if(/^\/files\/[a-f0-9]{32}\/content$/.test(path)&&['GET','HEAD'].includes(method))return fileContent(platform,req,res,url);
 const fileMatch=path.match(/^\/files\/([a-f0-9]{32})(?:\/(restore))?$/);
 if(fileMatch){platform.owner(principal);if(fileMatch[2]==='restore'&&method==='POST')return send(res,200,await deleteFile(platform,fileMatch[1],{restore:true}));if(!fileMatch[2]&&method==='DELETE')return send(res,200,await deleteFile(platform,fileMatch[1],{permanent:url.searchParams.get('permanent')==='true'}));}
 const match=path.match(/^\/apps\/([a-f0-9]{32})(?:\/(.*))?$/);
 if(path==='/apps'&&method==='GET'){platform.owner(principal);return send(res,200,platform.apps({includeArchived:url.searchParams.get('archived')==='true'}));}
 if(path==='/apps'&&method==='POST'){platform.owner(principal);return send(res,201,await platform.createApp(await body(req)));}
 if(match){const [,appId,action='']=match;if(action==='status'&&method==='GET'){platform.owner(principal);const app=platform.world.get(appId);if(app?.kind!=='app'||app.namespace!=='os')error(404,'Application not found');return send(res,200,{app:platform.world.publicObject(app),releases:platform.world.all().filter(record=>record.kind==='release'&&JSON.parse(record.body).appId===appId).map(record=>platform.world.publicObject(record))});}if(!action&&method==='PATCH'){platform.owner(principal);return send(res,200,await platform.updateApp(appId,await body(req)));}if(action==='restore'&&method==='POST'){platform.owner(principal);return send(res,200,await platform.restoreApp(appId));}if(!action&&method==='DELETE'&&url.searchParams.get('permanent')==='true'){platform.owner(principal);return send(res,200,await purgeApp(platform,appId));}if(/^releases\/[a-f0-9]{32}\/park$/.test(action)&&method==='POST'){platform.owner(principal);return send(res,200,await platform.parkRelease(appId,action.split('/')[1]));}platform.app(appId);if(!action&&method==='DELETE'){platform.owner(principal);return send(res,200,await platform.deleteApp(appId));}if(action==='repair-data'&&method==='POST'){platform.owner(principal);return send(res,200,await platform.repairForkData(appId));}
  if(action==='env'){if(!principal.owner&&principal.appId!==appId)error(403,'Wrong app identity');if(method==='GET')return send(res,200,platform.listEnvironment(appId));if(method==='PUT'){const input=await body(req,256*1024);return send(res,200,await platform.updateEnvironment(appId,environmentInput(input),[],principal.writeAccess));}}
  if(action.startsWith('env/')&&method==='DELETE'){if(!principal.owner&&principal.appId!==appId)error(403,'Wrong app identity');return send(res,200,await platform.updateEnvironment(appId,{},[decodeURIComponent(action.slice(4))],principal.writeAccess));}
  if(action==='duplicate'&&method==='POST'){platform.owner(principal);return send(res,201,await platform.duplicate(appId,await body(req)));}
  if(action==='build'&&method==='POST'){platform.owner(principal);return send(res,201,await buildProjectRelease(platform,appId,await body(req)));}
  if(action==='native'&&method==='GET'){asApp(appId);return send(res,200,platform.nativeJobs.list(appId));}
  if(action==='native/build'&&method==='POST'){asApp(appId);const input=await body(req),manifest=JSON.parse(platform.app(appId).body);if(!principal.owner&&(!manifest.capabilities?.includes('code.execute')||input.releaseId&&input.releaseId!==manifest.releaseId||principal.releaseId&&principal.releaseId!==manifest.releaseId))error(403,'Native builds require the current app and code.execute');return send(res,202,await platform.nativeJobs.enqueue(appId,input.releaseId||manifest.releaseId));}
  if(/^native\/[a-f0-9]{32}$/.test(action)&&method==='GET'){asApp(appId);return send(res,200,platform.nativeJobs.get(appId,action.split('/')[1]));}
  if(action==='ink'&&method==='GET'){asApp(appId);const app=await installedInk(platform,appId,principal.releaseId);return send(res,200,{spec:app.spec,entries:app.entries,namedTypes:app.namedTypes,releaseId:app.releaseId});}
  if(action==='ink/run'&&method==='POST'){asApp(appId);return send(res,200,await runInstalledInk(platform,appId,await body(req),principal));}
  if(action==='artifacts'&&method==='GET'){platform.owner(principal);return send(res,200,artifactRecords(platform,appId));}
  if(/^artifacts\/[a-f0-9]{64}$/.test(action)&&method==='PUT'){platform.owner(principal);return send(res,201,await uploadArtifact(platform,req,appId,action.split('/')[1]));}
  if(action==='releases'&&method==='GET'){platform.owner(principal);return send(res,200,platform.releases(appId));}
  if(action==='releases'&&method==='POST'){platform.owner(principal);return send(res,201,await platform.createRelease(appId,await body(req)));}
  if(/^releases\/[a-f0-9]{32}\/publish$/.test(action)&&method==='POST'){platform.owner(principal);return send(res,200,await platform.publish(appId,action.split('/')[1],(await body(req)).expected));}
  if(action==='launch'&&method==='POST'){platform.owner(principal);return send(res,200,await platform.launch(appId,await body(req)));}
  if(action==='caller'&&method==='POST')return send(res,200,appCaller(platform,principal,appId,await body(req)));
  if(action==='api'&&method==='GET')return send(res,200,appAPI(platform,appId));
  if(action==='call'&&method==='POST')return send(res,200,await callAppAPI(platform,principal,appId,await body(req,100000)));
  if(action==='invoke'&&method==='POST'){const caller=asApp(appId),input=await body(req);if(caller.releaseId){if(input.releaseId&&input.releaseId!==caller.releaseId)error(403,'A runtime can invoke only its own release');input.releaseId=caller.releaseId;}return send(res,200,await platform.invoke(appId,withAppCaller(platform,principal,appId,input)));}
  if(action==='code/run'&&method==='POST'){asApp(appId);if(!platform.code)error(503,'Ink execution unavailable');const input=await body(req);return send(res,200,typeof input.source==='string'?await platform.code.run({...input,namespace:appId,instance:appId,principal:asApp(appId)}):await runInstalledInk(platform,appId,input,principal));}
  if(action==='token'&&method==='POST'){platform.owner(principal);return send(res,200,{token:await platform.serviceToken(appId),namespace:appId});}
  if(action==='data'&&method==='POST')return send(res,201,await platform.dataCreate(asApp(appId),await body(req)));
  if(/^data\/[a-f0-9]{32}$/.test(action)&&method==='PATCH'){const input=await body(req);return send(res,200,await platform.dataUpdate(asApp(appId),action.split('/')[1],input.changes,input.expected,input.mutationId));}
 }
 if(path.startsWith('/runtime/bundle/')&&method==='GET'){const release=platform.world.get(path.split('/').at(-1));if(release?.kind!=='release')error(404,'Release not found');return send(res,200,await platform.bundle(release.id));}
 if(path==='/query'&&method==='POST')return send(res,200,queryWorld(platform.world,await body(req)));
 if(path==='/data'&&method==='GET'){let objects=url.searchParams.get('namespace')?platform.world.query('in_namespace',[url.searchParams.get('namespace')]):platform.world.publicAll();const kind=url.searchParams.get('kind'),query=url.searchParams.get('q')?.toLowerCase();if(kind)objects=objects.filter(o=>o.kind===kind);if(query)objects=objects.filter(o=>[o.title,o.body,o.tags.join(' ')].join(' ').toLowerCase().includes(query));return send(res,200,objects.map(o=>platform.world.publicObject(o)));}
 if(path==='/data'&&method==='POST')return send(res,201,await platform.dataCreate(principal,await body(req)));
 if(/^\/data\/[a-f0-9]{32}$/.test(path)){const key=path.split('/')[2];if(method==='GET'){const object=platform.world.get(key);return object?send(res,200,platform.world.publicObject(object)):send(res,404,{error:'Object not found'});}if(method==='PATCH'){const input=await body(req);return send(res,200,await platform.dataUpdate(principal,key,input.changes,input.expected,input.mutationId));}}
 if(path.startsWith('/state/')){const key=decodeURIComponent(path.slice(7));if(method==='GET')return send(res,200,await platform.state(principal,key,url.searchParams.get('namespace')));if(method==='PUT'){const input=await body(req);return send(res,200,await platform.state(principal,key,undefined,input.value,input.expected,true));}}
 if(path==='/assets'&&method==='POST'){const input=await body(req),bytes=Buffer.from(input.base64||'','base64');if(!bytes.length||bytes.length>16*1024*1024)error(400,'Asset must be 1 byte–16 MiB');const blob=await platform.storage.put(bytes,input.mime,{retain:true});let object;try{object=await platform.dataCreate(principal,{kind:'file',title:input.title||'',location:blob.location,body:JSON.stringify({mime:input.mime||'application/octet-stream',bytes:bytes.length})});}finally{blob.release?.();}return send(res,201,object);}
 if(/^\/assets\/[a-f0-9]{32}$/.test(path)&&method==='GET'){const object=platform.world.get(path.split('/')[2]);if(!object?.location)error(404,'Asset not found');res.setHeader('Content-Type',JSON.parse(object.body).mime||'application/octet-stream');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');res.end(await platform.storage.get(object.location));return;}
 if(path==='/events'&&method==='GET'){res.setHeader('Content-Type','text/event-stream');res.writeHead(200,{'Cache-Control':'no-store',Connection:'keep-alive'});res.write('data: '+JSON.stringify({type:'ready',version:platform.world.version})+'\n\n');const ns=url.searchParams.get('namespace');const stillAuthorized=()=>{const current=platform.principal(req);if(!current)return false;try{authorizeRoute(current,path,method);return true;}catch{return false;}};const unsubscribe=platform.world.subscribe(event=>{if(!stillAuthorized()){res.end();return;}if(ns&&(event.namespace||event.object?.namespace)!==ns)return;const visible=event.object?{...event,object:platform.world.publicObject(event.object)}:event;res.write('data: '+JSON.stringify(visible)+'\n\n');});const timer=setInterval(()=>{if(!stillAuthorized())res.end();else res.write(': heartbeat\n\n');},20000);req.on('close',()=>{clearInterval(timer);unsubscribe();});return;}
 error(404,'Unknown Ink OS operation');
};}
export function loginPage(destination='/'){const target=loginDestination(destination);return `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ink OS</title><link rel="icon" type="image/svg+xml" href="/ink.svg"><style>html{background:#101010;color:#ddd;font:14px system-ui}body{margin:0;display:grid;place-items:center;height:100dvh}form{width:260px;display:grid;gap:18px}h1{font-size:30px;letter-spacing:-2px}input,button{padding:13px;border-radius:12px;border:1px solid #ffffff20;background:#202020;color:inherit;font:inherit}button{cursor:pointer}p{color:#aaa;font-size:12px}</style><form><h1>ink</h1><input type="password" name="token" aria-label="Account key" placeholder="Account key" required autocomplete="current-password"><button>${target==='/'?'Open desktop':'Open app'}</button><p role="status"></p></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:e.target.token.value})});if(r.ok)location.href=${JSON.stringify(target)};else document.querySelector('p').textContent='Account key not accepted';}</script></html>`;}
