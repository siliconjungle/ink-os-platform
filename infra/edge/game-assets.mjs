// The manifest is part of the authenticated, content-addressed release bundle.
const cache=new WeakMap();
export function assetManifest(bundle) {
 if(cache.has(bundle))return cache.get(bundle);
 const file=bundle.files.find(file=>file.path==='ink-assets.json');
 if(!file){cache.set(bundle,null);return null;}
 const manifest=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))));
 if(manifest.version!==1||!Array.isArray(manifest.files))throw Error('Invalid asset manifest');
 const seen=new Set();
 for(const file of manifest.files){
  if(typeof file.path!=='string'||!file.path||file.path.startsWith('/')||file.path.includes('\\')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0||typeof file.mime!=='string'||/[\r\n]/.test(file.mime))throw Error('Invalid asset descriptor');
  if(file.pack&&(!/^[a-f0-9]{64}$/.test(file.pack.sha256)||!Number.isSafeInteger(file.pack.bytes)||!Number.isSafeInteger(file.pack.offset)||file.pack.offset<0||file.pack.offset+file.bytes>file.pack.bytes))throw Error('Invalid asset pack');
  if(file.chunks){let bytes=0;if(!Array.isArray(file.chunks))throw Error('Invalid artifact chunks');for(const part of file.chunks){if(!/^[a-f0-9]{64}$/.test(part.sha256)||![part.bytes,part.offset,part.length].every(Number.isSafeInteger)||part.offset<0||part.length<1||part.offset+part.length>part.bytes)throw Error('Invalid artifact chunk');bytes+=part.length;}if(bytes!==file.bytes)throw Error('Incomplete artifact');}
  seen.add(file.path);
 }
 const result=new Map(manifest.files.map(file=>[file.path,file]));cache.set(bundle,result);return result;
}
export async function serveGameAsset(request,bucket,file,headers) {
 let start=0,end=file.bytes-1;const range=request.headers.get('Range');
 const rejected=()=>new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+file.bytes}});
 if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2])return rejected();if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}else start=Math.max(0,file.bytes-Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.bytes)return rejected();}
 const result=new Headers(headers);result.set('Content-Type',file.mime);result.set('Accept-Ranges','bytes');result.set('ETag','"'+file.sha256+'"');result.set('Content-Length',String(Math.max(0,end-start+1)));
 if(range)result.set('Content-Range',`bytes ${start}-${end}/${file.bytes}`);
 const parts=file.chunks||(file.pack?[{...file.pack,length:file.bytes}]:[{sha256:file.sha256,bytes:file.bytes,offset:0,length:file.bytes}]);
 const reads=[];let at=0;
 for(const part of parts){const low=Math.max(start,at),high=Math.min(end,at+part.length-1);if(low<=high)reads.push({part,offset:part.offset+low-at,length:high-low+1});at+=part.length;}
 const read=async info=>{const object=await bucket.get('objects/'+info.part.sha256,{range:{offset:info.offset,length:info.length}});if(!object)throw Error('Release asset unavailable');if(object.size!==info.part.bytes)throw Error('Release asset size mismatch');return object;};
 let first;try{if(reads.length)first=await read(reads[0]);}catch(e){return new Response(e.message,{status:e.message.includes('size')?502:503,headers});}
 if(request.method==='HEAD'||!reads.length)return new Response(null,{status:range?206:200,headers:result});
 if(reads.length===1)return new Response(first.body,{status:range?206:200,headers:result});
 let index=0,reader=first.body.getReader();
 const body=new ReadableStream({async pull(controller){try{for(;;){const chunk=await reader.read();if(!chunk.done){controller.enqueue(chunk.value);return;}reader.releaseLock();if(++index===reads.length){controller.close();return;}reader=(await read(reads[index])).body.getReader();}}catch(error){controller.error(error);}},async cancel(reason){await reader.cancel(reason);}});
 return new Response(body,{status:range?206:200,headers:result});
}
