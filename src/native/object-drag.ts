import{dragObjectIds,type ObjectDragStart}from'../../sdk/src/object-drag.js';
import{trackPointer}from'./pointer-tracking';
import{el,icon}from'./dom';
import{objectIcon}from'./object-icon';
import type{WorldObject}from'../types';
import'./object-drag.css';
export class ObjectDrag{
 stop?:()=>void;
 constructor(readonly host:{get:(id:string)=>WorldObject|undefined;over:(ids:string[],x:number,y:number)=>void;leave:()=>void;drop:(ids:string[],x:number,y:number,start:ObjectDragStart)=>void}){}
 start(start:ObjectDragStart){
  const ids=dragObjectIds(start.ids),objects=ids.map(this.host.get);if(!ids.length||objects.some(o=>!o))throw Error('Drag items are no longer available');
  this.stop?.();const first=objects[0]!,ghost=el('div',{class:'object-drag-preview','aria-hidden':true},icon(objectIcon(first),31),el('span',{},first.title||'Untitled'),ids.length>1?el('small',{},String(ids.length)):undefined);document.body.append(ghost);document.documentElement.classList.add('has-object-drag');let done=false,untrack=()=>{};
  const paint=(x:number,y:number)=>{ghost.style.transform=`translate3d(${x-88*start.grabX}px,${y-80*start.grabY}px,0)`;this.host.over(ids,x,y);};
  const finish=(event:Event)=>{if(done)return;done=true;untrack();removeEventListener('keydown',escape,true);ghost.remove();document.documentElement.classList.remove('has-object-drag');this.host.leave();this.stop=undefined;if(['pointerup','mouseup'].includes(event.type)&&event instanceof MouseEvent)this.host.drop(ids,event.clientX,event.clientY,start);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(new Event('pointercancel'));}};
  this.stop=()=>finish(new Event('pointercancel'));addEventListener('keydown',escape,true);untrack=trackPointer(new PointerEvent('pointerdown',{pointerId:start.pointerId,pointerType:start.pointerType}),e=>paint(e.clientX,e.clientY),finish,document.body,start.at);paint(start.x,start.y);
 }
}
