import type {Area,Rect} from './window-model';
import{placementPoint,ICON_WIDTH,ICON_HEIGHT}from'../shared/desktop-coordinates.mjs';
export interface Point{x:number;y:number;relative?:true}
export function iconRect(index:number,area:Area,position?:Point):Rect{
 const width=ICON_WIDTH,height=ICON_HEIGHT,rows=Math.max(1,Math.floor((area.height-146)/94));
 const p=position||{x:18+Math.floor(index/rows)*104,y:54+index%rows*94};
 if(area.infinite)return{x:p.x,y:p.y,width,height};
 return{...placementPoint(p,area),width,height};
}
export function intersects(a:Rect,b:Rect){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
export function groupDelta(rects:Rect[],dx:number,dy:number,area:Area):Point{
 if(!rects.length)return{x:0,y:0};if(area.infinite)return{x:dx,y:dy};
 return{x:Math.max(-Math.min(...rects.map(r=>r.x)),Math.min(dx,area.width-Math.max(...rects.map(r=>r.x+r.width)))),y:Math.max(-Math.min(...rects.map(r=>r.y)),Math.min(dy,area.height-Math.max(...rects.map(r=>r.y+r.height))))};
}

/** Pick an unoccupied visible slot for shortcuts added without a drop point. */
export function freeIconPosition(area:Area,positions:Point[]):Point{
 const occupied=positions.map(point=>iconRect(0,area,point)),rows=Math.max(1,Math.floor((area.height-146)/94)),columns=Math.max(1,Math.floor((area.width-18)/104));let candidate=iconRect(0,area);
 for(let index=0;index<rows*columns;index++){candidate=iconRect(index,area);if(!occupied.some(rect=>intersects(candidate,rect)))return{x:candidate.x,y:candidate.y};}
 return{x:candidate.x,y:candidate.y};
}
