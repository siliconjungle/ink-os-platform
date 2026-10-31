/** The host accepts inert labels and identifiers, never executable app code. */
export function frameContextMenu(message,select){
 if(!Object.hasOwn(message,'items'))return undefined;
 if(typeof message.menuId!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(message.menuId)||!Array.isArray(message.items)||message.items.length>40)return[];
 const seen=new Set(),items=[];
 for(const item of message.items){
  if(!item||typeof item.id!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(item.id)||seen.has(item.id)||typeof item.label!=='string'||!item.label.trim()||item.label.length>120||/[\u0000-\u001f\u007f]/.test(item.label))return[];
  seen.add(item.id);const disabled=item.disabled===true;
  items.push([item.label.trim(),()=>{if(!disabled)select({menuId:message.menuId,id:item.id});},disabled]);
 }
 return items;
}
/** Content menus never acquire file-management or desktop fallback actions. */
export function appContentActions(context){
 if(context.items!==undefined)return context.items;
 if(context.editable&&context.edit)return[['Cut',()=>context.edit('cut')],['Copy',()=>context.edit('copy')],['Paste',()=>context.edit('paste')],['Select all',()=>context.edit('selectAll')]];
 if(context.selection&&context.edit)return[['Copy',()=>context.edit('copy')]];
 return[];
}
