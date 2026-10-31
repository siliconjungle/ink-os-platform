export const PROTOCOL=1;
export function frameMessageAllowed(message:any,origin:string,source:unknown,expectedOrigin:string,expectedSource:unknown){return source===expectedSource&&origin===expectedOrigin&&message?.source==='ink-app'&&message?.version===PROTOCOL;}
export function routeAllowed(path:string,method:string,capabilities:string[]){
 const read=capabilities.includes('world.read'),write=capabilities.includes('world.write');
 if(read&&method==='GET'&&(path==='/world'||/^\/objects\/[a-f0-9]{32}(\/revisions)?$/.test(path)))return true;
 if(read&&method==='POST'&&path==='/search')return true;
 if(write&&method==='POST'&&path==='/objects')return true;
 if(write&&method==='PATCH'&&/^\/objects\/[a-f0-9]{32}$/.test(path))return true;
 if(capabilities.includes('code.execute')&&((method==='POST'&&path==='/code/run')||(method==='GET'&&path==='/code/world')))return true;
 return false;
}
