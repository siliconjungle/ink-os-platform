import { isAdmin } from './api-keys.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export async function automationMigrationRoute(platform,req,res,url,principal,{send,body}){
 const path=url.pathname.slice('/api/v1'.length);if(!path.startsWith('/migrations/automation'))return false;
 if(!isAdmin(principal))fail(403,'Only the administrator can migrate automation stores');
 const engine=platform.automationMigrations;if(!engine)fail(503,'Automation migrations are unavailable');
 const receipt=/^\/migrations\/automation\/([a-f0-9]{32})$/.exec(path);
 if(receipt&&req.method==='GET'){send(res,200,engine.get(principal,receipt[1]));return true;}
 const match=/^\/migrations\/automation\/(plan|apply|schedule-preview|schedule-review)$/.exec(path);
 if(!match||req.method!=='POST')fail(404,'Unknown automation migration operation');
 const action=({'schedule-preview':'previewScheduleReview','schedule-review':'reviewSchedule'})[match[1]]||match[1];
 send(res,200,await engine[action](principal,await body(req,match[1]==='plan'||match[1]==='apply'?48*1024*1024:65536)));return true;
}
