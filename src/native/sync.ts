import{SyncHub}from '../../shared/sync-hub.mjs';
let hub:SyncHub|undefined;export const syncHub=()=>hub||=new SyncHub((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/v1/sync',{lifecycleTarget:window,visibilityTarget:document});
