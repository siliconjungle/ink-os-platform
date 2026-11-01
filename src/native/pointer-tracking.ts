/** Capture is an optimisation. Gesture lifetime belongs to the page, not the element. */
export function trackPointer(start:PointerEvent,move:(event:PointerEvent)=>void,end:(event:Event)=>void,target:HTMLElement,startedAt=Date.now()){
 let stopped=false;
 const cleanup=()=>{if(stopped)return;stopped=true;removeEventListener('pointermove',onMove,true);removeEventListener('pointerup',finish,true);removeEventListener('pointercancel',finish,true);removeEventListener('mouseup',mouseUp,true);removeEventListener('blur',interrupted);removeEventListener('pagehide',interrupted);removeEventListener('ink-pointer-interrupt',interrupted);removeEventListener('ink-pointer-release',frameRelease);document.removeEventListener('visibilitychange',visibility);};
 const onMove=(event:PointerEvent)=>{if(event.pointerId===start.pointerId)move(event);};
 const finish=(event:PointerEvent)=>{if(event.pointerId!==start.pointerId)return;cleanup();end(event);};
 const mouseUp=(event:MouseEvent)=>{if(event.button!==0||(start.pointerType&&start.pointerType!=='mouse'))return;cleanup();end(event);};
 const interrupted=()=>{cleanup();end(new Event('pointercancel'));};
 const visibility=()=>{if(document.hidden)interrupted();};
 const frameRelease=(event:Event)=>{const detail=(event as CustomEvent).detail;if(detail?.pointerId!==start.pointerId||Number(detail.at)<startedAt)return;cleanup();end(new PointerEvent('pointerup',{pointerId:start.pointerId,clientX:detail.x,clientY:detail.y}));};
 addEventListener('pointermove',onMove,true);addEventListener('pointerup',finish,true);addEventListener('pointercancel',finish,true);addEventListener('mouseup',mouseUp,true);addEventListener('blur',interrupted);addEventListener('pagehide',interrupted);addEventListener('ink-pointer-interrupt',interrupted);addEventListener('ink-pointer-release',frameRelease);document.addEventListener('visibilitychange',visibility);
 return cleanup;
}
