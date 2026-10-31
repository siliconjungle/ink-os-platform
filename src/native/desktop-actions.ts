import{api,sessionId}from'../api';
export function desktopActions(open:(action:{id:string;appId:string;handoff?:any})=>void|Promise<void>,toast:(text:string)=>void){
 const stream=new EventSource('/api/v1/desktop/events?clientId='+encodeURIComponent(sessionId));let busy=false,wanted=false,closed=false;const seen=new Set<string>();
 const drain=async()=>{wanted=true;if(busy||closed)return;busy=true;try{do{wanted=false;for(;;){const action=await api<any>('/v1/desktop/actions/claim',{method:'POST',body:JSON.stringify({clientId:sessionId})});if(!action)break;let status='opened',error;try{if(!seen.has(action.id)){await open(action);seen.add(action.id);if(seen.size>100)seen.delete(seen.values().next().value!);}}catch(e){status='failed';error=(e as Error).message;toast(error);}await api('/v1/desktop/actions/'+action.id+'/ack',{method:'POST',body:JSON.stringify({clientId:sessionId,status,error})});}}while(wanted&&!closed);}catch(e){toast((e as Error).message);}finally{busy=false;}};
 stream.addEventListener('wake',()=>void drain());return()=>{closed=true;stream.close();};
}
