export type MenuItem=[string,()=>void,boolean?];
export function frameContextMenu(message:any,select:(value:{menuId:string;id:string})=>void):MenuItem[]|undefined;
export function appContentActions(context:{items?:MenuItem[];editable?:boolean;selection?:string;edit?:(action:string)=>void}):MenuItem[];
