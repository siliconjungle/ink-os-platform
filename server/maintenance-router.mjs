import {isAdmin} from './api-keys.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export async function maintenanceRoute(engine,req,res,url,principal,{send,body}){
 const path=url.pathname;if(!path.startsWith('/api/v1/maintenance'))return false;
 if(!isAdmin(principal))fail(403,'Only the administrator can control maintenance');
 if(path==='/api/v1/maintenance/prepare'&&req.method==='POST'){send(res,200,await engine.prepare(principal,await body(req,16384)));return true;}
 const match=/^\/api\/v1\/maintenance\/([a-f0-9]{32})(?:\/(complete|cancel|seal))?$/.exec(path);
 if(!match)fail(404,'Unknown maintenance operation');
 if(!match[2]&&req.method==='GET'){send(res,200,engine.get(principal,match[1]));return true;}
 if(match[2]&&req.method==='POST'){send(res,200,await engine[match[2]](principal,match[1],await body(req,16384)));return true;}
 fail(405,'Unsupported maintenance operation');
}
