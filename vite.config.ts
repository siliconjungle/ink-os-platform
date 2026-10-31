import { defineConfig } from 'vite';
export default defineConfig({ plugins:[{name:'ink-app-links',configureServer(server){server.middlewares.use((req,_res,next)=>{if(req.url?.startsWith('/app/'))req.url='/app.html';next();});}}], server: { host: '127.0.0.1', port: 4318 }, build: { target: 'es2022', rollupOptions:{input:{desktop:'index.html',app:'app.html'}} } });
