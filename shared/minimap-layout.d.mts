export interface MapRect{x:number;y:number;width:number;height:number}
export interface MapScene{rects:MapRect[];view:MapRect}
export const MINIMAP_COLORS:{background:string;content:string;viewport:string;outline:string};
export function minimapLayout(rects:MapRect[],view:MapRect,width:number,height:number):{bounds:MapRect;scale:number;items:MapRect[];viewport:MapRect};
