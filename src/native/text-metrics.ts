import {prepare,measureNaturalWidth,layout,clearCache,type PreparedText} from '@chenglou/pretext';
const cache=new Map<string,PreparedText>();
export const UI_FONT='450 11px "Inter Variable"';
function prepared(text:string,font:string){const key=font+'\0'+text;let value=cache.get(key);if(!value){value=prepare(text,font);if(cache.size>=512)cache.delete(cache.keys().next().value!);cache.set(key,value);}return value;}
export function textWidth(text:string,font=UI_FONT){return measureNaturalWidth(prepared(text,font));}
export function textHeight(text:string,width:number,lineHeight:number,font=UI_FONT){return layout(prepared(text,font),Math.max(1,width),lineHeight).height;}
// Prepared fallback-font measurements must be retired when the actual face arrives.
document.fonts.addEventListener('loadingdone',()=>{clearCache();cache.clear();dispatchEvent(new Event('ink-text-metrics'));});
