import{dragObjectIds}from'../sdk/src/object-drag.js';
export function objectDragStart(input,now=Date.now()){
 if(!input||typeof input!=='object')return null;const ids=dragObjectIds(input.ids);
 if(!ids.length||![input.x,input.y,input.grabX,input.grabY,input.at].every(Number.isFinite)||!Number.isInteger(input.pointerId)||input.pointerId<0||input.pointerId>2147483647||!['mouse','touch','pen'].includes(input.pointerType)||Math.abs(input.x)>1e7||Math.abs(input.y)>1e7||input.grabX<0||input.grabX>1||input.grabY<0||input.grabY>1||Math.abs(now-input.at)>10000)return null;
 // A fast gesture can already be outside its source iframe when the handoff arrives.
 return{ids,pointerId:input.pointerId,pointerType:input.pointerType,x:input.x,y:input.y,grabX:input.grabX,grabY:input.grabY,at:input.at};
}
