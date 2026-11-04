export class WorkspaceTransition {
  constructor(document:Document, reducedMotion?:()=>boolean);
  finish():void;
  run(direction:number|'overview-in'|'overview-out', update:()=>void, cleanup?:()=>void):Promise<void>;
}
