import { writeFile, access } from 'node:fs/promises';
let backgroundError;
export async function fetch(request, { ink }) {
  const path = new URL(request.url).pathname;
  if (path === '/account-work') {
    const hold = await ink.compute.hold('Account continuation proof');
    const complete = async () => {
      try {
        const deadline = Date.now() + 10000;
        for (;;) {
          const health = await globalThis.fetch(new URL('/api/health', process.env.INK_OS_URL), { redirect: 'error' }).then(response => response.json());
          if (health.draining) break;
          if (Date.now() >= deadline) throw Error('Host did not close admission');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const { createClient } = await import(process.env.INK_OS_SDK_URL);
        const account = createClient({ token: process.env.PROOF_ACCOUNT_TOKEN, continuation: { url: process.env.INK_OS_URL, token: process.env.INK_OS_APP_TOKEN } });
        const object = await account.data.create({ namespace: 'os', kind: 'note', title: 'Admitted account continuation', body: 'Saved before graceful shutdown' });
        const state = await ink.state.get('continuation-proof');
        await ink.state.set('continuation-proof', { done: true, objectId: object.id }, state.revision);
      } catch (error) {
        const state = await ink.state.get('continuation-proof');
        await ink.state.set('continuation-proof', { done: false, error: error.message }, state.revision);
      } finally { await hold.release(); }
    };
    setTimeout(complete, 0);
    return Response.json({ started: true });
  }
  if (path === '/work') {
    const hold = await ink.compute.hold('Background proof');
    await writeFile('/tmp/tenant-marker', 'first');
    const complete = async () => {
      try { const state = await ink.state.get('completed'); await ink.state.set('completed', { done: true }, state.revision); await hold.release(); }
      catch (error) {
        if (error.status && error.status < 500 && error.status !== 409) { backgroundError = { status: error.status, message: error.message }; await hold.release(); return; }
        setTimeout(complete, 250);
      }
    };
    setTimeout(complete, 1500);
    return Response.json({ started: true });
  }
  if (path === '/done') return Response.json({ ...await ink.state.get('completed'), backgroundError });
  if (path === '/inspect') return Response.json({ setting: process.env.SAMPLE_SETTING || null, hostSecret: process.env.HOST_ONLY_SECRET || null, marker: await access('/tmp/tenant-marker').then(() => true, () => false) });
  if (path === '/count' && request.method === 'POST') {
    const state = await ink.state.get('counter');
    return Response.json(await ink.state.set('counter', { count: (state.value?.count || 0) + 1 }, state.revision));
  }
  return Response.json(await ink.state.get('counter'));
}
