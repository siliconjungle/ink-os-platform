export function dragObjectIds(value){if(!Array.isArray(value)||!value.length||value.length>1000||value.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)))return[];return[...new Set(value)];}
/** Internal drags stay in the desktop's pointer stream, including when a source is an iframe. */
export function bindObjectDrag(node,{objects,begin,error=()=>{}}){
 node.draggable=false;node.style.touchAction='none';let stop=()=>{},suppressClick=false,reset;
 const click=event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}};
 const down=event=>{
  if(event.button!==0||event.isPrimary===false||event.target.closest?.('input,textarea,select,a,[contenteditable=true],[data-drag-ignore]'))return;
  const ids=dragObjectIds(objects());if(!ids.length)return;stop();event.preventDefault();
  const x=event.clientX,y=event.clientY,rect=node.getBoundingClientRect(),at=Date.now();
  const cleanup=()=>{removeEventListener('pointermove',move,true);removeEventListener('pointerup',up,true);removeEventListener('pointercancel',up,true);removeEventListener('blur',cleanup);removeEventListener('keydown',key,true);};
  const up=e=>{if(e.pointerId===event.pointerId)cleanup();},key=e=>{if(e.key==='Escape')cleanup();};
  const move=e=>{if(e.pointerId!==event.pointerId||Math.hypot(e.clientX-x,e.clientY-y)<6)return;cleanup();suppressClick=true;clearTimeout(reset);reset=setTimeout(()=>{suppressClick=false;},1000);try{Promise.resolve(begin({ids,pointerId:event.pointerId,pointerType:event.pointerType||'mouse',x:e.clientX,y:e.clientY,grabX:Math.max(0,Math.min(1,(x-rect.left)/Math.max(1,rect.width))),grabY:Math.max(0,Math.min(1,(y-rect.top)/Math.max(1,rect.height))),at})).catch(error);}catch(e){error(e);}};
  stop=cleanup;addEventListener('pointermove',move,true);addEventListener('pointerup',up,true);addEventListener('pointercancel',up,true);addEventListener('blur',cleanup);addEventListener('keydown',key,true);
 };
 node.addEventListener('pointerdown',down);node.addEventListener('click',click,true);
 return()=>{stop();clearTimeout(reset);node.removeEventListener('pointerdown',down);node.removeEventListener('click',click,true);};
}
