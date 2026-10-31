// Local paint is synchronous. Only the durable outbox and explicit flush wait.
export class ObjectOutbox {
 constructor({send,cache,onChange=()=>{},onStatus=()=>{},retryMs=1000}){Object.assign(this,{send,cache,onChange,onStatus,retryMs});this.base=new Map();this.entries=new Map();this.running=new Map();this.timers=new Map();this.persisting=new Map();this.version=0;this.actor=crypto.randomUUID();this.sequence=0;this.closed=false;this.ready=this.restore();}
 async restore(){if(!this.cache)return;for(const entry of (await this.cache.all()).sort((a,b)=>a.created-b.created)){this.entries.set(entry.key,entry);if(entry.base&&!this.base.has(entry.id))this.base.set(entry.id,entry.base);this.paint(entry.id);if(entry.failed)this.onStatus({error:entry.failed.message,id:entry.id,key:entry.key});}for(const id of new Set([...this.entries.values()].map(e=>e.id)))this.pump(id);}
 ids(namespace){return[...new Set([...this.base.keys(),...[...this.entries.values()].map(entry=>entry.id)])].filter(id=>!namespace||this.view(id)?.namespace===namespace);}
 rows(id){return[...this.entries.values()].filter(e=>e.id===id);}
 view(id){let value=this.base.get(id);for(const entry of this.rows(id)){if(entry.failed)continue;value=entry.type==='create'?{...entry.input}:{...value,...entry.changes};}return value;}
 paint(id){const value=this.view(id);this.onChange(id,value?{...value,localVersion:++this.version,syncPending:!!value.syncPending||this.rows(id).some(entry=>!entry.failed)}:undefined);this.onStatus({pending:[...this.entries.values()].filter(e=>!e.failed).length,failed:[...this.entries.values()].filter(e=>e.failed).length});}
 receive(object){const previous=this.base.get(object.id);if(previous&&previous.revision>object.revision)return;if(previous&&JSON.stringify(previous)===JSON.stringify(object))return;this.base.set(object.id,object);this.paint(object.id);}
 remove(id){const current=this.base.get(id);if(current)this.base.set(id,{...current,archived:true});this.paint(id);}
 async enqueue(type,id,changes,route,mutationId){await this.ready;const base=this.view(id);if(type==='update'&&!base)throw Error('Object not found');const entry={key:crypto.randomUUID(),mutationId:mutationId||this.actor+':'+(++this.sequence),created:Math.max(Date.now(),(this.lastCreated||0)+1),id,type,route,base,changes:structuredClone(changes),input:type==='create'?structuredClone(changes):undefined};this.lastCreated=entry.created;this.entries.set(entry.key,entry);this.paint(id);const local=this.view(id);try{const saving=this.cache?.put(entry)||Promise.resolve();this.persisting.set(entry.key,saving);await saving;this.persisting.delete(entry.key);}catch(error){this.persisting.delete(entry.key);this.entries.delete(entry.key);this.paint(id);throw Error('Could not save this edit on this device: '+error.message);}this.pump(id);return {...local,syncPending:true};}
 create(input,route){return this.enqueue('create',input.id,input,route);}
 update(id,changes,route,mutationId){return this.enqueue('update',id,changes,route,mutationId);}
 pump(id){if(this.closed||this.running.has(id)||this.timers.has(id))return;const work=this.drain(id);this.running.set(id,work);void work.finally(()=>{this.running.delete(id);if(this.rows(id).length&&!this.rows(id)[0].failed&&!this.closed)this.pump(id);});}
 async drain(id){for(;;){const entry=this.rows(id)[0];if(!entry||entry.failed||this.closed)return;try{await this.persisting.get(entry.key);const current=this.base.get(id)||entry.base;if(entry.type==='update'&&'body'in entry.changes&&current?.body!==entry.base?.body&&current?.body!==entry.changes.body)throw Object.assign(Error('Text changed in another view; your replacement is retained for retry'),{status:409,current});const result=await this.send(entry,current?.revision);if(!this.base.has(id)||this.base.get(id).revision<=result.revision)this.base.set(id,result);await this.cache?.delete(entry.key);this.entries.delete(entry.key);this.paint(id);}catch(error){if(error.status===409&&error.current&&entry.type==='update'){
     const current=error.current;this.receive(current);
     // Whole-body replacement is ordered; never overwrite a concurrent text edit.
     if(!('body'in entry.changes)||current.body===entry.base?.body||current.body===entry.changes.body){entry.base=current;entry.conflicts=(entry.conflicts||0)+1;if(entry.conflicts<8)continue;error.status=503;}
    }
    if(!error.status||error.status===408||error.status===429||error.status>=500){this.onStatus({offline:true,pending:[...this.entries.values()].filter(e=>!e.failed).length});this.timers.set(id,setTimeout(()=>{this.timers.delete(id);this.pump(id);},this.retryMs));return;}
    entry.failed={message:error.message,status:error.status};try{await this.cache?.put(entry);}catch{}this.paint(id);this.onStatus({error:error.message,id,key:entry.key});return;
   }} }
 async flush(id){await this.ready;for(;;){const rows=id?this.rows(id):[...this.entries.values()];if(!rows.length)return;const failed=rows.find(e=>e.failed);if(failed)throw Object.assign(Error(failed.failed.message),{status:failed.failed.status});if(rows.some(e=>this.timers.has(e.id)))throw Error('Offline: edits are saved on this device and will synchronize when connected');for(const key of new Set(rows.map(e=>e.id)))this.pump(key);await Promise.all([...new Set(rows.map(e=>e.id))].map(key=>this.running.get(key)));}}
 async retry(key){await this.ready;const entry=this.entries.get(key);if(!entry)return;delete entry.failed;entry.conflicts=0;entry.base=this.base.get(entry.id)||entry.base;await this.cache?.put(entry);this.paint(entry.id);this.wake();}
 wake(){for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const id of new Set([...this.entries.values()].map(e=>e.id)))this.pump(id);}
 close(){this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();}
}

export class ObjectCache {
 constructor({indexedDB=globalThis.indexedDB,name='ink-os-object-outbox-v1'}={}){this.indexedDB=indexedDB;this.name=name;}
 open(){return this.opening??=new Promise((resolve,reject)=>{if(!this.indexedDB)return reject(Error('Durable browser storage is unavailable'));const request=this.indexedDB.open(this.name,1);request.onupgradeneeded=()=>request.result.createObjectStore('edits',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
 async run(mode,fn){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('edits',mode,{durability:'strict'}),request=fn(tx.objectStore('edits'));tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Local save aborted'));});}
 all(){return this.run('readonly',store=>store.getAll());}
 put(entry){return this.run('readwrite',store=>store.put(entry));}
 delete(key){return this.run('readwrite',store=>store.delete(key));}
}
