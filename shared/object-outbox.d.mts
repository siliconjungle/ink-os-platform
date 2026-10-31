export class ObjectOutbox {
 constructor(options:{send:(entry:any,revision?:number)=>Promise<any>;cache?:ObjectCache;onChange?:(id:string,object:any)=>void;onStatus?:(status:any)=>void;retryMs?:number});
 ids(namespace?:string):string[];ready:Promise<void>;base:Map<string,any>;receive(object:any):void;remove(id:string):void;create(input:any,route?:string):Promise<any>;update(id:string,changes:any,route?:string,mutationId?:string):Promise<any>;flush(id?:string):Promise<void>;retry(key:string):Promise<void>;wake():void;close():void;
}
export class ObjectCache {constructor(options?:{indexedDB?:IDBFactory;name?:string});all():Promise<any[]>;put(entry:any):Promise<any>;delete(key:string):Promise<any>;}
