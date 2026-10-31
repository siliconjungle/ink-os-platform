const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
async function authorized(request,secret){const candidate=request.headers.get('Authorization')||'';if(!secret||candidate.length>1024)return false;const a=await digest(new TextEncoder().encode(candidate)),b=await digest(new TextEncoder().encode('Bearer '+secret));let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}
export default{async fetch(request,env){
 const url=new URL(request.url);if(url.pathname==='/_health')return Response.json({ok:!!env.ASSETS&&!!env.STORAGE_TOKEN});
 if(!await authorized(request,env.STORAGE_TOKEN))return new Response('Unauthorized',{status:401});
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
 if(url.pathname==='/_list'&&request.method==='GET'){const listed=await env.ASSETS.list({prefix:'objects/',limit:100});return Response.json(listed.objects.map(object=>({key:object.key,size:object.size,modified:object.uploaded})),{headers});}
 const match=/^\/objects\/([a-f0-9]{64})$/.exec(url.pathname);if(!match)return new Response('Not found',{status:404});const key='objects/'+match[1];
 if(request.method==='PUT'){if(Number(request.headers.get('Content-Length'))>32*1024*1024)return new Response('Object too large',{status:413});const bytes=await request.arrayBuffer();if(bytes.byteLength>32*1024*1024)return new Response('Object too large',{status:413});if(await digest(bytes)!==match[1])return new Response('Content digest mismatch',{status:400});await env.ASSETS.put(key,bytes,{httpMetadata:{contentType:request.headers.get('Content-Type')||'application/octet-stream'}});return new Response(null,{status:204,headers});}
 if(request.method==='DELETE'){await env.ASSETS.delete(key);return new Response(null,{status:204,headers});}
 if(request.method==='GET'){const object=await env.ASSETS.get(key);if(!object)return new Response('Not found',{status:404});return new Response(object.body,{headers:{...headers,'Content-Type':object.httpMetadata?.contentType||'application/octet-stream',ETag:object.httpEtag}});}
 return new Response('Method not allowed',{status:405});
}};
