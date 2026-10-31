import{responseJSON}from '../shared/response-json.mjs';
let assetsToken='';
export function setAssetsToken(value:string){assetsToken=value||'';}
let transport: ((path:string,options:RequestInit)=>Promise<any>)|undefined;
export function setTransport(value:typeof transport){transport=value;}
export const sessionId = crypto.randomUUID();
export function actor() { return localStorage.getItem('ink-os-name') || 'Owner'; }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  if(transport)return transport(path,options);
  const response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Ink-Actor': encodeURIComponent(actor()), ...options.headers } });
  return responseJSON(response);
}
export const post = <T = any>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const safeJSON = (text: string, fallback: any = {}) => { try { return JSON.parse(text); } catch { return fallback; } };
export const ago = (time: number) => { const m = Math.max(0, Math.floor((Date.now() - time) / 60000)); return m < 1 ? 'Just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
export function blobURL(locationValue:string,mime='application/octet-stream'){return (new URLSearchParams(location.search).get('desktopOrigin')||'')+'/api/blob?location='+encodeURIComponent(locationValue)+'&mime='+encodeURIComponent(mime)+(assetsToken?'&access='+encodeURIComponent(assetsToken):'');}
export function coverURL(object: { cover: string; location?: string; body?: string }) {
  if (object.cover === 'import' && object.location) return blobURL(object.location,safeJSON(object.body||'').mime||'image/jpeg');
  if (object.cover === 'forest' || object.cover === 'mountain') return `/art/${object.cover}.jpg`;
  return `/art/${object.cover || 'light'}.svg`;
}

export async function uploadFile(file:File,namespace='os'){
 if(file.size>24*1024*1024)throw Error('Keep each file below 24 MiB');
 const query=new URLSearchParams({name:file.name,namespace}),response=await fetch('/api/v1/files/upload?'+query,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-Ink-Actor':encodeURIComponent(actor())},body:file});
 if(response.status===404&&['127.0.0.1','localhost'].includes(location.hostname)){
  const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(Error('Could not read '+file.name));reader.readAsDataURL(file);});
  return post<{objects:import('./types').WorldObject[]}>('/import',{namespace,files:[{name:file.name,mime:file.type,base64}]});
 }
 return responseJSON(response) as Promise<{objects:import('./types').WorldObject[]}>;
}
