// A single in-flight read per subscription; invalidated reads never replace newer results.
export function watchQuery({read,subscribe,onResult,onError=()=>{},signal,delay=24,relevant=()=>true}) {
 let closed=false,dirty=true,running=false,timer,controller,settled=false,resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 function schedule(){if(!closed&&!running&&timer===undefined)timer=setTimeout(run,delay);}
 function invalidate(event){if(closed||event!==undefined&&!relevant(event))return;dirty=true;controller?.abort();schedule();}
 async function run(){timer=undefined;if(closed||running||!dirty)return;dirty=false;running=true;controller=new AbortController();try{const result=await read({signal:controller.signal});if(!closed&&!dirty){onResult(result);if(!settled){settled=true;resolveReady(result);}}}catch(error){if(!closed&&!dirty&&error.name!=='AbortError'){onError(error);if(!settled){settled=true;rejectReady(error);}}}finally{running=false;controller=undefined;if(dirty)schedule();}}
 const stop=subscribe(invalidate);
 function unsubscribe(){if(closed)return;closed=true;clearTimeout(timer);controller?.abort();stop?.();signal?.removeEventListener('abort',unsubscribe);if(!settled){settled=true;rejectReady(signal?.reason||new DOMException('Subscription closed','AbortError'));}}
 signal?.addEventListener('abort',unsubscribe,{once:true});if(signal?.aborted)unsubscribe();else schedule();
 return Object.freeze({ready,unsubscribe,refresh:()=>invalidate()});
}

// Previously matched IDs must invalidate even after a rename, archive or filter change.
export function queryInvalidator(query={}) {
 let ids=new Set(),version=-1;
 const matches=o=>!!o&&(!query.namespace||o.namespace===query.namespace)&&(!query.kind||o.kind===query.kind);
 return {accept(result){ids=new Set(result.objects.map(o=>o.id));version=Number(result.version??-1);},relevant(event){if(event.quiet)return false;if(['ready','refresh','world.metadata'].includes(event.type))return event.version===undefined||Number(event.version)>version;if(event.object)return ids.has(event.object.id)||matches(event.object);if(event.objects||event.removed)return(event.objects||[]).some(o=>ids.has(o.id)||matches(o))||(event.removed||[]).length>0;return true;}};
}
