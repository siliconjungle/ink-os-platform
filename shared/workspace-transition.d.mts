export class WorkspaceTransition {
  constructor(document:Document, reducedMotion?:()=>boolean);
  finish():void;
  run(direction:number, update:()=>void):Promise<void>;
}
