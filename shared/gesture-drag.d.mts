export interface GestureMotion {move(distance:number):void;end(cancelled?:boolean,velocity?:number):void;}
export class GestureDrag {
 constructor(begin:(axis:'horizontal'|'vertical')=>GestureMotion|undefined,now?:()=>number);
 consuming:boolean;
 start():void;
 wheel(event:{deltaX:number;deltaY:number;deltaMode?:number;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean},eligible:boolean):boolean;
 end(cancelled?:boolean):void;
}
export function releaseTarget(position:number,velocity?:number,min?:number,max?:number):number;
