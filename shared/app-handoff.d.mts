export interface AppHandoff{id:string;source:{appId:string;title:string};data:unknown}
export function appHandoff(source:{id:string;title:string},data:unknown,id?:string):AppHandoff|undefined;
