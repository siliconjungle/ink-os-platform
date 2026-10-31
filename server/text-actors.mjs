import{readFile,writeFile,rename,open}from'node:fs/promises';
import{join}from'node:path';

const maxActor=0xffffffff;
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export async function textActors(doc){
 if(doc.actorRegistry)return doc.actorRegistry;
 try{const saved=JSON.parse(await readFile(join(doc.dir,'actors.json'),'utf8'));
  if(saved.version!==1||!Array.isArray(saved.leases)||saved.leases.some(lease=>!validID(lease.leaseId)||!Number.isInteger(lease.start)||!Number.isInteger(lease.count)||lease.start<2||lease.count<1||lease.start+lease.count-1>maxActor))throw Error('Invalid text actor reservation file');
  return doc.actorRegistry=saved;
 }catch(error){if(error.code!=='ENOENT')throw error;return doc.actorRegistry={version:1,leases:[]};}
}
const validID=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
// Called under the document's serialized tail. Actor 1 belongs to ordered server writes.
export async function reserveTextActors(doc,leaseId,count=64){
 if(!validID(leaseId)||!Number.isInteger(count)||count<1||count>64)fail(400,'Invalid text actor reservation');
 const registry=await textActors(doc),existing=registry.leases.find(lease=>lease.leaseId===leaseId);
 if(existing){if(existing.count!==count)fail(409,'Text actor reservation size cannot change');return existing;}
 const occupied=[[1,1],...registry.leases.map(lease=>[lease.start,lease.start+lease.count-1])];
 for(const actor of doc.textActors)occupied.push([actor,actor]);
 occupied.sort((a,b)=>a[0]-b[0]);let start=2;
 for(const[lo,hi]of occupied){if(hi<start)continue;if(lo-start>=count)break;start=hi+1;}
 if(start+count-1>maxActor)fail(409,'Text actor identity space is exhausted');
 const lease={leaseId,start,count},next={version:1,leases:[...registry.leases,lease]},path=join(doc.dir,'actors.json');
 await writeFile(path+'.next',JSON.stringify(next),{mode:0o600,flush:true});await rename(path+'.next',path);doc.actorRegistry=next;
 const directory=await open(doc.dir,'r');try{await directory.sync();}finally{await directory.close();}
 return lease;
}
export async function validateTextActors(doc,updates,leaseId){
 const registry=await textActors(doc),lease=leaseId===undefined?null:registry.leases.find(lease=>lease.leaseId===leaseId);
 if(leaseId!==undefined&&!lease)fail(403,'Unknown text actor reservation');
 for(const op of updates){const actor=Number(BigInt(op.id)>>32n);
  if(lease){if(actor<lease.start||actor>=lease.start+lease.count)fail(403,'Text actor belongs to another reservation');}
  else if(actor===1||registry.leases.some(item=>actor>=item.start&&actor<item.start+item.count))fail(409,'Legacy text actor conflicts with a reservation; the pending draft must be reopened with a fresh identity');
 }
}
