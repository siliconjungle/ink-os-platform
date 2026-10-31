import type { Route } from './types';
export interface Rect { x: number; y: number; width: number; height: number }
export interface Area { width: number; height: number; x?:number;y?:number;zoom?:number;infinite?:boolean }
export interface DeskWindow extends Rect { key: string; route: Route; appId?:string; workspace: number; z: number; minimized: boolean; maximized: boolean; restore?: Rect; prompt?: string; selected?: string[] }
export const bounds = (w: Rect): Rect => ({ x:w.x,y:w.y,width:w.width,height:w.height });
export function fit(rect: Rect, area: Area): Rect {
  if(area.infinite)return{x:rect.x,y:rect.y,width:Math.max(340,Math.min(8192,rect.width)),height:Math.max(230,Math.min(8192,rect.height))};
  const width=Math.max(Math.min(340,area.width),Math.min(rect.width,area.width));
  const height=Math.max(Math.min(230,area.height),Math.min(rect.height,area.height));
  return {width,height,x:Math.max(0,Math.min(rect.x,area.width-width)),y:Math.max(0,Math.min(rect.y,area.height-height))};
}
/** Preserve authored window size and placement while keeping its title bar reachable. */
export function visibleWindowRect(rect:Rect,area:Area):Rect{
 const result=fit(rect,{...area,infinite:true});if(area.infinite)return result;const visible=Math.min(160,area.width,result.width);return{...result,x:Math.max(visible-result.width,Math.min(rect.x,area.width-visible)),y:Math.max(0,Math.min(rect.y,area.height-Math.min(36,area.height)))};
}
/** Reproject a held window through the current desktop without changing its scale. */
export function moveWithGrab(rect:Rect,grab:{x:number;y:number},pointer:{x:number;y:number},area:Area,stage:{left:number;top:number}):Rect{
 const zoom=area.zoom||1;return{...rect,x:(area.x||0)+(pointer.x-stage.left)/zoom-grab.x,y:(area.y||0)+(pointer.y-stage.top)/zoom-grab.y};
}
export function resize(rect: Rect, edge: string, dx: number, dy: number, area: Area): Rect {
  if(area.infinite){let{x,y,width,height}=rect;if(edge.includes('e'))width=Math.max(340,Math.min(8192,width+dx));if(edge.includes('s'))height=Math.max(230,Math.min(8192,height+dy));if(edge.includes('w')){const next=Math.min(x+dx,x+width-340);width+=x-next;x=next;}if(edge.includes('n')){const next=Math.min(y+dy,y+height-230);height+=y-next;y=next;}return{x,y,width,height};}
  let {x,y,width,height}=rect; const minW=Math.min(340,area.width), minH=Math.min(230,area.height);
  if(edge.includes('e')) width=Math.max(minW,Math.min(area.width-x,width+dx));
  if(edge.includes('s')) height=Math.max(minH,Math.min(area.height-y,height+dy));
  if(edge.includes('w')) {const next=Math.max(0,Math.min(x+dx,x+width-minW));width+=x-next;x=next;}
  if(edge.includes('n')) {const next=Math.max(0,Math.min(y+dy,y+height-minH));height+=y-next;y=next;}
  return {x,y,width,height};
}
export function snapRect(side: string, area: Area): Rect {
  if(area.infinite){const half=(area.width-12)/2,x=area.x||0,y=area.y||0;return side==='left'?{x:x+6,y:y+6,width:half-3,height:area.height-12}:side==='right'?{x:x+half+9,y:y+6,width:area.width-half-15,height:area.height-12}:{x,y,width:area.width,height:area.height};}
  const half=Math.floor((area.width-12)/2);
  return side==='left'?{x:6,y:6,width:half-3,height:area.height-12}:side==='right'?{x:half+9,y:6,width:area.width-half-15,height:area.height-12}:{x:0,y:0,width:area.width,height:area.height};
}
export function toggleMax(w: DeskWindow, area: Area): DeskWindow {
  return w.maximized ? {...w,...visibleWindowRect(w.restore||w,area),maximized:false,restore:undefined} : {...w,restore:bounds(w),maximized:true,minimized:false};
}
export function validWindows(value: unknown): value is DeskWindow[] {
  return Array.isArray(value)&&value.length<=40&&value.every(w=>w&&typeof w.key==='string'&&typeof w.route?.app==='string'&&(w.appId?/^[a-z][a-z0-9.-]{0,63}$/.test(w.route.app):['explore','notes','board','studio','run','object','info','assistant','settings','activity','space','view','os-file'].includes(w.route.app))&&[w.x,w.y,w.width,w.height,w.z,w.workspace].every(Number.isFinite)&&w.width>0&&w.height>0&&Number.isSafeInteger(w.workspace)&&w.workspace>=0);
}
