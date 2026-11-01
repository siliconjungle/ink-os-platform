export interface ObjectDragStart{ids:string[];pointerId:number;pointerType:string;x:number;y:number;grabX:number;grabY:number;at:number;windowKey?:string}
export function dragObjectIds(value:unknown):string[];
export function bindObjectDrag(node:HTMLElement,options:{objects:()=>string[];begin:(start:ObjectDragStart)=>unknown;error?:(error:any)=>void}):()=>void;
