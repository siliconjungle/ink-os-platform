export function createGestureSession(onStart:()=>void,onEnd?:()=>void):{
  feed(event:{deltaX:number;deltaY:number;deltaMode?:number;momentum?:boolean},now:number):boolean;
  dispose():void;
};
