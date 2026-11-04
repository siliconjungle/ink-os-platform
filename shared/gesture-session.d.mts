export function createGestureSession(onStart:()=>void):{
  feed(event:{deltaX:number;deltaY:number;deltaMode?:number;momentum?:boolean},now:number):void;
  dispose():void;
};
