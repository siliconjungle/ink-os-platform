// A burst keeps the owner selected by its first event, even across surfaces.
export class GestureLatch {
 constructor(idleMs=240){this.idleMs=idleMs;this.current=null;}
 route(kind,owner,now){const previous=this.current;if(previous&&previous.kind===kind&&now-previous.last<this.idleMs){previous.last=now;return{owner:previous.owner,started:false};}this.current={kind,owner,last:now};return{owner,started:true};}
 finish(){this.current=null;}
}
export function nativeScrollTarget(target,style=globalThis.getComputedStyle){
 for(let node=target;node;node=node.parentElement){
  if(['TEXTAREA','INPUT','SELECT'].includes(node.tagName)||node.isContentEditable)return node;
  if(!style)continue;const value=style(node);if(/auto|scroll|overlay/.test(value.overflowY)&&node.scrollHeight>node.clientHeight+1||/auto|scroll|overlay/.test(value.overflowX)&&node.scrollWidth>node.clientWidth+1)return node;
 }
 return null;
}
