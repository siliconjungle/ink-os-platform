export function textDiff(before:string,after:string):{index:number;remove:number;text:string};
export function moveTextOffset(offset:number,edit:{index:number;remove:number;text:string}):number;
export function textInputEdit(before:string,after:string,start:number,end:number,inputType:string):{index:number;remove:number;text:string}|null;
