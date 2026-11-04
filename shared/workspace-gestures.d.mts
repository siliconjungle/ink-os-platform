export function adjacentWorkspace(workspaces:{id:number}[], current:number, step:number):number|undefined;
export class WorkspaceSwipe {
  constructor(options?:{threshold?:number;idleMs?:number});
  reset():void;
  wheel(event:{deltaX:number;deltaY:number;deltaMode?:number;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean}, now:number):{consume:boolean;step:number};
}
