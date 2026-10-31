import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './world.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
// The host owns published code, but modules get a separate process, app-scoped
// credentials, a read-only module/SDK allowlist, and no subprocess/worker access.
export async function localAdapter(platform,{appId,releaseId,input}) {
  const bundle=await platform.bundle(releaseId);
  if(!bundle.adapter||!bundle.backend?.entry||bundle.backend.image)throw Object.assign(Error('A local adapter needs a module backend'),{status:400});
  const source=bundle.files.find(file=>file.path===bundle.backend.entry);
  if(!source)throw Error('Adapter module is missing');
  const bytes=Buffer.from(source.base64,'base64'),directory=join(platform.directory,'adapter-modules');
  await mkdir(directory,{recursive:true,mode:0o700});
  const entry=join(await realpath(directory),hash(bytes)+'.mjs');
  try{await writeFile(entry,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(!bytes.equals(await readFile(entry)))throw Error('Adapter module digest mismatch');}
  const worker=join(root,'server/local-adapter-worker.mjs');
  await platform.runtime.prepare(appId);
  const values=platform.environment?.values(appId)||{};
  const env={...values,INK_OS_URL:platform.origin,INK_OS_APP_TOKEN:platform.runtime.token(appId,releaseId),INK_OS_APP_ID:appId,INK_OS_RELEASE_ID:releaseId,INK_OS_ADAPTER_ENTRY:entry,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})};
  const args=['--permission','--allow-fs-read='+entry,'--allow-fs-read='+worker,'--allow-fs-read='+join(root,'package.json'),'--allow-fs-read='+join(root,'sdk'),'--allow-fs-read='+join(root,'shared'),'--max-old-space-size=128',...(process.allowedNodeEnvironmentFlags.has('--allow-net')?['--allow-net']:[]),worker];
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env,stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
    let settled=false,result;
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    // This child belongs to this invocation; no unrelated process is touched.
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(Object.assign(Error('Local adapter request timed out'),{status:504}));},60000);
    child.once('error',()=>finish(Object.assign(Error('Could not start local adapter'),{status:503})));
    child.once('message',value=>{result=value;});
    child.once('exit',code=>finish(code===0&&result?undefined:Object.assign(Error('Local adapter request failed'),{status:502})));
    child.send(input,error=>{if(error)finish(error);});
  });
}
