import{trackPointer}from './pointer-tracking';import {el,button,icon} from './dom';
import{fixedPreview}from './fixed-preview';
import type {WorldObject} from '../types';
import type {Compositor} from './compositor';
type OverviewCard={section:HTMLElement;rename:HTMLInputElement;remove:HTMLButtonElement;canvas:HTMLElement;preview:string};
export class DesktopOverview{
 readonly node=el('div',{class:'window-overview',role:'dialog','aria-label':'Window overview'});readonly desktops=el('div',{class:'overview-desktops'});readonly cards=new Map<number,OverviewCard>();signature='';reordering=false;
 constructor(readonly compositor:Compositor,readonly getObject:(id?:string)=>WorldObject|undefined){
  const head=el('div',{class:'overview-header'},el('span',{},'Desktops'),el('span',{class:'spacer'}),el('button',{class:'button',onclick:()=>{const id=compositor.addWorkspace();this.refresh();this.reveal(id);}},icon('plus',14),'New desktop'),button('Close overview','close',()=>this.node.remove()));this.node.append(head,this.desktops);this.refresh();requestAnimationFrame(()=>{if(this.node.isConnected)this.reveal(compositor.workspace,'instant');});
 }
 reveal(id:number,behavior:ScrollBehavior=matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'){const card=this.cards.get(id);if(!card)return;const bounds=this.desktops.getBoundingClientRect(),rect=card.section.getBoundingClientRect();this.desktops.scrollTo({left:this.desktops.scrollLeft+rect.left-bounds.left-(this.desktops.clientWidth-rect.width)/2,behavior});}
 createCard(id:number):OverviewCard{
  const c=this.compositor,close=()=>this.node.remove(),go=()=>{c.switchWorkspace(id);close();},canvas=el('div',{class:'overview-canvas',tabIndex:0}),section=el('section',{class:'overview-section','data-desktop-id':id}),rename=el('input',{maxlength:80,class:'overview-rename'}),current=()=>c.workspaces.find(space=>space.id===id);
  const commitName=()=>{if(rename.value.trim())c.renameWorkspace(id,rename.value);rename.value=current()?.name||'';};rename.addEventListener('change',commitName);rename.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commitName();rename.blur();}if(e.key==='Escape'){e.stopPropagation();rename.value=current()?.name||'';rename.blur();}});
  const remove=button('Delete desktop','close',()=>c.removeWorkspace(id)),header=el('header',{class:'overview-desktop-title'},rename,remove);section.append(header,canvas);
  header.addEventListener('pointerdown',e=>{if(e.target===header)this.beginReorder(e,section,this.desktops,id);});canvas.addEventListener('pointerdown',e=>{if(e.target===canvas)this.beginReorder(e,section,this.desktops,id);});section.addEventListener('click',e=>{if(section.dataset.suppressClick==='true'){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});canvas.addEventListener('click',go);canvas.addEventListener('keydown',e=>{if(e.target===canvas&&(e.key==='Enter'||e.key===' ')){e.preventDefault();go();}});
  return{section,rename,remove,canvas,preview:''};
 }
 refresh(){if(this.reordering)return;const c=this.compositor,windows=c.windows.map(w=>[w.key,w.workspace,w.z,w.minimized,w.x,w.y,w.width,w.height,w.maximized,c.title(w),c.glyph(w)]),signature=JSON.stringify([c.workspaces,c.workspace,windows,c.placements,c.area]);if(signature===this.signature)return;this.signature=signature;
  // Anchor a surviving visible card before changing the list. Keep the scroller,
  // inputs and cards alive so sync acknowledgements never restart a scroll.
  const wanted=new Set(c.workspaces.map(space=>space.id)),bounds=this.desktops.getBoundingClientRect(),anchor=[...this.cards].filter(([id,card])=>wanted.has(id)&&card.section.parentElement===this.desktops).map(([id,card])=>({id,rect:card.section.getBoundingClientRect()})).filter(({rect})=>rect.right>bounds.left&&rect.left<bounds.right).sort((a,b)=>Math.abs(a.rect.left+a.rect.width/2-(bounds.left+bounds.width/2))-Math.abs(b.rect.left+b.rect.width/2-(bounds.left+bounds.width/2)))[0];
  for(const[id,card]of this.cards)if(!wanted.has(id)){card.section.remove();this.cards.delete(id);}
  for(const[index,space]of c.workspaces.entries()){
   let card=this.cards.get(space.id);if(!card){card=this.createCard(space.id);this.cards.set(space.id,card);}const{section,rename,remove,canvas}=card,reference=this.desktops.children[index];if(reference!==section)this.desktops.insertBefore(section,reference||null);
   if(document.activeElement!==rename)rename.value=space.name;rename.title=space.name;rename.setAttribute('aria-label','Rename '+space.name);rename.classList.toggle('active',space.id===c.workspace);section.classList.toggle('is-current',space.id===c.workspace);remove.setAttribute('aria-label','Delete '+space.name);remove.disabled=c.workspaces.length===1;remove.title=remove.disabled?'Keep at least one desktop':'Discard this desktop layout; files stay saved';canvas.setAttribute('aria-label','Switch to '+space.name);
   const preview=JSON.stringify([c.area,c.placements[space.id],windows.filter(w=>w[1]===space.id)]);if(card.preview!==preview){card.preview=preview;canvas.style.setProperty('--preview-aspect',c.area.width+'/'+(c.area.height+32));canvas.replaceChildren(fixedPreview(c.windows,space.id,c.area,this.getObject,c.placements[space.id]||{},w=>c.title(w),w=>c.glyph(w),w=>{c.switchWorkspace(space.id);c.focus(w.key,true);this.node.remove();}));}
  }
  if(anchor){const section=this.cards.get(anchor.id)!.section,delta=section.getBoundingClientRect().left-anchor.rect.left;if(Math.abs(delta)>.5)this.desktops.scrollTo({left:this.desktops.scrollLeft+delta,behavior:'instant'});}
 }
 beginReorder(e:PointerEvent,section:HTMLElement,grid:HTMLElement,id:number){
  if(e.button!==0||this.reordering)return;this.reordering=true;const target=e.currentTarget as HTMLElement,origin={x:e.clientX,y:e.clientY},start=section.getBoundingClientRect(),cards=[...grid.children] as HTMLElement[],slots=cards.map(n=>n.getBoundingClientRect()),initialScroll=grid.scrollLeft,gridBounds=grid.getBoundingClientRect(),overlayBounds=this.node.getBoundingClientRect();let stopTracking=()=>{},x=origin.x,y=origin.y,frame=0,moved=false,done=false,index=cards.indexOf(section);const placeholder=el('div',{class:'overview-placeholder',style:{height:start.height+'px',width:start.width+'px',flex:'0 0 '+start.width+'px'}});
  try{target.setPointerCapture(e.pointerId);}catch{}
  const apply=()=>{frame=0;if(!moved){if(Math.hypot(x-origin.x,y-origin.y)<5)return;moved=true;this.reordering=true;grid.classList.add('is-reordering');section.dataset.suppressClick='true';grid.insertBefore(placeholder,section);section.classList.add('is-reordering');Object.assign(section.style,{position:'absolute',left:start.x-overlayBounds.x+'px',top:start.y-overlayBounds.y+'px',width:start.width+'px',height:start.height+'px',margin:'0'});}
   section.style.transform=`translate3d(${x-origin.x}px,${y-origin.y}px,0) scale(1.025)`;
   const scroll=x<gridBounds.left+50?-16:x>gridBounds.right-50?16:0;if(scroll&&!done){grid.scrollLeft+=scroll;if(!frame)frame=requestAnimationFrame(apply);}const offset=grid.scrollLeft-initialScroll;const next=slots.reduce((best,r,i)=>Math.abs(x-(r.x+r.width/2-offset))<Math.abs(x-(slots[best].x+slots[best].width/2-offset))?i:best,0);
   if(next===index)return;index=next;const others=cards.filter(n=>n!==section),before=others.map(n=>n.getBoundingClientRect());grid.insertBefore(placeholder,others[next]||null);
   for(const [i,node]of others.entries()){const after=node.getBoundingClientRect(),dx=before[i].x-after.x,dy=before[i].y-after.y;if((dx||dy)&&!matchMedia('(prefers-reduced-motion: reduce)').matches)node.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});}
  };
  const move=(ev:PointerEvent)=>{x=ev.clientX;y=ev.clientY;if(!frame)frame=requestAnimationFrame(apply);};
  const end=(event:Event)=>{if(done)return;done=true;stopTracking();if(event instanceof MouseEvent&&event.type!=='pointercancel'){x=event.clientX;y=event.clientY;}target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);target.removeEventListener('lostpointercapture',end);removeEventListener('keydown',escape,true);if(frame)cancelAnimationFrame(frame);if(frame||event instanceof MouseEvent)apply();if(target.hasPointerCapture(e.pointerId))target.releasePointerCapture(e.pointerId);if(!moved){this.reordering=false;return;}
   const cancelled=event.type==='pointercancel'||event.type==='keydown',destination=placeholder.getBoundingClientRect();
   const finish=()=>{placeholder.replaceWith(section);section.style.cssText='';section.classList.remove('is-reordering');setTimeout(()=>delete section.dataset.suppressClick,0);this.reordering=false;grid.classList.remove('is-reordering');if(!cancelled)this.compositor.reorderWorkspace(id,index);this.signature='';this.refresh();};
   if(cancelled||matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
   section.animate([{transform:section.style.transform},{transform:`translate3d(${destination.x-start.x}px,${destination.y-start.y}px,0) scale(1)`}],{duration:140,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'}).finished.then(finish,finish);
  };
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();end(event);}};addEventListener('keydown',escape,true);stopTracking=trackPointer(e,move,end,target);
 }

}
