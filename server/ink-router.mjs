export async function inkRoute(platform,req,res,url,principal,{send,body}){
 const path=url.pathname.slice('/api/v1'.length);if(!path.startsWith('/ink/previews'))return false;
 const service=platform.inkPreviews;if(!service)throw Object.assign(Error('Ink previews unavailable'),{status:503});
 if(path==='/ink/previews'&&req.method==='POST'){send(res,201,await service.create(principal,await body(req,34*1024*1024)));return true;}
 const ui=path.match(/^\/ink\/previews\/([a-f0-9]{32})\/ui(?:\/([a-f0-9]{32})(?:\/(refresh|event))?)?$/);if(ui){const[,previewId,id,action]=ui;service.get(previewId,principal);const views=platform.inkViews;if(!views)throw Object.assign(Error('UI views unavailable'),{status:503});if(!id&&req.method==='POST'){send(res,201,await views.openPreview(previewId,principal,await body(req)));return true;}const mount=views.get(id,principal);if(mount.previewId!==previewId)throw Object.assign(Error('Wrong preview interface'),{status:403});if(action==='refresh'&&req.method==='POST')send(res,200,await views.refresh(id,principal,await body(req)));else if(action==='event'&&req.method==='POST')send(res,200,await views.event(id,principal,await body(req,128*1024)));else if(!action&&req.method==='DELETE')send(res,200,await views.dispose(id,principal));else throw Object.assign(Error('Unsupported UI operation'),{status:405});return true;}
 const match=/^\/ink\/previews\/([a-f0-9]{32})(?:\/(run|view))?$/.exec(path);if(!match)throw Object.assign(Error('Unknown Ink preview operation'),{status:404});const[,id,action]=match;
 if(!action&&req.method==='GET')send(res,200,await service.inspect(id,principal));
 else if(!action&&req.method==='DELETE')send(res,200,await service.remove(id,principal));
 else if(action==='run'&&req.method==='POST')send(res,200,await service.run(id,principal,await body(req,128*1024)));
 else if(action==='view'&&req.method==='GET'){const page=await service.view(id,principal);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':page.csp,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(page.html);}
 else throw Object.assign(Error('Unknown Ink preview operation'),{status:405});return true;
}
