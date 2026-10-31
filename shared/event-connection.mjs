/** One event stream and heartbeat per page, including browser back/forward cache. */
export class EventConnection{
 constructor({url,heartbeat,onOpen=()=>{},onError=()=>{},onMessage=()=>{},source=url=>new EventSource(url),events=globalThis,interval=25000,schedule=(fn,ms)=>setInterval(fn,ms),cancel=id=>clearInterval(id)}){Object.assign(this,{url,heartbeat,onOpen,onError,onMessage,makeSource:source,events,interval,schedule,cancel});this.resume=()=>{if(!this.source&&!this.destroyed)this.connect();};this.hide=()=>this.pause();events.addEventListener('pagehide',this.hide);events.addEventListener('pageshow',this.resume);}
 connect(){if(this.destroyed)return;this.pause();const source=this.makeSource(this.url);this.source=source;
  source.onopen=()=>{if(this.source!==source)return;this.stopHeartbeat();this.lease=new AbortController();this.onOpen();void this.pulse(source);this.timer=this.schedule(()=>void this.pulse(source),this.interval);};
  source.onerror=()=>{if(this.source!==source)return;this.stopHeartbeat();this.onError();};source.onmessage=event=>{if(this.source===source)this.onMessage(event);};return source;
 }
 async pulse(source){if(this.source!==source||source.readyState!==1||!this.lease||this.pending)return;const lease=this.lease,token={};this.pending=token;try{const result=await this.heartbeat(lease.signal);if(this.source===source&&this.lease===lease&&result?.connected===false)this.connect();}catch{}finally{if(this.pending===token)this.pending=undefined;}}
 stopHeartbeat(){if(this.timer!==undefined)this.cancel(this.timer);this.timer=undefined;this.lease?.abort();this.lease=undefined;this.pending=undefined;}
 pause(){this.stopHeartbeat();const source=this.source;this.source=undefined;if(source){source.onopen=source.onerror=source.onmessage=null;source.close();}}
 destroy(){this.destroyed=true;this.pause();this.events.removeEventListener('pagehide',this.hide);this.events.removeEventListener('pageshow',this.resume);}
}
