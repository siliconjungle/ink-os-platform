export function installZoomLock() {
  const key=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&['+','-','=','_','0'].includes(event.key))event.preventDefault();};
  const wheel=(event:WheelEvent)=>{if(event.ctrlKey||event.metaKey)event.preventDefault();};
  const gesture=(event:Event)=>event.preventDefault();
  addEventListener('keydown',key,{capture:true});addEventListener('wheel',wheel,{passive:false,capture:true});
  for(const type of ['gesturestart','gesturechange','gestureend'])addEventListener(type,gesture,{passive:false,capture:true});
  return ()=>{removeEventListener('keydown',key,true);removeEventListener('wheel',wheel,true);for(const type of ['gesturestart','gesturechange','gestureend'])removeEventListener(type,gesture,true);};
}
