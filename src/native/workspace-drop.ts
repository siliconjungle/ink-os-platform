import{fixedPreview}from './fixed-preview';
import type{WorldObject}from '../types';
import type{MapScene}from '../../shared/minimap-layout.mjs';
import type {Workspace} from '../workspace-model';import {el} from './dom';
import type {DeskWindow,Area} from '../window-model';
/** Preview hit targets stay fixed while their visual surfaces animate into place. */
export class WorkspaceDrop{
 node?:HTMLElement;targets:{left:number;right:number;top:number;bottom:number}[]=[];hover=-1;bounds?:{left:number;right:number;bottom:number;top:number};scrollFrame=0;scrollOffset=0;maxScroll=0;
 constructor(readonly windows:DeskWindow[],readonly current:number,readonly moving:string,readonly area:Area,readonly workspaces:Workspace[],readonly preview:(workspace:number)=>void=()=>{},readonly mapScene?:(workspace:number)=>MapScene,readonly desktopContent?:(workspace:number)=>{positions:Record<string,{x:number;y:number}>;get:(id?:string)=>WorldObject|undefined;title:(w:DeskWindow)=>string;glyph:(w:DeskWindow)=>any},readonly directButtons=false){}
 update(x:number,y:number){
  const atTop=y<=1;
  const switcher=document.querySelector<HTMLElement>('.workspace-switch')?.getBoundingClientRect();
  const atSwitcher=!!switcher&&switcher.width>0&&switcher.height>0&&x>=switcher.left&&x<=switcher.right&&y>=switcher.top&&y<=switcher.bottom;
  if(!this.node){if(!atTop&&!atSwitcher)return;this.show();}
  const r=this.bounds!;
  // Keep the path from the desktop buttons to the chooser open during the drag.
  const entryLeft=Math.min(r.left,switcher?.width?switcher.left:r.left),entryRight=Math.max(r.right,switcher?.width?switcher.right:r.right);
  const inside=x>=r.left&&x<=r.right&&y>=0&&y<=r.bottom||x>=entryLeft&&x<=entryRight&&y>=0&&y<r.top;
  if(!inside){this.close();return;}
  const direction=this.maxScroll>0?(x<r.left+35?-1:x>r.right-35?1:0):0;if(direction){this.scrollOffset=Math.max(0,Math.min(this.maxScroll,this.scrollOffset+direction*12));this.node!.scrollLeft=this.scrollOffset;if(!this.scrollFrame)this.scrollFrame=requestAnimationFrame(()=>{this.scrollFrame=0;if(this.node)this.update(x,y);});}
  let next=this.targets.findIndex(r=>x>=r.left-this.scrollOffset&&x<=r.right-this.scrollOffset&&y>=r.top&&y<=r.bottom);if(next<0&&atSwitcher&&this.directButtons){const buttons=[...document.querySelectorAll<HTMLElement>('.workspace-switch>button')];next=buttons.findIndex(node=>{const rect=node.getBoundingClientRect();return x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom;});if(next>=this.workspaces.length)next=-1;}if(next>=0&&next!==this.hover)this.preview(this.workspaces[next].id);this.hover=next;
  for(const[i,card]of [...this.node!.children].entries())card.classList.toggle('drop-target',i===this.hover);
 }
 show(){this.node=el('div',{class:'workspace-drop','aria-label':'Drop onto a desktop',style:{top:'45px',width:Math.min(innerWidth-32,this.workspaces.length*200+30)+'px'}});
  for(const {id:workspace,name}of this.workspaces){const content=this.desktopContent?.(workspace),card=el('div',{class:'workspace-drop-card','data-desktop':workspace},el('strong',{},name+(workspace===this.current?' · current':'')),fixedPreview(this.windows,workspace,this.area,content?.get||(()=>undefined),content?.positions||{},content?.title,content?.glyph,undefined,this.moving));this.node.append(card);}document.body.append(this.node);
  const left=this.node.offsetLeft-this.node.offsetWidth/2,top=this.node.offsetTop;this.bounds={left,right:left+this.node.offsetWidth,top,bottom:top+this.node.offsetHeight};this.maxScroll=this.node.scrollWidth-this.node.clientWidth;this.scrollOffset=0;
  this.targets=[...this.node!.children].map(n=>{const card=n as HTMLElement;return{left:left+card.offsetLeft,right:left+card.offsetLeft+card.offsetWidth,top:top+card.offsetTop,bottom:top+card.offsetTop+card.offsetHeight};});
 }
 close(){cancelAnimationFrame(this.scrollFrame);this.scrollFrame=0;const hover=this.hover;this.node?.remove();this.node=undefined;this.targets=[];this.hover=-1;return hover;}
}
