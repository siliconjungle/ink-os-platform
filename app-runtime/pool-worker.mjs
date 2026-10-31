import http from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,timingSafeEqual} from 'node:crypto';
import {AsyncLocalStorage,createHook} from 'node:async_hooks';
import {createClient} from './sdk-server.mjs';
const {INK_OS_URL:origin,INK_OS_APP_TOKEN:key,INK_OS_APP_ID:appId,INK_OS_RELEASE_ID:releaseId,INK_OS_LEASE_ID:leaseId,INK_OS_BACKEND_URL:backendURL}=process.env;
const scope=new AsyncLocalStorage(),resources=new Map();
// Track live event-loop work, not GC-owned wrappers such as completed crypto,
// TLS and decompression jobs. Keeping those wrappers alive prevents idle reuse.
// Detached jobs use SDK compute holds; startup hooks remain pinned by default.
const tracked=new Set(['Timeout','Immediate','TCPWRAP','PIPEWRAP','UDPWRAP','PROCESSWRAP','WORKER','MESSAGEPORT','FSEVENTWRAP','STATWATCHER','FSREQPROMISE','FSREQCALLBACK','GETADDRINFOREQWRAP','GETNAMEINFOREQWRAP','WRITEWRAP','SHUTDOWNWRAP','TCPCONNECTWRAP','PIPECONNECTWRAP','UDPSENDWRAP']);
const oneShot=new Set(['FSREQPROMISE','FSREQCALLBACK','GETADDRINFOREQWRAP','GETNAMEINFOREQWRAP','WRITEWRAP','SHUTDOWNWRAP','TCPCONNECTWRAP','PIPECONNECTWRAP','UDPSENDWRAP']);
createHook({init(id,type,trigger,resource){if(scope.getStore()&&tracked.has(type))resources.set(id,{type,reference:new WeakRef(resource)});},after(id){if(oneShot.has(resources.get(id)?.type))resources.delete(id);},destroy(id){resources.delete(id);}}).enable();
const root=resolve(process.env.INK_OS_RUNTIME_DIRECTORY||'/tmp/ink-app');await mkdir(root,{recursive:true});
const source=await fetch(origin+'/api/v1/runtime/bundle/'+releaseId,{headers:{Authorization:'Bearer '+key}});if(!source.ok)throw Error('Release download denied: '+source.status);const bundle=await source.json();
for(const file of bundle.files){const path=resolve(root,file.path);if(!path.startsWith(root+'/'))throw Error('Invalid artifact path');await mkdir(dirname(path),{recursive:true});await writeFile(path,Buffer.from(file.base64,'base64'));}
const ink=createClient();process.env.INK_OS_SDK_URL=pathToFileURL(resolve('app-runtime/sdk-server.mjs')).href;
let activeRequests=0,draining=false,backend;
await scope.run(true,async()=>{backend=bundle.backend?.entry?await import(pathToFileURL(resolve(root,bundle.backend.entry)).href):null;await backend?.start?.({ink,namespace:appId});});
const startPinned=!!(backend?.start||backendURL)&&!bundle.backend?.idleSafe;
const same=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());
// Node 24 can retain a destroyed Timeout until the next timer sweep. It is
// already finished; hasRef() alone still returns true for that dead handle.
const liveResources=()=>[...resources.values()].filter(({reference})=>{const resource=reference.deref();return resource&&resource.hasRef?.()!==false&&resource._destroyed!==true;});
const status=()=>({appId,releaseId,leaseId,activeRequests,resources:liveResources().length,resourceTypes:[...new Set(liveResources().map(r=>r.type))],startPinned,draining});
async function body(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw Object.assign(Error('Request too large'),{status:413});chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
async function invoke(input){const path=input.path||'/',method=String(input.method||'GET').toUpperCase();if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw Error('Invalid backend path');const init={method,headers:{'Content-Type':'application/json'},...(!['GET','HEAD'].includes(method)&&input.body!==undefined?{body:JSON.stringify(input.body)}:{})};let result;if(backendURL)result=await fetch(backendURL+path,{...init,signal:AbortSignal.timeout(55000)});else if(backend?.fetch)result=await backend.fetch(new Request('https://app.invalid'+path,init),{ink,namespace:appId});else throw Error('No backend handler');if(!(result instanceof Response))result=Response.json(result);const text=await result.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:result.status,headers:{'content-type':result.headers.get('content-type')||'application/json'},body:data};}
http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');try{const path=new URL(req.url,'http://runtime').pathname;if(path==='/_ink/health'){res.end(JSON.stringify({ok:true}));return;}if(!same(req.headers.authorization,'Bearer '+key)){res.writeHead(403);res.end(JSON.stringify({error:'Denied'}));return;}if(path==='/_ink/status'&&req.method==='GET'){res.end(JSON.stringify(status()));return;}if(path==='/_ink/drain'&&req.method==='POST'){const input=await body(req);const idle=!activeRequests&&!liveResources().length&&(!startPinned||input.allowIdle===true);if(idle)draining=true;res.end(JSON.stringify({idle,...status()}));return;}if(path==='/_ink/invoke'&&req.method==='POST'){if(draining){res.writeHead(409);res.end(JSON.stringify({error:'Compute lease is draining'}));return;}activeRequests++;try{const input=await body(req),result=await scope.run(true,()=>invoke(input));res.end(JSON.stringify(result));}finally{activeRequests--;}return;}res.writeHead(404);res.end(JSON.stringify({error:'Unknown runtime operation'}));}catch(error){res.writeHead(error.status||500);res.end(JSON.stringify({error:error.message}));}}).listen(Number(process.env.PORT||8080),'0.0.0.0');
