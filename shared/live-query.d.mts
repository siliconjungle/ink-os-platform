export interface QueryResult {objects:any[];version?:number;[key:string]:any}
export function watchQuery<T> (options:{read:(options:{signal:AbortSignal})=>Promise<T>;subscribe:(invalidate:(event?:any)=>void)=>(()=>void)|void;onResult:(result:T)=>void;onError?:(error:Error)=>void;signal?:AbortSignal;delay?:number;relevant?:(event:any)=>boolean}):{ready:Promise<T>;unsubscribe:()=>void;refresh:()=>void};
export function queryInvalidator(query?:any):{accept:(result:QueryResult)=>void;relevant:(event:any)=>boolean};
