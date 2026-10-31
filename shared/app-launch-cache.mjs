export class AppLaunchCache{
 constructor(load,{now=Date.now,ttl=45000}={}){this.load=load;this.now=now;this.ttl=ttl;this.entries=new Map();}
 get(appId,releaseId){const key=appId+'\0'+releaseId,current=this.entries.get(key);if(current&&current.expires>this.now())return current.promise;const entry={expires:this.now()+this.ttl};entry.promise=Promise.resolve().then(()=>this.load(appId,releaseId)).catch(error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error;});this.entries.set(key,entry);return entry.promise;}
 invalidate(appId){for(const key of this.entries.keys())if(key.startsWith(appId+'\0'))this.entries.delete(key);}
}
