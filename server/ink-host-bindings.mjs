import{createHash}from'node:crypto';
import{parseExactJSON}from'../shared/exact-json.mjs';
import{inkHostBindings}from'../shared/ink-app.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const KIND='ink-host-record',MAX=64*1024;
export const hostRecordId=(namespace,key)=>createHash('sha256').update(namespace+'\0'+KIND+'\0'+key).digest('hex').slice(0,32);
function checkedRow(row,namespace,key){if(row&&(row.namespace!==namespace||row.kind!==KIND||row.title!==key||row.archived||row.location))fail(409,'Host data identity is unavailable; no record was adopted.');if(row&&Buffer.byteLength(row.body)>MAX)fail(413,'Host data exceeds 64 KiB.');return row;}
/** One record CAS, separate from Ink checkpoints. Pure transforms never commit
 * Ink state. A lost acknowledgement is resolved by reading the current row;
 * writes are deliberately non-idempotent and are never automatically replayed.
 */
export async function runInkHostBinding(platform,appId,app,input,principal){
 const binding=app.spec.host?.bindings.find(binding=>binding.entry===input.entry);if(!binding)return null;
 const compiled=await platform.code.compile(app.source);inkHostBindings(app.spec,compiled.entries);
 const manifest=JSON.parse(platform.app(appId).body),required=binding.effect==='write'?['world.read','world.write']:['world.read'];
 if(required.some(capability=>!manifest.capabilities?.includes(capability)))fail(403,'This app does not declare the host binding data capabilities.');
 const authority=platform.runtime.bind({owner:false,appId,namespace:appId,releaseId:app.releaseId});authority.writeAccess.check();
 if(input.input!==undefined&&(typeof input.input!=='string'||Buffer.byteLength(input.input)>MAX))fail(413,'Host input exceeds 64 KiB.');
 const args=parseExactJSON(input.input??'[]');if(!Array.isArray(args)||args.length!==(binding.effect==='write'?2:0))fail(400,'Read bindings take []; write bindings take [expectedRevision,text].');
 let expected;if(binding.effect==='write'){const value=args[0];if(!['number','bigint'].includes(typeof value)||value<0||value>Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(Number(value))||typeof args[1]!=='string'||Buffer.byteLength(args[1])>MAX)fail(400,'Supply a safe record revision and text of at most 64 KiB.');expected=Number(value);}
 const id=hostRecordId(appId,binding.key),row=checkedRow(platform.world.get(id),appId,binding.key);
 if(expected!==undefined&&expected!==(row?.revision||0))fail(409,'Host data changed; read its current revision before writing.');
 const result=await platform.code.run({source:app.source,entry:binding.entry,input:JSON.stringify([row?.body||'',...(binding.effect==='write'?[args[1]]:[])]),backend:input.backend,namespace:appId,principal:authority});
 if(result.committed)fail(500,'Host transforms cannot commit Ink state.');
 let saved=row;
 if(binding.effect==='write'){
  const body=parseExactJSON(result.wire);if(typeof body!=='string'||Buffer.byteLength(body)>MAX)fail(413,'Host transform output must be text of at most 64 KiB.');
  const commit=()=>{if(platform.world.collaboration?.objectBindings?.has(id))fail(409,'Host data cannot overwrite a collaboration-bound document.');return platform.world.put(()=>{checkedRow(platform.world.get(id),appId,binding.key);return{id,namespace:appId,kind:KIND,title:binding.key,body,status:'saved'};},{expected,writer:appId,writeAccess:authority.writeAccess,bindingChecked:true,actor:'Ink host binding',action:'saved app data'});};
  const collaboration=platform.world.collaboration;if(collaboration){await collaboration.index();saved=await collaboration.objectTask(id,commit);}else saved=await commit();
 }
 return{...result,value:result.output,valueWire:result.wire,releaseId:app.releaseId,hostRecord:{key:binding.key,revision:saved?.revision||0,exists:!!saved,effect:binding.effect},transaction:'single-record-cas; no Ink checkpoint mutation'};
}
