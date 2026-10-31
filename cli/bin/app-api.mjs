import {createAppCalls} from '../../sdk/src/app-api.js';

export const APP_INTERACTIONS = ['api','read','send','open','action'];
const appID=value=>{if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw Error('Provide a valid app ID');return value;};
const uuid=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw Error('Provide a valid desktop action ID');return value;};
function inputJSON(value,label){
 if(typeof value!=='string'||Buffer.byteLength(value)>65536)throw Error(label+' must be at most 64 KiB of JSON');
 try{return JSON.parse(value);}catch{throw Error(label+' must be valid JSON');}
}
function backendPath(value){
 if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\#\x00-\x20\x7f]/.test(value))throw Error('Use a backend-relative app API path');
 return value;
}
// The server checks exported routes and permissions and mints caller assertions.
export async function appInteractionCLI({command,sub,id,name,options,request,environment=process.env,redact=value=>String(value)}){
 try{
  if(command==='apps'&&sub==='action')return await request('desktop/actions/'+uuid(id));
  const calls=createAppCalls({
   describe:id=>request('apps/'+id+'/api'),
   call:(id,path,init)=>request('apps/'+id+'/call','POST',{path,method:init.method,body:init.body}),
   open:(appId,data)=>{
    const clientId=environment.INK_OS_UI_CLIENT_ID,sourceAppId=environment.INK_OS_APP_ID;
    if(clientId!==undefined)uuid(clientId);if(sourceAppId!==undefined)appID(sourceAppId);
    return request('desktop/open','POST',{appId,data,...(clientId!==undefined?{clientId}:{}),...(sourceAppId!==undefined?{sourceAppId}:{})});
   },
  });
  if(command==='call'){
   appID(sub);const path=backendPath(id||'/'),method=String(options.method||'GET').toUpperCase();
   if(!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(method))throw Error('Select a supported app API method');
   return await calls.invoke(sub,path,{method,...(options.body!==undefined?{body:inputJSON(options.body,'App API body')}:{})});
  }
  appID(id);
  if(sub==='api')return await calls.api(id);
  if(sub==='open')return await calls.open(id,options.data===undefined?undefined:inputJSON(options.data,'App handoff data'));
  if(!['read','send'].includes(sub))throw Error('Unknown app interaction');
  if(typeof name!=='string'||!/^[a-z][a-z0-9.-]{0,63}$/.test(name))throw Error('Provide the exported message/read name');
  return await calls[sub](id,name,inputJSON(options.body??'{}','App API input'));
 }catch(error){error.message=redact(error.message);throw error;}
}
