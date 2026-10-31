import{createState}from'../generated/shared-state.mjs';
const randomActor=()=>{const values=new Uint32Array(2);crypto.getRandomValues(values);return(BigInt(values[0])<<32n|BigInt(values[1]))||1n;};
const max64=(1n<<64n)-1n;
export function register(input){if(!input||typeof input.path!=='string'||!input.path.startsWith('/')||input.path.length>4096)throw Error('Invalid state path');const value=input.deleted?'null':typeof input.value==='string'?input.value:JSON.stringify(input.value);if(typeof value!=='string'||value.length>1024*1024)throw Error('State values must be bounded JSON');JSON.parse(value);const result={path:input.path,value,deleted:!!input.deleted,actor:BigInt(input.actor),clock:BigInt(input.clock),seq:BigInt(input.seq)};if(result.actor<=0n||result.actor>max64||result.clock<0n||result.clock>max64||result.seq<=0n||result.seq>max64)throw Error('Invalid CRDT identity or clock');return result;}
export const wireRegister=op=>({...op,actor:String(op.actor),clock:String(op.clock),seq:String(op.seq)});
export class SharedState{
 constructor({actor=randomActor(),onLocal=()=>{}}={}){this.actor=BigInt(actor);this.seq=0n;this.clock=0n;this.ink=createState();this.values=new Map();this.listeners=new Set();this.onLocal=onLocal;}
 get(path,fallback){const entry=this.values.get(path);return!entry||entry.deleted?fallback:JSON.parse(entry.value);}
 entries(prefix='/'){return[...this.values].filter(([path,value])=>path.startsWith(prefix)&&!value.deleted).map(([path,value])=>[path,JSON.parse(value.value)]);}
 apply(incoming,{local=false}={}){if(!Array.isArray(incoming)||incoming.length>1024)throw Error('State batches are limited to 1024 writes');const operations=incoming.map(register),changed=[];for(const next of operations){const before=this.values.get(next.path);const result=this.ink.invoke('merge',[next]);if(!result.committed)throw Error('Ink rejected state operation');const current=this.ink.invoke('get',[next.path]).result.Some;if(!before||before.clock!==current.clock||before.actor!==current.actor||before.seq!==current.seq){this.values.set(next.path,current);changed.push(next.path);}this.clock=this.clock>next.clock?this.clock:next.clock;if(next.actor===this.actor&&next.seq>this.seq)this.seq=next.seq;}if(changed.length)for(const listener of this.listeners)listener({paths:[...new Set(changed)],local});return operations.map(wireRegister);}
 set(path,value){return this.commit([{path,value}]);}
 delete(path){return this.commit([{path,deleted:true}]);}
 commit(writes){const clock=++this.clock,operations=writes.map(write=>({path:write.path,value:JSON.stringify(write.value??null),deleted:!!write.deleted,actor:this.actor,seq:++this.seq,clock}));const wire=this.apply(operations,{local:true});this.onLocal(wire);return wire;}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 async checkpoint(){return this.ink.checkpoint();}
 async restore(bytes){await this.ink.restore(bytes);this.values=new Map(this.ink.invoke('registers',[]).result.map(value=>[value.path,value]));const seen=this.ink.invoke('version',[this.actor]).result;if(seen>this.seq)this.seq=seen;for(const value of this.values.values()){this.clock=this.clock>value.clock?this.clock:value.clock;if(value.actor===this.actor&&value.seq>this.seq)this.seq=value.seq;}}
}
