import{createReadStream}from'node:fs';
import{readdir,readFile}from'node:fs/promises';
import{join,extname}from'node:path';
import{createHash}from'node:crypto';
import{request as httpRequest}from'node:http';
import{request as httpsRequest}from'node:https';
import{continuationContext,continuationFromEnvironment,continuationHeaders,redactConnectionSecrets}from '../../shared/continuation.mjs';
export const CHUNK_BYTES=16*1024*1024;
// Keep long binary transfers on HTTP/1.1: an HTTP/2 session reset must not poison
// later retries in Node's shared fetch connection pool.
function artifactRequest(url,{method,headers,body,signal}){return new Promise((resolve,reject)=>{const target=new URL(url),request=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method,headers:{...headers,'Content-Length':String(body.length)},signal},response=>{const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)response.destroy(Error('Artifact receipt exceeds 1 MiB'));else chunks.push(chunk);});response.on('error',reject);response.on('aborted',()=>reject(Error('Artifact upload response interrupted')));response.on('end',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>JSON.parse(Buffer.concat(chunks).toString())}));});request.on('error',reject);request.end(body);});}
export async function uploadArtifact(url,bytes,{token,continuation=continuationFromEnvironment(process.env),fetcher=artifactRequest,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onRetry=()=>{}}={}){
 const context=continuationContext(continuation);
 for(let attempt=0;;attempt++){
  try{const response=await fetcher(url,{method:'PUT',redirect:'error',headers:{Authorization:'Bearer '+token,...continuationHeaders(url,context),'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(180000)}),result=await response.json().catch(()=>null);if(!response.ok)throw Object.assign(Error(result?.error||'Artifact upload failed ('+response.status+')'),{status:response.status});if(!result?.id)throw Error('Invalid artifact upload receipt');return result;}
  catch(error){error.message=redactConnectionSecrets(error.message,[token,context?.token]);if(attempt===7||error.status&&error.status<500&&![408,429].includes(error.status))throw error;onRetry({attempt:attempt+1,error});await sleep(1000*2**attempt);}
 }
}
const types={html:'text/html; charset=utf-8',js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm',wasm:'application/wasm'};
export async function artifactManifest(directory,{upload,chunkBytes=CHUNK_BYTES,onProgress=()=>{},extraFiles=new Map(),transform,transformPath}= {}){
 const files=[],uploaded=new Map();let pieces=[],segments=[],size=0,total=0;
 async function flush(){if(!size)return;const bytes=Buffer.concat(pieces,size),sha256=createHash('sha256').update(bytes).digest('hex'),record=uploaded.get(sha256)||await upload(sha256,bytes);uploaded.set(sha256,record);for(const segment of segments)Object.assign(segment,{sha256,bytes:size,...(record?.id?{objectId:record.id}:{})});total+=size;onProgress({bytes:total,files:files.length});pieces=[];segments=[];size=0;}
 async function emit(path,stream){
   const hash=createHash('sha256'),file={path,mime:types[extname(path).slice(1)]||'application/octet-stream',bytes:0,sha256:'',chunks:[]};files.push(file);
   for await(const data of stream){
    hash.update(data);file.bytes+=data.length;let offset=0;
    while(offset<data.length){if(size===chunkBytes)await flush();const length=Math.min(data.length-offset,chunkBytes-size),previous=file.chunks.at(-1);if(previous&&segments.at(-1)===previous)previous.length+=length;else{const segment={offset:size,length};file.chunks.push(segment);segments.push(segment);}pieces.push(data.subarray(offset,offset+length));size+=length;offset+=length;}
   }
   file.sha256=hash.digest('hex');
 }
 async function visit(dir,prefix=''){
  for(const entry of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(['node_modules','.git'].includes(entry.name)||/^\.(env|dev.vars|npmrc)(\.|$)/.test(entry.name))continue;
   if(entry.isSymbolicLink())throw Error('Release files cannot contain symlinks');
   const path=prefix+entry.name,local=join(dir,entry.name);if(entry.isDirectory()){await visit(local,path+'/');continue;}
   if(extraFiles.has(path))continue;await emit(path,transform&&(!transformPath||transformPath===path)?[await transform(path,await readFile(local))]:createReadStream(local,{highWaterMark:Math.min(chunkBytes,1024*1024)}));
  }
 }
 await visit(directory);for(const[path,bytes]of extraFiles)await emit(path,[bytes]);await flush();return{version:1,files};
}
