const tooLarge=()=>Object.assign(Error('Request too large'),{status:413});
/** Drain rejected bodies before replying so HTTP/2 proxies do not reset an in-flight upload. */
export function requestBytes(req,limit=32*1024*1024){return new Promise((resolve,reject)=>{
 let size=0,settled=false,chunks=[],rejected=Number(req.headers?.['content-length'])>limit;
 const fail=error=>{if(settled)return;settled=true;chunks=[];reject(error);};
 req.on('data',chunk=>{if(settled||rejected)return;size+=chunk.length;if(size>limit){rejected=true;chunks=[];return;}chunks.push(chunk);});
 req.once('end',()=>{if(settled)return;settled=true;if(rejected)reject(tooLarge());else resolve(Buffer.concat(chunks));});req.once('error',fail);req.once('aborted',()=>fail(Object.assign(Error('Upload interrupted. Please try again.'),{status:400})));
});}
export async function requestJSON(req,limit){const bytes=await requestBytes(req,limit);if(!bytes.length)return{};try{return JSON.parse(bytes.toString('utf8'));}catch{throw Object.assign(Error('Request contains invalid or incomplete JSON'),{status:400});}}
