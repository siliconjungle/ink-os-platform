if(process.env.INK_OS_POOL==='1')await import('./pool-worker.mjs');else await import('./legacy-worker.mjs');
