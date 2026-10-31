export const ICON_WIDTH=88,ICON_HEIGHT=80;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const extent=(value,size)=>Math.max(0,value-size);
export function placementPoint(point,area){
 const width=Math.max(1,area.width),height=Math.max(1,area.height);
 return{x:clamp(point.relative===true?point.x*width-ICON_WIDTH/2:point.x,0,extent(width,ICON_WIDTH)),y:clamp(point.relative===true?point.y*height-ICON_HEIGHT/2:point.y,0,extent(height,ICON_HEIGHT))};
}
export function relativePlacement(point,area){
 if(point.relative===true)return{x:clamp(point.x,0,1),y:clamp(point.y,0,1),relative:true};
 const pixel=placementPoint(point,area),width=Math.max(1,area.width),height=Math.max(1,area.height);
 return{x:clamp((pixel.x+Math.min(ICON_WIDTH,width)/2)/width,0,1),y:clamp((pixel.y+Math.min(ICON_HEIGHT,height)/2)/height,0,1),relative:true};
}
