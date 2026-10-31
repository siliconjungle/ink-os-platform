export const ICON_WIDTH:88,ICON_HEIGHT:80;
export interface DesktopPoint{x:number;y:number;relative?:true}
export function placementPoint(point:DesktopPoint,area:{width:number;height:number}):{x:number;y:number};
export function relativePlacement(point:DesktopPoint,area:{width:number;height:number}):DesktopPoint;
