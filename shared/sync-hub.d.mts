export class SyncHub{
 constructor(url:string,options?:{WebSocket?:typeof WebSocket;retryMs?:number;heartbeatMs?:number;pingTimeoutMs?:number;requestTimeoutMs?:number;connectTimeoutMs?:number;lifecycleTarget?:EventTarget;visibilityTarget?:EventTarget&{visibilityState?:string}});
 wake():Promise<void>;
 request(message:any):Promise<any>;
 subscribe(namespace:string,key:string,kind:string,listener:(message:any)=>void):{ready:Promise<any>;unsubscribe:()=>void};
 close():void;
}
