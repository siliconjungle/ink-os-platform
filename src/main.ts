import './native/command-system.mjs';
import './native.css';
import './desktop.css';
import './ferrofluid.css';
const root=document.getElementById('root')!;
const query=new URLSearchParams(location.search);
if(query.has('perf'))import('./native/perf').then(({startPerf})=>startPerf(root));
else void(async()=>{if(import.meta.env.DEV)try{await(await import('./migrations/local-app-bindings')).migrateLocalAppBindings();}catch(error){console.warn('Local app window upgrade deferred',error);}const{Desktop}=await import('./native/desktop');new Desktop(root);})();
