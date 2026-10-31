import{requestBytes}from './request-body.mjs';
import{fileInfo}from'../shared/file-types.mjs';
import{desktopFile}from'../shared/desktop-placements.mjs';
export async function uploadFiles(platform,input,namespace='os',writeAccess){
 if(!Array.isArray(input.files)||!input.files.length||input.files.length>12)throw Object.assign(Error('Provide 1–12 files'),{status:400});
 const objects=[];
 for(const file of input.files){if(typeof file.base64!=='string'||file.base64.length>34*1024*1024)throw Object.assign(Error('Keep each file below 24 MiB'),{status:413});const bytes=Buffer.from(file.base64,'base64');if(bytes.length>24*1024*1024)throw Object.assign(Error('Keep each file below 24 MiB'),{status:413});objects.push(await storeFile(platform,file,bytes,namespace,writeAccess));}
 return{objects};
}
async function storeFile(platform,file,bytes,namespace,writeAccess){
 const name=String(file.name||'Untitled file').split(/[\\/]/).at(-1).slice(0,240),mime=/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mime||'')?file.mime.toLowerCase():'application/octet-stream',blob=await platform.storage.put(bytes,mime,{retain:true});
 platform.world.storage=platform.storage;try{return platform.world.publicObject(await platform.world.create({namespace,kind:'file',title:name,source:name,body:JSON.stringify({originalName:name,mime,bytes:bytes.length}),location:blob.location,tags:['imported']},{writer:namespace,actor:'Import',action:'imported',writeAccess}));}finally{blob.release?.();}
}
export async function fileContent(platform,req,res,url){
 const id=url.pathname.split('/')[4],object=platform.world.get(id);
 if(!object||!desktopFile(object))throw Object.assign(Error('File not found'),{status:404});
 if(url.searchParams.has('revision')&&String(object.revision)!==url.searchParams.get('revision'))throw Object.assign(Error('The source file changed; reopen it to adapt the current revision'),{status:409});
 const info=fileInfo(object),bytes=object.location?await platform.storage.get(object.location):Buffer.from(object.body||'');
 // Isolated apps fetch bytes using an existing asset read grant. Wildcard CORS
 // deliberately does not allow credentialed cross-origin cookie requests.
 const headers={'Content-Type':info.mime.includes('*')?'application/octet-stream':info.mime,'Cache-Control':'private, no-store','Accept-Ranges':'bytes','Content-Security-Policy':"sandbox; default-src 'none'",'X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin'};
 if(url.searchParams.has('download'))headers['Content-Disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(info.name.replace(/[\r\n]/g,''));
 let start=0,end=bytes.length-1,status=200;const range=req.headers.range;
 if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length});return res.end();}if(!match[1])start=Math.max(0,bytes.length-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length});return res.end();}status=206;headers['Content-Range']=`bytes ${start}-${end}/${bytes.length}`;}
 headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);res.end(req.method==='HEAD'?undefined:bytes.subarray(start,end+1));
}

export async function saveText(platform,id,input,principal){
 const object=platform.world.get(id);if(!object||!desktopFile(object))throw Object.assign(Error('File not found'),{status:404});
 if(!principal.owner&&principal.namespace!==object.namespace)throw Object.assign(Error('Only the owning app can write this file'),{status:403});
 if(typeof input.text!=='string'||Buffer.byteLength(input.text)>24*1024*1024)throw Object.assign(Error('Text exceeds 24 MiB'),{status:413});
 if(!Number.isInteger(input.expected)||input.expected<1)throw Object.assign(Error('Provide the file revision before saving'),{status:400});
 const info=fileInfo(object),bytes=Buffer.from(input.text),blob=await platform.storage.put(bytes,info.mime,{retain:true});
 platform.world.storage=platform.storage;try{return await platform.world.update(id,{location:blob.location,body:JSON.stringify({...(()=>{try{return JSON.parse(object.body);}catch{return{};}})(),mime:info.mime.includes('*')?'text/plain':info.mime,originalName:info.name,bytes:bytes.length})},{writer:object.namespace,expected:input.expected,actor:'Text editor',action:'saved file',writeAccess:principal.writeAccess});}finally{blob.release?.();}
}

export async function uploadBinary(platform,req,url,principal){
 const namespace=url.searchParams.get('namespace')||principal.namespace||'os';
 if(!principal.owner&&namespace!==principal.namespace)throw Object.assign(Error('Only the owning app can upload to this namespace'),{status:403});
 if(namespace!=='os')platform.app(namespace);
 const bytes=await requestBytes(req,24*1024*1024);
 return{objects:[await storeFile(platform,{name:url.searchParams.get('name'),mime:req.headers['content-type']},bytes,namespace,principal.writeAccess)]};
}
