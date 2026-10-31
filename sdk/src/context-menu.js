/** App-owned menus travel over the existing, checked SDK channel. */
export function createContextMenus({send,on,selection=()=>String(getSelection()||''),report=()=>{},defer=fn=>typeof requestAnimationFrame==='function'?requestAnimationFrame(fn):queueMicrotask(fn)}){
 let registration,serial=0,active;
 const show=(event,items)=>{
  if(!event||typeof event.preventDefault!=='function')throw TypeError('Pass a contextmenu event');
  if(!Array.isArray(items)||items.length>40)throw TypeError('Context menu requires up to 40 items');
  const actions=new Map(),wire=items.map((item,index)=>{
   if(!item||typeof item.label!=='string'||!item.label.trim()||item.label.length>120||/[\u0000-\u001f\u007f]/.test(item.label)||typeof item.onSelect!=='function')throw TypeError('Each menu item requires a label and onSelect callback');
   const id=String(index),disabled=item.disabled===true;if(!disabled)actions.set(id,item.onSelect);
   return{id,label:item.label.trim(),disabled};
  });
  event.preventDefault();active={menuId:String(++serial),actions,target:event.target};
  send({type:'contextmenu',menuId:active.menuId,x:event.clientX,y:event.clientY,items:wire});
 };
 const register=items=>{
  if(!Array.isArray(items)&&typeof items!=='function')throw TypeError('Register menu items or a synchronous item resolver');
  const value={items};registration=value;return()=>{if(registration===value)registration=undefined;};
 };
 const handle=event=>{
  // DOM/app/library handlers can own their menu with preventDefault().
  if(event.defaultPrevented)return false;
  const target=event.target,editable=!!target?.closest?.('input,textarea,[contenteditable=true]'),selected=selection();
  try{const items=registration&&(typeof registration.items==='function'?registration.items({event,target,selection:selected,editable}):registration.items);if(items!==undefined&&items!==false){show(event,items);return true;}}catch(error){event.preventDefault();report(error);return true;}
  event.preventDefault();active=undefined;
  send({type:'contextmenu',x:event.clientX,y:event.clientY,selection:selected,editable});return true;
 };
 on('contextmenu.select',value=>{if(!active||value?.menuId!==active.menuId)return;const action=active.actions.get(value.id);if(!action)return;const target=active.target?.closest?.('input,textarea,select,button,a[href],[tabindex],[contenteditable=true]');active=undefined;target?.focus?.({preventScroll:true});defer(()=>{try{Promise.resolve(action()).catch(report);}catch(error){report(error);}});});
 return{api:{register,show},handle};
}
