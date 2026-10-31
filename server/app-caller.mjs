import {createHash} from 'node:crypto';
import {sign,verify} from './platform.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const methodOf=input=>String(input.method||'GET').toUpperCase();
const pathOf=path=>{if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))fail(400,'Invalid app request path');const url=new URL(path,'https://app.invalid');return url.pathname+url.search;};
function cleanBody(body){if(body===undefined)return undefined;if(!body||typeof body!=='object'||Array.isArray(body))return body;const {__inkCaller,...rest}=body;return rest;}
const digest=body=>createHash('sha256').update(JSON.stringify(body)??'undefined').digest('hex');
// Only OS-authenticated human requests receive an assertion. App/runtime requests cannot mint one.
export function withAppCaller(platform,principal,appId,input){
 const body=cleanBody(input.body),result={...input,body};
 if(!principal?.owner||!principal.accountId||!body||typeof body!=='object'||Array.isArray(body)||['GET','HEAD'].includes(methodOf(input)))return result;
 const assertion=sign({kind:'app-caller',appId,accountId:principal.accountId,...(input.sourceAppId?{sourceAppId:input.sourceAppId}:{}),...(/^[a-f0-9-]{36}$/.test(input.uiClientId||'')?{uiClientId:input.uiClientId}:{}),...(principal.keyId?{keyId:principal.keyId}:{}),path:pathOf(input.path),method:methodOf(input),digest:digest(body),exp:Date.now()+60000},platform.adminToken);
 return {...result,body:{...body,__inkCaller:assertion}};
}
export function withAppServiceCaller(platform,principal,appId,input){
 if(!principal?.appId||principal.owner)fail(403,'An application identity is required');const source=platform.app(principal.appId),meta=JSON.parse(source.body);if(!meta.capabilities?.includes('apps.invoke')||!meta.releaseId||principal.releaseId&&principal.releaseId!==meta.releaseId)fail(403,'The calling app is not authorized');const body=cleanBody(input.body);if(['GET','HEAD'].includes(methodOf(input)))return{...input,body};if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'App API writes require a JSON object');
 const assertion=sign({kind:'app-service-caller',appId,sourceAppId:source.id,sourceReleaseId:meta.releaseId,path:pathOf(input.path),method:methodOf(input),digest:digest(body),exp:Date.now()+60000},platform.adminToken);return{...input,body:{...body,__inkCaller:assertion}};
}
export function appCaller(platform,principal,appId,input){
 if(!principal||principal.owner||principal.appId!==appId)fail(403,'Only this application can verify its caller');
 const claim=verify(input?.assertion,platform.adminToken);
 if(!claim||!['app-caller','app-service-caller'].includes(claim.kind)||claim.appId!==appId||claim.path!==pathOf(input.path)||claim.method!==methodOf(input)||claim.digest!==digest(cleanBody(input.body)))fail(401,'A verified Ink caller is required');
 if(claim.kind==='app-service-caller'){let source;try{source=platform.app(claim.sourceAppId);}catch{fail(401,'Calling app is unavailable');}const meta=JSON.parse(source.body);if(meta.releaseId!==claim.sourceReleaseId||!meta.capabilities?.includes('apps.invoke'))fail(401,'Calling app access changed');return{type:'app',appId:source.id,name:source.title};}
 const account=platform.apiKeys.account(claim.accountId);if(!account||account.disabledAt)fail(401,'Account access is disabled');
 if(claim.keyId){const key=platform.apiKeys.principal(claim.keyId);if(!key||key.accountId!==claim.accountId||!key.scopes.some(scope=>scope==='computer'||scope==='apps:invoke'))fail(401,'Account key access is no longer valid');}
 return {accountId:account.id,name:account.name,admin:account.role==='admin',...(claim.sourceAppId?{sourceAppId:claim.sourceAppId}:{}),...(claim.uiClientId?{uiClientId:claim.uiClientId}:{})};
}
