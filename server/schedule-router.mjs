export async function scheduleRoute(platform,req,res,url,principal,{send,body}){
 const path=url.pathname.slice('/api/v1'.length);if(path==='/schedules'&&req.method==='GET'){if(!platform.schedules)throw Object.assign(Error('Scheduler unavailable'),{status:503});send(res,200,platform.schedules.list(principal));return true;}
 const match=/^\/apps\/([a-f0-9]{32})\/schedules(?:\/([a-f0-9]{32})(?:\/(runs|run))?)?$/.exec(path);if(!match)return false;
 if(!platform.schedules)throw Object.assign(Error('Scheduler unavailable'),{status:503});const[,appId,jobId,action]=match,scheduler=platform.schedules;let result,status=200;
 if(!jobId&&req.method==='GET')result=scheduler.list(principal,appId);
 else if(!jobId&&req.method==='POST'){result=await scheduler.create(principal,appId,await body(req));status=201;}
 else if(jobId&&!action&&req.method==='GET')result=scheduler.get(principal,appId,jobId);
 else if(jobId&&!action&&req.method==='PATCH')result=await scheduler.update(principal,appId,jobId,await body(req));
 else if(jobId&&!action&&req.method==='DELETE')result=await scheduler.cancel(principal,appId,jobId);
 else if(action==='runs'&&req.method==='GET')result=scheduler.history(principal,appId,jobId);
 else if(action==='run'&&req.method==='POST'){result=await scheduler.run(principal,appId,jobId);status=202;}
 else throw Object.assign(Error('Unsupported scheduled-job operation'),{status:405});send(res,status,result);return true;
}
