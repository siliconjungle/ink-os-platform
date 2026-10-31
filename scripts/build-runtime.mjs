import{build}from'vite';import{resolve}from'node:path';
for(const[name,entry]of[['documents','shared/app-documents.mjs'],['text-worker','shared/text-worker.mjs']])await build({configFile:false,publicDir:false,build:{lib:{entry:resolve(entry),formats:['es'],fileName:()=>name+'.mjs'},target:'es2022',outDir:'public/ink-runtime',emptyOutDir:false,minify:true,reportCompressedSize:true}});

const{readFile,writeFile}=await import('node:fs/promises');const{gzipSync}=await import('node:zlib');for(const name of['documents','text-worker'])await writeFile('public/ink-runtime/'+name+'.mjs.gz',gzipSync(await readFile('public/ink-runtime/'+name+'.mjs'),{level:9}));
