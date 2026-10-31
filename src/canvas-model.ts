import type{Rect,Area}from'./window-model';
export interface Camera{x:number;y:number;z:number}
export const MIN_ZOOM=.05,MAX_ZOOM=4;
export const zoomClamp=(z:number)=>Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,z));
export const toWorld=(p:{x:number;y:number},c:Camera)=>({x:c.x+p.x/c.z,y:c.y+p.y/c.z});
export const toScreen=(p:{x:number;y:number},c:Camera)=>({x:(p.x-c.x)*c.z,y:(p.y-c.y)*c.z});
export function zoomAt(c:Camera,z:number,p:{x:number;y:number}):Camera{const world=toWorld(p,c),next=zoomClamp(z);return{x:world.x-p.x/next,y:world.y-p.y/next,z:next};}
export const viewport=(c:Camera,area:Area):Rect=>({x:c.x,y:c.y,width:area.width/c.z,height:area.height/c.z});
export function union(rects:Rect[]):Rect|undefined{if(!rects.length)return;const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));return{x,y,width:Math.max(...rects.map(r=>r.x+r.width))-x,height:Math.max(...rects.map(r=>r.y+r.height))-y};}
export function fitCamera(rect:Rect,area:Area,padding=80):Camera{const z=zoomClamp(Math.min((area.width-padding*2)/Math.max(rect.width,1),(area.height-padding*2)/Math.max(rect.height,1),1));return{x:rect.x+rect.width/2-area.width/z/2,y:rect.y+rect.height/2-area.height/z/2,z};}
export function focusCamera(rect:Rect,area:Area,padding=80):Camera{const z=zoomClamp(Math.min((area.width-padding*2)/Math.max(rect.width,1),(area.height-padding*2)/Math.max(rect.height,1)));return{x:rect.x+rect.width/2-area.width/z/2,y:rect.y+rect.height/2-area.height/z/2,z};}
export const overlaps=(a:Rect,b:Rect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
export function contentVisible(rects:Rect[],view:Rect,z:number){return rects.some(r=>overlaps(r,view)&&Math.min(r.width*z,r.height*z)>=12);}
