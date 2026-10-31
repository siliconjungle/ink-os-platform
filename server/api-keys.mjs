import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
export const KEY_SCOPES=['apps:read','apps:deploy','apps:invoke','apps:credentials','apps:environment','world:read','world:write','computer','keys:manage','accounts:manage'];
export const MEMBER_SCOPES=KEY_SCOPES.filter(scope=>scope!=='accounts:manage');
const DEFAULT_SCOPES=['apps:read','apps:deploy','apps:invoke','world:read','world:write','computer'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const owner=()=>({id:'owner',name:'Admin',role:'admin',scopes:[...KEY_SCOPES],createdAt:0,disabledAt:null});
function scopesOf(scopes,allowed=KEY_SCOPES){if(!Array.isArray(scopes)||!scopes.length||scopes.some(s=>!allowed.includes(s)))fail(400,'Invalid permissions');return [...new Set(scopes)];}
function memberScopes(scopes){if(!Array.isArray(scopes))fail(400,'Invalid permissions');return scopesOf([...scopes,'keys:manage'],MEMBER_SCOPES);}
function named(name){if(typeof name!=='string'||!name.trim()||name.length>100)fail(400,'Enter a name (up to 100 characters)');return name.trim();}
function issue(input,accountId){const name=named(input.name),scopes=scopesOf(input.scopes??DEFAULT_SCOPES),days=input.expiresInDays??90;if(!Number.isFinite(days)||days<1||days>365)fail(400,'Expiry must be 1–365 days');const token='ink_os_'+randomBytes(32).toString('base64url');return {token,key:{id:randomBytes(12).toString('hex'),accountId,name,prefix:token.slice(0,15),hash:digest(token),scopes,createdAt:Date.now(),expiresAt:Date.now()+days*86400000,revokedAt:null}};}
export class APIKeys{
 constructor(directory){this.path=join(directory,'account-keys.json');this.keys=[];this.accounts=[owner()];this.tail=Promise.resolve();}
 async open(){try{const stored=JSON.parse(await readFile(this.path,'utf8'));if(Array.isArray(stored)){this.keys=stored;}else if(stored.version===2&&Array.isArray(stored.keys)&&Array.isArray(stored.accounts)){this.keys=stored.keys;this.accounts=[owner(),...stored.accounts.filter(a=>a.id!=='owner')];}else throw Error('Invalid account key store');}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
 // Publish in-memory state only after the complete account/key transaction is durable.
 mutate(change){const task=this.tail.then(async()=>{const draft=structuredClone({keys:this.keys,accounts:this.accounts}),result=change(draft);await writeFile(this.path+'.next',JSON.stringify({version:2,...draft}),{mode:0o600,flush:true});await rename(this.path+'.next',this.path);this.keys=draft.keys;this.accounts=draft.accounts;return result;});this.tail=task.catch(()=>{});return task;}
 public(key){const {hash,...record}=key;return record;}
 account(id){return this.accounts.find(a=>a.id===id);}
 listAccounts(){return structuredClone(this.accounts);}
 list(accountId='owner'){return this.keys.filter(k=>k.accountId===accountId).map(k=>this.public(k));}
 create(input={},accountId='owner',ceiling){return this.mutate(draft=>{const account=draft.accounts.find(a=>a.id===accountId);if(!account||account.disabledAt)fail(403,'Account access is disabled');const issued=issue(input,accountId);if(issued.key.scopes.some(scope=>!account.scopes.includes(scope)||ceiling&&!ceiling.includes(scope)))fail(403,'A key cannot exceed the permissions granted to its account or creator');draft.keys.push(issued.key);return {...this.public(issued.key),token:issued.token};});}
 createAccount(input){return this.mutate(draft=>{const name=named(input.name),scopes=memberScopes(input.scopes??DEFAULT_SCOPES),account={id:randomBytes(12).toString('hex'),name,role:'member',scopes,createdAt:Date.now(),disabledAt:null};const issued=issue({name:name.slice(0,92)+' sign-in',scopes,expiresInDays:input.expiresInDays},account.id);draft.accounts.push(account);draft.keys.push(issued.key);return {account,key:{...this.public(issued.key),token:issued.token}};});}
 updateAccount(id,input){return this.mutate(draft=>{const account=draft.accounts.find(a=>a.id===id);if(!account)fail(404,'Account not found');if(account.role==='admin')fail(403,'The admin account cannot be changed here');if(input.name!==undefined)account.name=named(input.name);if(input.scopes!==undefined)account.scopes=memberScopes(input.scopes);if(input.disabled!==undefined){if(typeof input.disabled!=='boolean')fail(400,'Invalid access setting');account.disabledAt=input.disabled?(account.disabledAt||Date.now()):null;}return {...account};});}
 find(id){const key=this.keys.find(k=>k.id===id),account=key&&this.account(key.accountId);return key&&!key.revokedAt&&key.expiresAt>Date.now()&&account&&!account.disabledAt?key:null;}
 authenticate(token){if(typeof token!=='string'||!token.startsWith('ink_os_'))return null;const hash=digest(token);const key=this.keys.find(k=>typeof k.hash==='string'&&k.hash.length===hash.length&&timingSafeEqual(Buffer.from(k.hash),Buffer.from(hash)));return key?this.principal(key.id):null;}
 principal(id){const key=this.find(id);if(!key)return null;const account=this.account(key.accountId);return {owner:true,admin:account.role==='admin',accountId:key.accountId,accountName:account.name,keyId:key.id,namespace:'os',scopes:key.scopes.filter(scope=>account.scopes.includes(scope))};}
 revoke(id,accountId='owner'){return this.mutate(draft=>{const key=draft.keys.find(k=>k.id===id&&k.accountId===accountId);if(!key)fail(404,'API key not found');key.revokedAt=key.revokedAt||Date.now();return this.public(key);});}
 rotate(id,accountId='owner',ceiling){return this.mutate(draft=>{const account=draft.accounts.find(a=>a.id===accountId),old=draft.keys.find(k=>k.id===id&&k.accountId===accountId);if(!old)fail(404,'API key not found');if(!account||account.disabledAt||old.revokedAt||old.expiresAt<=Date.now())fail(409,'Only an active key can be rotated');const scopes=old.scopes.filter(scope=>account.scopes.includes(scope));if(ceiling&&scopes.some(scope=>!ceiling.includes(scope)))fail(403,'Cannot rotate a key with greater permissions');const issued=issue({name:old.name,scopes,expiresInDays:1},accountId);issued.key.expiresAt=old.expiresAt;old.revokedAt=Date.now();old.replacedBy=issued.key.id;draft.keys.push(issued.key);return {...this.public(issued.key),token:issued.token};});}
}
export function requireScope(principal,scope){if(!principal)fail(401,'Authentication required');if(principal.keyId&&!principal.scopes.includes(scope))fail(403,'API key requires '+scope);}
export function isAdmin(principal){return principal?.owner&&principal.accountId==='owner'&&(!principal.keyId||principal.scopes.includes('accounts:manage'));}
export function routeScope(path,method){
 if(path.startsWith('/workflows/'))return /\/(list|get|runs)$/.test(path)?'world:read':/\/(save|archive)$/.test(path)?'world:write':'apps:invoke';
 if(path.startsWith('/commands'))return path==='/commands/query'?'apps:read':'apps:invoke';
 if(path.startsWith('/desktop/'))return'computer';
 if(path.startsWith('/calls/'))return'computer';
 if(path.startsWith('/accounts'))return 'accounts:manage';
 if(path.startsWith('/projects'))return /\/credentials$/.test(path)?'apps:credentials':method==='GET'?'apps:read':'apps:deploy';
 if(path==='/native')return 'apps:read';
 if(path.startsWith('/runtimes'))return method==='GET'?'apps:read':'apps:deploy';
 if(path.startsWith('/keys'))return 'keys:manage';
 if(path.startsWith('/computer'))return 'computer';
 if(path==='/ink/previews'||path.startsWith('/ink/previews/'))return 'apps:deploy';
 if(path==='/me')return null;
 if(path==='/query')return 'world:read';
 if(path==='/schedules'||/\/schedules(?:\/|$)/.test(path))return method==='GET'?'apps:read':'apps:invoke';
 if(path.startsWith('/apps')){if(/\/env(?:\/|$)/.test(path))return 'apps:environment';if(path.endsWith('/token'))return 'apps:credentials';if(path.endsWith('/invoke')||path.endsWith('/call')||path.endsWith('/ink/run')||path.endsWith('/code/run'))return 'apps:invoke';if(/\/data(?:\/|$)/.test(path))return ['GET','HEAD'].includes(method)?'world:read':'world:write';return method==='GET'||path.endsWith('/launch')?'apps:read':'apps:deploy';}
 return ['GET','HEAD'].includes(method)?'world:read':'world:write';
}
export function authorizeRoute(principal,path,method){const scope=routeScope(path,method);if(scope&&principal.keyId){if(principal.scopes.includes('computer')&&!['accounts:manage','keys:manage','apps:credentials','apps:environment'].includes(scope))return;requireScope(principal,scope);}}
