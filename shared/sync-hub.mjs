export class SyncHub{
 constructor(url,{WebSocket:Socket=globalThis.WebSocket,retryMs=500,heartbeatMs=15000,pingTimeoutMs=5000,requestTimeoutMs=30000,connectTimeoutMs=10000,lifecycleTarget,visibilityTarget}={}){
  Object.assign(this,{url,Socket,retryMs,heartbeatMs,pingTimeoutMs,requestTimeoutMs,connectTimeoutMs,lifecycleTarget,visibilityTarget});this.channels=new Map();this.pending=new Map();this.epoch=0;this.closed=false;this.lastMessage=0;this.lastWake=0;
  this.onWake=()=>{if(visibilityTarget?.visibilityState==='hidden')return;void this.wake().catch(()=>{});};
  for(const event of ['online','pageshow','focus'])lifecycleTarget?.addEventListener(event,this.onWake);visibilityTarget?.addEventListener('visibilitychange',this.onWake);
 }
 connect(){
  if(this.closed)return Promise.reject(Error('Collaborative transport closed'));
  if(this.socket?.readyState===this.Socket.OPEN)return Promise.resolve();if(this.opening)return this.opening;if(this.socket)this.disconnect(this.socket,Error('Collaborative transport reconnecting'),{immediate:true});clearTimeout(this.retry);
  this.opening=new Promise((resolve,reject)=>{
   const socket=this.socket=new this.Socket(this.url);this.rejectOpening=reject;
   this.connectTimer=setTimeout(()=>this.disconnect(socket,Error('Collaborative connection timed out')),this.connectTimeoutMs);
   socket.onopen=()=>{if(this.socket!==socket||this.closed){socket.close();return;}clearTimeout(this.connectTimer);this.epoch++;this.lastMessage=Date.now();this.opening=undefined;this.rejectOpening=undefined;this.status('connecting');for(const channel of this.channels.values())this.ensureSubscription(channel);this.heartbeat();resolve();};
   socket.onmessage=event=>{if(this.socket!==socket||this.closed)return;let message;try{message=JSON.parse(String(event.data));}catch{return;}this.lastMessage=Date.now();this.heartbeat();const pending=this.pending.get(message.requestId);if(pending){clearTimeout(pending.timer);this.pending.delete(message.requestId);message.type==='error'?pending.reject(Object.assign(Error(message.error),{status:message.status})):pending.resolve(message);}if(message.namespace&&message.key)for(const listener of this.channels.get(message.namespace+'\0'+message.key)?.listeners||[])listener(message);};
   socket.onerror=()=>this.disconnect(socket,Error('Collaborative transport unavailable'));
   socket.onclose=()=>this.disconnect(socket,Error('Collaborative transport disconnected'));
  });return this.opening;
 }
 disconnect(socket,error,{immediate=false}={}){
  if(this.socket!==socket)return;this.socket=undefined;clearTimeout(this.connectTimer);clearTimeout(this.heartbeatTimer);this.opening=undefined;this.rejectOpening?.(error);this.rejectOpening=undefined;
  for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();for(const channel of this.channels.values())channel.ready=undefined;this.status('offline');
  // A half-open browser socket may never emit close. Retire it immediately and
  // fence its delayed callbacks so it cannot affect the replacement connection.
  try{socket?.close();}catch{}if(!this.closed&&this.channels.size){clearTimeout(this.retry);this.retry=setTimeout(()=>void this.connect().catch(()=>{}),immediate?0:this.retryMs);}
 }
 heartbeat(){clearTimeout(this.heartbeatTimer);if(this.closed||!this.channels.size||this.socket?.readyState!==this.Socket.OPEN||this.heartbeatMs<=0)return;this.heartbeatTimer=setTimeout(()=>{if(this.probing)return;this.probing=true;void this.send({type:'ping'},{timeoutMs:this.pingTimeoutMs}).catch(()=>{}).finally(()=>{this.probing=false;this.heartbeat();});},this.heartbeatMs);}
 send(message,{timeoutMs=this.requestTimeoutMs}={}){
  if(message.type==='subscribe'&&message.create===undefined)message={...message,create:!this.channels.get(message.namespace+'\0'+message.key)?.readOnly,seedFile:this.channels.get(message.namespace+'\0'+message.key)?.seedFile};const socket=this.socket;if(socket?.readyState!==this.Socket.OPEN)return Promise.reject(Error('Collaborative transport disconnected'));
  return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID(),timer=setTimeout(()=>{if(!this.pending.delete(requestId))return;const error=Error('Collaborative request timed out');reject(error);this.disconnect(socket,error,{immediate:true});},timeoutMs);this.pending.set(requestId,{resolve,reject,timer});try{socket.send(JSON.stringify({...message,requestId}));}catch(error){this.disconnect(socket,error,{immediate:true});}});
 }
 ensureSubscription(channel,options){if(channel.ready&&channel.epoch===this.epoch)return channel.ready;channel.epoch=this.epoch;channel.ready=this.send({type:'subscribe',namespace:channel.namespace,key:channel.key,kind:channel.kind,create:!channel.readOnly,seedFile:channel.seedFile},options);channel.ready.catch(()=>{});return channel.ready;}
 async request(message){await this.connect();return this.send(message);}
 wake(){
  if(this.closed||!this.channels.size)return Promise.resolve();if(this.waking)return this.waking;if(Date.now()-this.lastWake<250)return Promise.resolve();this.lastWake=Date.now();
  this.waking=(async()=>{const epoch=this.epoch;if(this.socket?.readyState===this.Socket.OPEN&&Date.now()-this.lastMessage>=this.heartbeatMs)this.disconnect(this.socket,Error('Refreshing idle collaborative transport'),{immediate:true});await this.connect();const subscriptions=[];for(const channel of this.channels.values()){if(this.epoch===epoch)channel.ready=undefined;subscriptions.push(this.ensureSubscription(channel,{timeoutMs:this.pingTimeoutMs}));}await Promise.all(subscriptions);})().catch(error=>{if(this.socket)this.disconnect(this.socket,error,{immediate:true});throw error;}).finally(()=>{this.waking=undefined;});return this.waking;
 }
 subscribe(namespace,key,kind,listener,{create=true,seedFile}={}){
  const id=namespace+'\0'+key;let channel=this.channels.get(id);if(channel&&channel.kind!==kind)throw Error('Document type cannot change');if(!channel){channel={namespace,key,kind,listeners:new Set(),epoch:-1,readOnly:!create,seedFile};this.channels.set(id,channel);}if(create&&channel.readOnly){channel.readOnly=false;channel.ready=undefined;}channel.listeners.add(listener);const ready=this.connect().then(()=>this.ensureSubscription(channel));ready.catch(()=>{});
  return{ready,promote:()=>{channel.readOnly=false;channel.ready=undefined;return this.connect().then(()=>this.ensureSubscription(channel));},unsubscribe:()=>{channel.listeners.delete(listener);if(!channel.listeners.size){this.channels.delete(id);if(!this.channels.size)clearTimeout(this.heartbeatTimer);if(this.socket?.readyState===this.Socket.OPEN)this.socket.send(JSON.stringify({type:'unsubscribe',namespace,key,kind}));}}};
 }
 status(status){for(const channel of this.channels.values())for(const listener of channel.listeners)listener({type:'status',namespace:channel.namespace,key:channel.key,kind:channel.kind,status});}
 close(){this.closed=true;clearTimeout(this.retry);clearTimeout(this.heartbeatTimer);clearTimeout(this.connectTimer);for(const event of ['online','pageshow','focus'])this.lifecycleTarget?.removeEventListener(event,this.onWake);this.visibilityTarget?.removeEventListener('visibilitychange',this.onWake);this.channels.clear();if(this.socket)this.disconnect(this.socket,Error('Collaborative transport closed'));}
}
