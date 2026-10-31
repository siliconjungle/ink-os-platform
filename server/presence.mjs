import{presenceCursor}from'../shared/presence-cursor.mjs';
const finite=value=>Number.isFinite(value)&&Math.abs(value)<1e8;
const windowKey=value=>typeof value==='string'&&/^[-a-zA-Z0-9]{1,100}$/.test(value)?value:undefined;
export function updatePresence(client,input,now=Date.now()){
 if(!Number.isSafeInteger(input.sequence)||input.sequence<=(client.sequence||0))return false;
 client.sequence=input.sequence;const before=JSON.stringify([client.view,client.window,client.cursor,client.gesture,client.appId,client.objectId]);
 if(typeof input.view==='string'&&/^desktop\/[0-9]{1,16}$/.test(input.view)&&Number.isSafeInteger(Number(input.view.slice(8)))){if(client.view!==input.view){client.cursor=null;client.gesture=null;}client.view=input.view;}
 if('window'in input)client.window=windowKey(input.window);
 for(const key of ['appId','objectId'])if(key in input)client[key]=typeof input[key]==='string'&&/^[a-f0-9]{32}$/.test(input[key])?input[key]:undefined;
 if('cursor'in input)client.cursor=presenceCursor(input.cursor);
 if(input.gesture===null)client.gesture=null;else if(input.gesture){const{key,rect,kind}=input.gesture;if(windowKey(key)&&['move','resize'].includes(kind)&&rect&&[rect.x,rect.y,rect.width,rect.height].every(finite)&&rect.width>0&&rect.height>0)client.gesture={key,kind,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},at:now};}
 return before!==JSON.stringify([client.view,client.window,client.cursor,client.gesture,client.appId,client.objectId]);
}
export function visiblePeer(peer,viewer){return{id:peer.id,accountId:peer.accountId,name:peer.name,color:peer.color,view:peer.view,window:peer.window,appId:peer.appId,objectId:peer.objectId,cursor:peer.view===viewer?.view?peer.cursor:null,gesture:peer.view===viewer?.view?peer.gesture:null};}

// A transport connection is not a person online until its desktop announces itself.
export const announcedPresence=peer=>typeof peer.view==='string'&&/^desktop\/[0-9]{1,16}$/.test(peer.view)&&!peer.res?.writableEnded&&!peer.res?.destroyed;
export const expiredPresence=(peer,now=Date.now(),ttl=90000)=>!!peer.presenceLease&&now-peer.lastSeen>ttl;
export function touchPresence(peer,accountId,now=Date.now()){if(!peer||peer.accountId!==accountId)return false;peer.lastSeen=now;return true;}
