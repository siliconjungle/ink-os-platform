import { writeFile, access } from 'node:fs/promises';
export async function fetch(request, { ink }) {
  const path = new URL(request.url).pathname;
  if (path === '/work') {
    const hold = await ink.compute.hold('Background proof');
    await writeFile('/tmp/tenant-marker', 'first');
    const complete = async () => {
      try { await ink.state.set('completed', { done: true }); await hold.release(); }
      catch { setTimeout(complete, 250); }
    };
    setTimeout(complete, 1500);
    return Response.json({ started: true });
  }
  if (path === '/done') return Response.json(await ink.state.get('completed'));
  if (path === '/inspect') return Response.json({ setting: process.env.SAMPLE_SETTING || null, hostSecret: process.env.HOST_ONLY_SECRET || null, marker: await access('/tmp/tenant-marker').then(() => true, () => false) });
  if (path === '/count' && request.method === 'POST') {
    const state = await ink.state.get('counter');
    return Response.json(await ink.state.set('counter', { count: (state.value?.count || 0) + 1 }, state.revision));
  }
  return Response.json(await ink.state.get('counter'));
}
