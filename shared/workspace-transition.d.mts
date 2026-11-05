export class WorkspaceTransition {
  constructor(document:Document, reducedMotion?:()=>boolean);
  finish():void;
  scrub(direction:number,prepare:()=>void,settled:(accept:boolean,prepared:boolean)=>void):{move(progress:number):void;end(cancelled?:boolean,velocity?:number):void;cancel():void};
  run(direction:number|'overview-in'|'overview-out', update:()=>void, cleanup?:()=>void):Promise<void>;
}
