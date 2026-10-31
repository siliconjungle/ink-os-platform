import{Workflows}from './workflows.mjs';
import { Projects } from './projects.mjs';
import { NativeInk } from './native-ink.mjs';
import { NativeJobs } from './native-jobs.mjs';
import { drainHost } from './shutdown.mjs';
import { httpConnections } from './http-connections.mjs';
import{DesktopActions}from './desktop-actions.mjs';
import{errorStatus}from './error-status.mjs';
import{Schedules}from './schedules.mjs';
import{CallRooms}from './call-rooms.mjs';
import{presenceColor}from '../shared/presence-colors.mjs';
import {reconcileFileDefaults} from './file-defaults.mjs';
import{Versions}from './versions.mjs';
import{requestJSON}from './request-body.mjs';
import{fileContent,uploadFiles}from './files.mjs';
import{updatePresence,visiblePeer,announcedPresence,expiredPresence,touchPresence}from './presence.mjs';
import{serveModule}from './modules.mjs';
import{Collaboration}from './collaboration.mjs';
import{Computer}from './computer.mjs';
import{GitHubSources}from './github-sources.mjs';import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { World, id, plain } from './world.mjs';
import { Storage } from './storage.mjs';
import { Code } from './code.mjs';
import {Platform,sign,verify} from './platform.mjs';
import {platformRouter,loginPage} from './platform-router.mjs';
import {FlyProvider} from '../infra/fly-provider.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { DockerCompute } from '../infra/docker-compute.mjs';
import {PooledProvider} from '../infra/pooled-provider.mjs';
import {edgeGatewayRoute} from './edge-gateway.mjs';
import {staticFiles} from './static.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4318);
const production=process.env.NODE_ENV==='production';
const origin=process.env.INK_OS_ORIGIN||`http://127.0.0.1:${port}`;
const data = process.env.INK_OS_DATA_DIR || join(root, '.data');
const world = await new World(data).open();
const storage = await new Storage(data).open();
const embeddings={describe:()=>({status:'disabled',model:'',dimensions:0,error:''})}; const code = new Code(root,join(data,'code'),world);
const clients = new Map();
const vite = process.env.INK_OS_DEV!=='1'?null:await createViteServer({ root, server: { middlewareMode: true, hmr: { host: '127.0.0.1', port: 24678 } }, appType: 'spa' });
const serve=process.env.INK_OS_DEV!=='1'?staticFiles(join(root,'dist')):(req,res)=>vite.middlewares(req,res,()=>{res.statusCode=404;res.end();});
const platform=await new Platform({root,directory:data,world,storage,origin,adminToken:process.env.INK_OS_ADMIN_TOKEN||(!production?'local-development-only':undefined),sourceProvider:process.env.INK_OS_GITHUB_TOKEN?new GitHubSources():undefined,provider:process.env.FLY_API_TOKEN?(process.env.INK_OS_HOSTING==='pool'?new PooledProvider({fly:new FlyProvider()}):new FlyProvider()):new LocalProvider({compute:process.env.INK_OS_BACKENDS==='docker'?new DockerCompute():undefined})}).open();
platform.projects = await new Projects(data).open();
platform.calls=new CallRooms({clients,app:id=>platform.app(id),...(process.env.INK_OS_RTC_ICE_SERVERS?{iceServers:JSON.parse(process.env.INK_OS_RTC_ICE_SERVERS)}:{})});
await reconcileFileDefaults(platform);
platform.code=code;platform.computer=new Computer(platform);platform.collaboration=new Collaboration({directory:data,world,storage});await platform.collaboration.recover();platform.versions=new Versions({world,collaboration:platform.collaboration,storage,bundle:key=>platform.bundle(key)});
platform.nativeJobs=await new NativeJobs(data,{native:new NativeInk(join(data,'native'),{cargo:process.env.INK_NATIVE_CARGO||'cargo',rustc:process.env.INK_NATIVE_RUSTC||'rustc',offline:process.env.INK_NATIVE_OFFLINE==='1'}),enabled:process.env.INK_OS_NATIVE!=='0',source:async(appId,releaseId)=>{platform.app(appId);const release=world.get(releaseId);if(release?.kind!=='release'||JSON.parse(release.body).appId!==appId)throw Object.assign(Error('Native source release not found.'),{status:404});const bundle=await platform.bundle(releaseId);if(!bundle.ink)throw Object.assign(Error('This release has no Ink program.'),{status:400});return Buffer.from(bundle.files.find(file=>file.path===bundle.ink.source).base64,'base64').toString('utf8');}}).open();
code.nativeJobs=platform.nativeJobs;
if(production&&!platform.adminToken)throw Error('INK_OS_ADMIN_TOKEN is required');
platform.schedules=await new Schedules({directory:data,platform}).open();
platform.workflows=await new Workflows({directory:data,platform}).open();
platform.desktopActions=await new DesktopActions(data).open();
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(plain(body))); };
const clientAuthorized=client=>{const principal=platform.principal(client.request);return !production||principal?.owner&&(!principal.keyId||principal.scopes.includes('computer'));};
const broadcast = event => { for (const client of clients.values()) { if(!clientAuthorized(client)){client.res.end();continue;}client.res.write(`data: ${JSON.stringify(plain(event))}\n\n`); } };
const presence = viewer => [...clients.values()].filter(announcedPresence).map(peer=>visiblePeer(peer,viewer));
const broadcastPresence=view=>{for(const client of clients.values()){
 if(!clientAuthorized(client)){client.res.end();continue;}
 if(!view||client.view===view)client.res.write('data: '+JSON.stringify({type:'presence',peers:presence(client)})+'\n\n');
}};
const body = requestJSON;
const publicEvent = event => event.object ? { ...event, object: world.publicObject(event.object) } : event;
world.subscribe(event => broadcast(publicEvent(event)));
const actorFor = req => decodeURIComponent(String(req.headers['x-ink-actor'] || 'Owner')).slice(0, 80);

async function importFile(file, space, actor, namespace='os') {const result=await uploadFiles(platform,{files:[file]},namespace);const object=result.objects[0];return space?world.update(object.id,{spaces:[space]},{writer:namespace,actor}):object;}

async function api(req, res, url) {
  const path = url.pathname; const actor = actorFor(req);
  if (path === '/api/events') {
    const key=url.searchParams.get('client')||id(),principal=platform.principal(req),accountId=principal?.accountId||'owner',previous=clients.get(key);
    if(previous&&previous.accountId!==accountId)return send(res,403,{error:'This connection belongs to another account'});
    res.setHeader('Content-Type','text/event-stream');
    res.writeHead(200,{'Cache-Control':'no-cache',Connection:'keep-alive'});
    const sameAccount=[...clients.values()].find(peer=>peer.accountId===accountId),name=accountId!=='owner'?principal?.accountName||'Guest':url.searchParams.get('name')||'Owner';
    const client={id:key,res,request:req,accountId,name:name.slice(0,60),color:sameAccount?.color||presenceColor(accountId,[...clients.values()]),view:'home',cursor:null,presenceLease:url.searchParams.get('presence')==='1',lastSeen:Date.now()};
    clients.set(key,client);previous?.res.end();platform.calls.attach(key);broadcastPresence();
    res.write(`data: ${JSON.stringify({type:'ready',version:world.version})}\n\n`);
    const authorized=()=>{const principal=platform.principal(req);return !production||principal?.owner&&(!principal.keyId||principal.scopes.includes('computer'));};
    const timer=setInterval(()=>{if(!authorized()||expiredPresence(client))res.end();else res.write(': heartbeat\n\n');},20000);
    res.on('close',()=>{clearInterval(timer);clearTimeout(client.gestureTimer);if(clients.get(key)===client){clients.delete(key);platform.calls.detach(key);broadcastPresence();}});return;
  }
  if(path==='/api/presence'&&req.method==='POST'){
    const input=await body(req),client=clients.get(input.client),accountId=platform.principal(req)?.accountId||'owner',connected=touchPresence(client,accountId);
    if(client&&!connected)return send(res,403,{error:'This connection belongs to another account'});
    if(connected){const previousView=client.view,previousWindow=client.window;if(updatePresence(client,input)){broadcastPresence(previousView!==client.view||previousWindow!==client.window?undefined:client.view);clearTimeout(client.gestureTimer);if(client.gesture){client.gestureTimer=setTimeout(()=>{client.gesture=null;broadcastPresence(client.view);},1200);client.gestureTimer.unref();}}}
    return send(res,200,{ok:true,connected});
  }
  if (path === '/api/world') return send(res, 200, { documents:{version:1},collaboration:{version:2},objects: world.desktopAll(), history: world.history.map(({ before, after, ...rest }) => rest), stats: world.stats(), embeddings: embeddings.describe(), storage: storage.describe(), peers: presence() });
  if (path === '/api/metadata') return send(res, 200, { history: world.history.map(({ before, after, ...rest }) => rest), stats: world.stats(), embeddings: embeddings.describe(), storage: storage.describe() });
  if (path === '/api/health') return send(res, 200, { ok: true, engine: 'Ink', version: world.version, embeddings: embeddings.describe() });
  if (path === '/api/objects' && req.method === 'POST') {
    const input = await body(req); if(input.kind==='os.version')throw Object.assign(Error('Use the OS version API for saved versions'),{status:403}); const o = await world.create(input, { actor, action: 'created' });  return send(res, 201, world.publicObject(o));
  }
  const objectMatch = path.match(/^\/api\/objects\/([a-f0-9]{32})(?:\/(revisions))?$/);
  if (objectMatch) {
    const key = objectMatch[1];
    if (objectMatch[2]) return send(res, 200, world.history.filter(h => h.objectId === key));
    if (req.method === 'PATCH') {
      const { changes, expected, mutationId } = await body(req);
      if(world.get(key)?.kind==='os.version'||changes.kind==='os.version')throw Object.assign(Error('Use the OS version API for saved versions'),{status:403});
      const o = await world.update(key, changes, { expected, actor, mutationId, action: changes.archived ? 'archived' : 'updated' });
      return send(res, 200, world.publicObject(o));
    }
    const o = world.get(key); return o ? send(res, 200, world.publicObject(o)) : send(res, 404, { error: 'Object not found' });
  }
  if (path === '/api/search' && req.method === 'POST') {
    const input = await body(req); const query = String(input.query || '').trim();
    let objects = input.space ? world.query('in_space', [input.space]) : world.query('select', [input.kind || '', input.tag || '', !!input.starred]);
    if (input.kind) objects = objects.filter(o => o.kind === input.kind);
    let scores = new Map(); let mode = 'exact';
    if (query) {
      const lower = query.toLowerCase(), tokens = lower.split(/[^\p{L}\p{N}]+/u).filter(t => t && !new Set(['a', 'an', 'the', 'to', 'of', 'in', 'into', 'and', 'or', 'for', 'is', 'it', 'my', 'with']).has(t));
      objects = objects.map(o => {
        const text = [o.title, o.summary, o.body, ...o.tags].join(' ').toLowerCase();
        const words = new Set(text.split(/[^\p{L}\p{N}]+/u));
        const lexical = (o.title.toLowerCase().includes(lower) ? (o.kind==='app'?2:0.5) : 0) + tokens.filter(t => words.has(t)).length / Math.max(1, tokens.length) * 0.3;
        return { ...o, score: (scores.get(o.id) || 0) + lexical };
      }).filter(o => o.score > (mode === 'semantic' ? 0.19 : 0)).sort((a, b) => b.score - a.score);
    }
    return send(res, 200, { objects: objects.map(o => world.publicObject(o)), mode });
  }
  if (path === '/api/import' && req.method === 'POST') {
    const { files, space, namespace='os' } = await body(req,34*1024*1024);if(namespace!=='os'&&!platform.apps().some(app=>app.id===namespace))throw Error('Unknown importing app'); const imported = [];
    for (const file of files.slice(0, 12)) imported.push(await importFile(file, space, actor,namespace));
    return send(res, 201, { objects: imported });
  }
  if (path === '/api/import-url' && req.method === 'POST') {
    const { url: source, space } = await body(req); const parsed = new URL(source);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw Error('Use an HTTP or HTTPS source');
    const response = await fetch(source, { signal: AbortSignal.timeout(20000) }); if (!response.ok) throw Error(`Source returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 24 * 1024 * 1024) throw Error('Keep linked imports below 24 MB');
    const mime = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    if (mime.startsWith('image/')) {
      const blob = await storage.put(bytes, mime,{retain:true}); let o;try{o = await world.put({ kind: 'image', title: parsed.pathname.split('/').pop() || parsed.hostname, summary: `From ${parsed.hostname}`, source, location: blob.location, cover: 'import', spaces: space ? [space] : [], tags: ['linked'] }, { actor, action: 'linked' });}finally{blob.release?.();}return send(res, 201, world.publicObject(o));
    }
    const html = bytes.toString(); const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || parsed.hostname;
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 20000);
    const o = await world.put({ kind: 'link', title, body: text, summary: text.slice(0, 180), source, location: source, tags: ['linked'], spaces: space ? [space] : [], cover: 'link' }, { actor, action: 'linked' });return send(res, 201, world.publicObject(o));
  }
  if (path === '/api/blob') {
    const location=url.searchParams.get('location')||'',digest=location.match(/(?:blob:|\/objects\/)([a-f0-9]{64})$/)?.[1];const refs=Object.values(world.blobRefs).flat();if(!refs.some(value=>value===location||digest&&value.includes(digest))&&!JSON.stringify({objects:world.all(),history:world.history}).includes(location))throw Object.assign(Error('Asset not found'),{status:404});
    const bytes = await storage.get(location);
    const download=url.searchParams.get('download');if(download)res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(download.slice(0,180)));
    res.writeHead(200, { 'Content-Type': url.searchParams.get('mime') || 'application/octet-stream', 'Cache-Control':production?'private, no-store':'public, max-age=31536000, immutable','Content-Security-Policy':"sandbox; default-src 'none'",'X-Content-Type-Options':'nosniff' }); res.end(bytes); return;
  }
  if (path === '/api/storage/connect' && req.method === 'POST') return send(res, 200, await storage.connect(await body(req)));
  if (path === '/api/storage/list') return send(res, 200, await storage.list(url.searchParams.get('prefix') || ''));
  if (path === '/api/storage/import' && req.method === 'POST') {
    const { entries } = await body(req); const result = [];
    for (const entry of entries.slice(0, 100)) {
      const o = await world.put({ kind: /\.(jpg|jpeg|png|webp|gif)$/i.test(entry.key) ? 'image' : 'file', title: entry.key.split('/').pop(), source: entry.location, location: entry.location, body: JSON.stringify({ bytes: entry.size }), tags: ['s3'], cover: 'import' }, { actor, action: 'connected' }); result.push(world.publicObject(o));
    }
    return send(res, 201, result);
  }
  if (path === '/api/code/run' && req.method === 'POST') return send(res, 200, await code.run(await body(req)));
  if (path === '/api/code/world') return send(res, 200, { source: await readFile(join(root, 'ink/world.ink'), 'utf8'), stats: world.stats() });
  return send(res, 404, { error: 'This action does not exist' });
}

const platformAPI=platformRouter(platform,{send,body});
const requests=new Set(),responses=new Set();let draining=false,sealed=false,shutdownTask;
const server = http.createServer(async (req, res) => {
 let finish;const task=new Promise(resolve=>finish=resolve);requests.add(task);responses.add(res);res.once('close',()=>responses.delete(res));
 try{
  const url=new URL(req.url,origin);
  if(sealed){res.setHeader('Connection','close');return send(res,503,{error:'This host is stopping.'});}
  if(platform.provider?.route?.(req,res))return;
  if(req.method==='GET'&&url.pathname==='/ink.svg'){res.setHeader('Content-Type','image/svg+xml');res.setHeader('Cache-Control','public, max-age=3600');return res.end(await readFile(join(root,production?'dist':'public','ink.svg')));}
  if(url.pathname==='/api/health')return send(res,200,{ok:true,engine:'Ink',version:world.version,instanceId:process.env.INK_OS_INSTANCE_ID,draining});
  if(url.pathname==='/login'&&req.method==='GET'){res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','private, no-store');return res.end(loginPage(url.searchParams.get('next')));}
  if(url.pathname==='/login'&&req.method==='POST'){const input=await body(req);const principal=platform.principal({headers:{authorization:'Bearer '+input.token}});if(!principal?.owner)return send(res,401,{error:'Account key not accepted'});if(principal.keyId&&!principal.scopes.includes('computer'))return send(res,403,{error:'This key does not grant computer access'});res.setHeader('Set-Cookie',`ink_os_session=${sign({owner:true,...(principal.keyId?{keyId:principal.keyId}:{}),exp:Date.now()+7*86400000},platform.adminToken)}; Path=/; HttpOnly; ${origin.startsWith('https:')?'Secure; ':''}SameSite=Lax`);return send(res,200,{ok:true});}
  if(await edgeGatewayRoute(platform,req,res,url,{body,send}))return;
  const principal=platform.principal(req)||(!production?{owner:true,admin:true,accountId:'owner',namespace:'os'}:null);
  if(draining&&principal?.owner&&!['GET','HEAD'].includes(req.method))return send(res,503,{error:'This host is finishing its background jobs before stopping.'});
  if(req.method==='GET'&&/^\/api\/modules\/(documents|text-worker)\.mjs$/.test(url.pathname)){if(!principal?.owner&&!platform.assetAccess(url.searchParams.get('access')))return send(res,401,{error:'App read grant required'});return serveModule(req,res,url,join(root,production?'dist':'public'));}
  if(req.method==='GET'&&url.pathname==='/api/blob'&&platform.assetAccess(url.searchParams.get('access')))return await api(req,res,url);
  if(['GET','HEAD'].includes(req.method)&&/^\/api\/v1\/files\/[a-f0-9]{32}\/content$/.test(url.pathname)&&platform.assetAccess(url.searchParams.get('access')))return await fileContent(platform,req,res,url);
  if(url.pathname.startsWith('/api/v1/'))return await platformAPI(req,res,url,principal);
  if(production&&(!principal?.owner||(principal.keyId&&!principal.scopes.includes('computer')))){if(url.pathname.startsWith('/api/'))return send(res,401,{error:'Owner access required'});res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','private, no-store');return res.end(loginPage(url.pathname+url.search));}
  if(url.pathname.startsWith('/api/'))return await api(req,res,url);
  return serve(req,res);
 }catch(error){if(!res.headersSent)send(res,errorStatus(error),{error:error.message,current:error.current?world.publicObject(error.current):undefined});else res.end();}finally{requests.delete(task);finish();}
});
const connections=httpConnections(server);
const sockets=platform.collaboration.attach(server,req=>sealed?null:platform.principal(req)||(!production?{owner:true,admin:true,accountId:'owner',namespace:'os'}:null));
const shutdown=()=>{if(shutdownTask)return shutdownTask;draining=true;console.log('Ink OS is finishing background jobs before stopping.');shutdownTask=drainHost({server,connections,platform,world,requests,responses,sockets,vite,stopAdmission:()=>{sealed=true;}}).then(()=>{console.log('Ink OS stopped cleanly.');process.exitCode=0;}).catch(error=>{console.error('Ink OS shutdown:',error.message);process.exitCode=1;});return shutdownTask;};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
server.listen(port, process.env.INK_OS_BIND||'127.0.0.1',()=>{platform.schedules.start();platform.workflows.start();console.log(`Ink OS: ${origin}; engine=Ink; production=${production}`);});
