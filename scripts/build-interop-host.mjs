import{build}from'vite';import{resolve}from'node:path';
await build({configFile:false,publicDir:false,build:{target:'es2022',outDir:resolve(process.argv[2]||'.local/interop-host-build'),emptyOutDir:false,lib:{entry:resolve('src/native/interop-host.ts'),formats:['es'],fileName:()=> 'interop-host.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
