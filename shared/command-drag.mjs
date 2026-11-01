import{desktopFile}from'./desktop-placements.mjs';
import{dragObjectIds}from'../sdk/src/object-drag.js';
export function commandDragIds(command,item){
 if(item===undefined)return command?.id==='open'&&command.handler?.type==='open'?dragObjectIds([command.appId]):[];
 return command?.handler?.type==='query'&&desktopFile(item)?dragObjectIds([item.id]):[];
}
