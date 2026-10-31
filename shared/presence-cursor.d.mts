export interface PresenceCursor{x:number;y:number;space?:'desktop'}
export function presenceCursor(value:unknown):PresenceCursor|null;
export function cursorScreenPoint(value:PresenceCursor,{left,top,width,height}:{left?:number;top?:number;width:number;height:number}):{x:number;y:number}|null;
