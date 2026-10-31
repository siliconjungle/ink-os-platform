// A single invocation per process. Adapter modules are published separately.
import { pathToFileURL } from 'node:url';
import { createClient } from '../sdk/src/server.js';

process.once('message',async input=>{
  try {
    const module=await import(pathToFileURL(process.env.INK_OS_ADAPTER_ENTRY).href);
    if(typeof module.fetch!=='function')throw Error('Adapter must export fetch');
    const init={method:input.method||'GET',headers:{'Content-Type':'application/json'}};
    if(!['GET','HEAD'].includes(init.method)&&input.body!==undefined)init.body=JSON.stringify(input.body);
    const result=await module.fetch(new Request('https://adapter.invalid'+input.path,init),{ink:createClient(),namespace:process.env.INK_OS_APP_ID});
    const response=result instanceof Response?result:Response.json(result);
    const text=await response.text();
    if(Buffer.byteLength(text)>34*1024*1024)throw Error('Adapter response exceeds transport limit');
    const body=JSON.parse(text);
    process.send({status:response.status,headers:{'content-type':'application/json'},body},()=>process.disconnect());
  }catch(error){process.send({status:502,body:{error:'Local adapter invocation failed',code:/^ERR_[A-Z_]+$/.test(error.code||'')?error.code:'ADAPTER_ERROR'}},()=>process.disconnect());}
});
