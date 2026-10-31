export interface Workspace {id:number;name:string}
export function validWorkspaces(value:unknown):value is Workspace[]{
 return Array.isArray(value)&&value.length>0&&value.length<=1000&&value.every(w=>w&&Number.isSafeInteger(w.id)&&w.id>=0&&typeof w.name==='string'&&w.name.trim().length>0&&w.name.length<=80)&&new Set(value.map(w=>w.id)).size===value.length;
}
export function sessionWorkspaces(session:{workspaces?:unknown;windows:{workspace:number}[];workspace?:number}):Workspace[]{
 if(validWorkspaces(session.workspaces))return session.workspaces.map(w=>({...w}));
 // Old sessions implicitly had two desktops. Retain occupied ones, not the unused default.
 const ids=[...new Set([0,...session.windows.map(w=>w.workspace),...(session.workspace?[session.workspace]:[])])].sort((a,b)=>a-b);
 return ids.map(id=>({id,name:'Desktop '+(id+1)}));
}
export function reorderWorkspace(workspaces:Workspace[],id:number,index:number):Workspace[]{
 const from=workspaces.findIndex(w=>w.id===id);if(from<0)return workspaces;
 const next=[...workspaces],item=next.splice(from,1)[0];next.splice(Math.max(0,Math.min(next.length,index)),0,item);return next;
}
export function removalTarget(workspaces:Workspace[],id:number):number|undefined{
 const index=workspaces.findIndex(w=>w.id===id);return index<0||workspaces.length<2?undefined:workspaces[index===0?1:index-1].id;
}
