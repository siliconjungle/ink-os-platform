import{validateAppAPI,matchesAppAPI}from'../shared/app-api.mjs';import{withAppCaller,withAppServiceCaller}from'./app-caller.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function appAPI(platform,appId){const app=platform.app(appId),releaseId=JSON.parse(app.body).releaseId,release=releaseId&&platform.world.get(releaseId),meta=release&&JSON.parse(release.body);return{appId,title:app.title,releaseId:releaseId||null,routes:validateAppAPI(meta?.backend?.api)||[]};}
export async function callAppAPI(platform,principal,appId,input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Provide an app API request');
 const api=appAPI(platform,appId),method=String(input.method||'GET').toUpperCase();if(typeof input.path!=='string'||!input.path.startsWith('/')||input.path.startsWith('//')||input.path.includes('\\')||input.path.includes('#'))fail(400,'Use a backend-relative app API path');const url=new URL(input.path,'https://app.invalid');if(!matchesAppAPI(api.routes,url.pathname,method))fail(403,'This route is not exported by the app');if(Buffer.byteLength(JSON.stringify(input.body)??'')>65536)fail(413,'App API input exceeds 64 KiB');
 const sourceAppId=principal.owner?input.sourceAppId:principal.appId;
 if(sourceAppId){const source=platform.app(sourceAppId),meta=JSON.parse(source.body);if(!meta.releaseId||!meta.capabilities?.includes('apps.invoke'))fail(403,'The calling app must declare apps.invoke');}
 const request={path:url.pathname+url.search,method,body:input.body,releaseId:api.releaseId};
 return platform.invoke(appId,principal.owner?withAppCaller(platform,principal,appId,{...request,...(sourceAppId?{sourceAppId}:{}),...(input.uiClientId?{uiClientId:input.uiClientId}:{})}):withAppServiceCaller(platform,principal,appId,request));
}
