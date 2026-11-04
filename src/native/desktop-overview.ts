import{adjacentWorkspace}from '../../shared/workspace-gestures.mjs';
import{trackPointer}from './pointer-tracking';import {el,button,icon} from './dom';
import{fixedPreview}from './fixed-preview';
import type {WorldObject} from '../types';
import type {Compositor} from './compositor';
type OverviewCard={section:HTMLElement;rename:HTMLInputElement;remove:HTMLButtonElement;canvas:HTMLElement;preview:string};
export class DesktopOverview{
 readonly node=el('div',{class:'window-overview',role:'dialog','aria-label':'Window overview'});readonly desktops=el('div',{class:'overview-desktops'});readonly track=el('div',{class:'overview-track'});offset=NaN;readonly cards=new Map<number,OverviewCard>();signature='';reordering=false;selected:number;readonly observer:ResizeObserver;
 readonly previous=button('Previous desktop','chevron-left',()=>this.step(-1),'overview-step-button');
 readonly next=button('Next desktop','chevron-right',()=>this.step(1),'overview-step-button');
 readonly navigation=el('nav',{class:'overview-navigation','aria-label':'Choose desktop',popover:'manual'},this.previous,this.next);
 constructor(readonly compositor:Compositor,readonly getObject:(id?:string)=>WorldObject|undefined,readonly close:()=>void,readonly select:(id:number,windowKey?:string)=>void,readonly changed:()=>void=()=>{}){
  this.selected=compositor.workspace;
  const head=el('div',{class:'overview-header'},el('span',{},'Desktops'),this.navigation,el('span',{class:'spacer'}),el('span',{class:'overview-gesture-hint'},'← / → to choose · Swipe down to open'),el('button',{class:'button',onclick:()=>{const id=compositor.addWorkspace();this.refresh();this.choose(id);}},icon('plus',14),'New desktop'),button('Close overview','close',this.close));this.desktops.append(this.track);this.node.append(head,this.desktops);this.refresh();
  this.observer=new ResizeObserver(()=>{if(this.node.isConnected)this.reveal(this.selected,'instant');});this.observer.observe(this.desktops);
  this.node.addEventListener('keydown',event=>{if(event.defaultPrevented||(event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]'))return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();this.step(event.key==='ArrowRight'?1:-1);}else if(event.key==='Enter'&&event.target===this.node){event.preventDefault();this.select(this.selected);}});
  requestAnimationFrame(()=>{if(this.node.isConnected)this.reveal(this.selected,'instant');});
 }
 reveal(id:number,behavior:ScrollBehavior=matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'){const card=this.cards.get(id);if(!card)return;this.positionNavigation();const next=this.desktops.clientWidth/2-card.section.offsetLeft-card.section.offsetWidth/2;if(Math.abs(next-this.offset)<.5)return;this.offset=next;this.track.style.transition=behavior==='instant'?'none':'';this.track.style.transform=`translate3d(${next}px,0,0)`;}
 pan(amount:number){this.offset=(Number.isFinite(this.offset)?this.offset:0)+amount;this.track.style.transition='none';this.track.style.transform=`translate3d(${this.offset}px,0,0)`;}

 choose(id:number){if(!this.cards.has(id))return;this.selected=id;this.paintSelection();this.changed();this.reveal(id);}
 step(direction:number){if(this.reordering)return;const id=adjacentWorkspace(this.compositor.workspaces,this.selected,direction);if(id!==undefined)this.choose(id);}
 paintSelection(){const focused=document.activeElement;this.previous.hidden=adjacentWorkspace(this.compositor.workspaces,this.selected,-1)===undefined;this.next.hidden=adjacentWorkspace(this.compositor.workspaces,this.selected,1)===undefined;this.navigation.hidden=this.previous.hidden&&this.next.hidden;if(focused===this.previous&&this.previous.hidden||focused===this.next&&this.next.hidden)this.node.focus({preventScroll:true});this.node.dataset.selectedDesktop=String(this.selected);for(const[id,card]of this.cards){card.section.classList.toggle('is-current',id===this.selected);card.rename.classList.toggle('active',id===this.selected);if(id===this.selected)card.canvas.setAttribute('aria-current','true');else card.canvas.removeAttribute('aria-current');}}
 positionNavigation(){
  if(!this.node.isConnected)return;
  const popovers=typeof this.navigation.showPopover==='function';
  if(this.navigation.hidden){if(popovers&&this.navigation.matches(':popover-open'))this.navigation.hidePopover();return;}
  const bounds=this.node.getBoundingClientRect(),viewport=this.desktops.getBoundingClientRect(),preview=this.cards.get(this.selected)?.canvas;if(!preview)return;let top=0;for(let element:HTMLElement|null=preview;element&&element!==this.desktops;element=element.offsetParent as HTMLElement|null)top+=element.offsetTop;
  this.navigation.style.left=bounds.left+'px';this.navigation.style.top=viewport.top+top+preview.offsetHeight/2-20+'px';this.navigation.style.width=bounds.width+'px';
  if(popovers&&!this.navigation.matches(':popover-open')){this.navigation.style.opacity='0';this.navigation.showPopover();this.navigation.getBoundingClientRect();this.navigation.style.opacity='1';}
 }
 destroy(){this.observer.disconnect();if(typeof this.navigation.hidePopover==='function'&&this.navigation.matches(':popover-open'))this.navigation.hidePopover();}
 createCard(id:number):OverviewCard{
  const c=this.compositor,go=()=>this.select(id),canvas=el('div',{class:'overview-canvas',tabIndex:0}),section=el('section',{class:'overview-section','data-desktop-id':id}),rename=el('input',{maxlength:80,class:'overview-rename'}),current=()=>c.workspaces.find(space=>space.id===id);
  const commitName=()=>{if(rename.value.trim())c.renameWorkspace(id,rename.value);rename.value=current()?.name||'';};rename.addEventListener('change',commitName);rename.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commitName();rename.blur();}if(e.key==='Escape'){e.stopPropagation();rename.value=current()?.name||'';rename.blur();}});
  const remove=button('Delete desktop','close',()=>c.removeWorkspace(id)),header=el('header',{class:'overview-desktop-title'},rename,remove);section.append(header,canvas);
  header.addEventListener('pointerdown',e=>{if(e.target===header)this.beginReorder(e,section,this.track,id);});canvas.addEventListener('pointerdown',e=>{if(e.target===canvas)this.beginReorder(e,section,this.track,id);});section.addEventListener('click',e=>{if(section.dataset.suppressClick==='true'){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});canvas.addEventListener('click',go);canvas.addEventListener('keydown',e=>{if(e.target===canvas&&(e.key==='Enter'||e.key===' ')){e.preventDefault();go();}});
  return{section,rename,remove,canvas,preview:''};
 }
 refresh(){if(this.reordering)return;const c=this.compositor,selectionChanged=!c.workspaces.some(space=>space.id===this.selected);if(selectionChanged)this.selected=c.workspace;const windows=c.windows.map(w=>[w.key,w.workspace,w.z,w.minimized,w.x,w.y,w.width,w.height,w.maximized,c.title(w),c.glyph(w)]),signature=JSON.stringify([c.workspaces,this.selected,windows,c.placements,c.area]);if(signature===this.signature)return;this.signature=signature;
  const wanted=new Set(c.workspaces.map(space=>space.id));
  for(const[id,card]of this.cards)if(!wanted.has(id)){card.section.remove();this.cards.delete(id);}
  for(const[index,space]of c.workspaces.entries()){
   let card=this.cards.get(space.id);if(!card){card=this.createCard(space.id);this.cards.set(space.id,card);}const{section,rename,remove,canvas}=card,reference=this.track.children[index];if(reference!==section)this.track.insertBefore(section,reference||null);
   if(document.activeElement!==rename)rename.value=space.name;rename.title=space.name;rename.setAttribute('aria-label','Rename '+space.name);rename.classList.toggle('active',space.id===this.selected);section.classList.toggle('is-current',space.id===this.selected);remove.setAttribute('aria-label','Delete '+space.name);remove.disabled=c.workspaces.length===1;remove.title=remove.disabled?'Keep at least one desktop':'Discard this desktop layout; files stay saved';canvas.setAttribute('aria-label','Switch to '+space.name);
   const preview=JSON.stringify([c.area,c.placements[space.id],windows.filter(w=>w[1]===space.id)]);if(card.preview!==preview){card.preview=preview;canvas.style.setProperty('--preview-aspect',c.area.width+'/'+(c.area.height+32));canvas.replaceChildren(fixedPreview(c.windows,space.id,c.area,this.getObject,c.placements[space.id]||{},w=>c.title(w),w=>c.glyph(w),w=>this.select(space.id,w.key)));}
  }
  this.paintSelection();if(this.node.isConnected)this.reveal(this.selected,'instant');
 }
 beginReorder(e:PointerEvent,section:HTMLElement,grid:HTMLElement,id:number){
  if(e.button!==0||this.reordering)return;this.reordering=true;const target=e.currentTarget as HTMLElement,origin={x:e.clientX,y:e.clientY},start=section.getBoundingClientRect(),cards=[...grid.children] as HTMLElement[],slots=cards.map(n=>n.getBoundingClientRect()),initialScroll=-this.offset,gridBounds=this.desktops.getBoundingClientRect(),overlayBounds=grid.getBoundingClientRect();let stopTracking=()=>{},x=origin.x,y=origin.y,frame=0,moved=false,done=false,index=cards.indexOf(section);const placeholder=el('div',{class:'overview-placeholder',style:{height:start.height+'px',width:start.width+'px',flex:'0 0 '+start.width+'px'}});
  try{target.setPointerCapture(e.pointerId);}catch{}
  const apply=()=>{frame=0;if(!moved){if(Math.hypot(x-origin.x,y-origin.y)<5)return;moved=true;this.reordering=true;grid.classList.add('is-reordering');section.dataset.suppressClick='true';grid.insertBefore(placeholder,section);section.classList.add('is-reordering');Object.assign(section.style,{position:'absolute',left:start.x-overlayBounds.x+'px',top:start.y-overlayBounds.y+'px',width:start.width+'px',height:start.height+'px',margin:'0'});}
   section.style.transform=`translate3d(${x-origin.x-this.offset-initialScroll}px,${y-origin.y}px,0) scale(1.025)`;
   const scroll=x<gridBounds.left+50?-16:x>gridBounds.right-50?16:0;if(scroll&&!done){this.pan(-scroll);if(!frame)frame=requestAnimationFrame(apply);}const offset=-this.offset-initialScroll;const next=slots.reduce((best,r,i)=>Math.abs(x-(r.x+r.width/2-offset))<Math.abs(x-(slots[best].x+slots[best].width/2-offset))?i:best,0);
   if(next===index)return;index=next;const others=cards.filter(n=>n!==section),before=others.map(n=>n.getBoundingClientRect());grid.insertBefore(placeholder,others[next]||null);
   for(const [i,node]of others.entries()){const after=node.getBoundingClientRect(),dx=before[i].x-after.x,dy=before[i].y-after.y;if((dx||dy)&&!matchMedia('(prefers-reduced-motion: reduce)').matches)node.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});}
  };
  const move=(ev:PointerEvent)=>{x=ev.clientX;y=ev.clientY;if(!frame)frame=requestAnimationFrame(apply);};
  const end=(event:Event)=>{if(done)return;done=true;stopTracking();if(event instanceof MouseEvent&&event.type!=='pointercancel'){x=event.clientX;y=event.clientY;}target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);target.removeEventListener('lostpointercapture',end);removeEventListener('keydown',escape,true);if(frame)cancelAnimationFrame(frame);if(frame||event instanceof MouseEvent)apply();if(target.hasPointerCapture(e.pointerId))target.releasePointerCapture(e.pointerId);if(!moved){this.reordering=false;return;}
   const cancelled=event.type==='pointercancel'||event.type==='keydown',destination=placeholder.getBoundingClientRect();
   const finish=()=>{placeholder.replaceWith(section);section.style.cssText='';section.classList.remove('is-reordering');setTimeout(()=>delete section.dataset.suppressClick,0);this.reordering=false;grid.classList.remove('is-reordering');if(!cancelled)this.compositor.reorderWorkspace(id,index);this.signature='';this.refresh();this.reveal(this.selected);};
   if(cancelled||matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
   section.animate([{transform:section.style.transform},{transform:`translate3d(${destination.x-start.x}px,${destination.y-start.y}px,0) scale(1)`}],{duration:140,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'}).finished.then(finish,finish);
  };
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();end(event);}};addEventListener('keydown',escape,true);stopTracking=trackPointer(e,move,end,target);
 }

}
