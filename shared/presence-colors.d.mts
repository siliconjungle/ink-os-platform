export const PRESENCE_COLORS:readonly string[];
export const PRESENCE_INK:string;
export function presenceColor(id:string,peers?:Array<{id:string;color?:string}>):string;
export function peerColor(peer:{id:string;color?:string}):string;
export function cursorLabel(x:number,y:number,textWidth:number,width:number,height:number):{width:number;x:number;y:number;side:string};
