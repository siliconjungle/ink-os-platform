import { distributionApps } from '../shared/distribution-apps.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '../sdk/src/server.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const parse = value => { try { return JSON.parse(value); } catch { fail('INK_CLOUD_PROOF_JSON'); } };
const bodyOf = record => parse(record.body);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const encode = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });

export function canaryBundle(nonce) {
  check(/^[a-f0-9]{32}$/.test(nonce), 'INK_CLOUD_PROOF_NONCE');
  const html = '<!doctype html><title>Ink hosted acceptance</title><p data-proof="' + nonce + '">Private hosted canary</p>';
  const source = `const marker=${JSON.stringify(nonce)};export async function fetch(request,{ink}){const path=new URL(request.url).pathname;if(path==='/allow-idle'&&request.method==='POST'){await ink.compute.allowIdle();return Response.json({marker,idleAllowed:true});}if(path!=='/count')return new Response(null,{status:404});const state=await ink.state.get('hosted-canary');if(request.method==='POST'){const input=await request.json();if(input.operation!==marker)return new Response(null,{status:400});if(!state.value)await ink.state.set('hosted-canary',{marker,count:1,operation:marker},state.revision);else if(state.value.marker!==marker||state.value.operation!==marker||state.value.count!==1)return new Response(null,{status:409});}else if(request.method!=='GET')return new Response(null,{status:405});const current=await ink.state.get('hosted-canary');return Response.json({marker,count:current.value?.count||0});}`;
  return { commands: [], files: [encode('index.html', html), encode('server/main.mjs', source)], entry: 'index.html', backend: { idleSafe: true, entry: 'server/main.mjs' } };
}

async function privateRead(file, max = 1024 * 1024) {
  const info = await lstat(file);
  check(info.isFile() && !(info.mode & 0o077) && info.size <= max, 'INK_CLOUD_PROOF_PRIVATE_FILE');
  return parse(await readFile(file, 'utf8'));
}
async function atomicJSON(file, value) {
  const temporary = file + '.next-' + randomBytes(8).toString('hex');
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function boundedResponse(response, max = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const bytes of response.body || []) { size += bytes.length; if (size > max) fail('INK_CLOUD_PROOF_RESPONSE_LIMIT'); chunks.push(Buffer.from(bytes)); }
  return new Response([204, 304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers });
}

/** All account mutations use the owner SDK. fetch injection is for local fixtures. */
export async function verifyCloudHost({ url, token, journal: journalFile, output, phase = 'run', restartReceipt, fetch: transport = globalThis.fetch, idleTimeoutMs = 180000, pollMs = 1000, allowLoopbackHTTP = false } = {}) {
  const host = new URL(url);
  check(host.pathname === '/' && !host.search && !host.hash && !host.username && !host.password && (host.protocol === 'https:' || allowLoopbackHTTP && host.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(host.hostname)), 'INK_CLOUD_PROOF_URL');
  check(typeof token === 'string' && token.length >= 8 && !/[\r\n]/.test(token), 'INK_CLOUD_PROOF_CREDENTIAL');
  check(journalFile && output && resolve(journalFile) !== resolve(output), 'INK_CLOUD_PROOF_PATHS');
  check(['run', 'prepare-restart', 'resume', 'cleanup'].includes(phase), 'INK_CLOUD_PROOF_PHASE');
  check(Number.isFinite(idleTimeoutMs) && idleTimeoutMs >= 0 && idleTimeoutMs <= 900000 && Number.isFinite(pollMs) && pollMs >= 1, 'INK_CLOUD_PROOF_TIMEOUT');
  journalFile = resolve(journalFile); output = resolve(output);
  await mkdir(dirname(journalFile), { recursive: true, mode: 0o700 });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const lock = await open(journalFile + '.lock', 'wx', 0o600).catch(() => fail('INK_CLOUD_PROOF_LOCKED'));
  let journal, stage = 'health', proof;
  const fetcher = async (input, init = {}) => boundedResponse(await transport(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(90000) }));
  const sdk = createClient({ url: host.origin, token, fetch: async (input, init) => { check(new URL(input).origin === host.origin, 'INK_CLOUD_PROOF_OWNER_ORIGIN'); return fetcher(input, init); } });
  const save = async value => { Object.assign(journal, value, { updatedAt: new Date().toISOString() }); await atomicJSON(journalFile, journal); };
  const catalog = async () => {
    const apps = await sdk.apps.list({ includeDeleted: true }); check(Array.isArray(apps), 'INK_CLOUD_PROOF_CATALOG');
    const defaults = distributionApps(apps);
    const baseline = defaults.map(app => ({id:app.id, releaseId:bodyOf(app).releaseId, sourceCommit:bodyOf(app).sourceCommit})).sort((a,b)=>a.id.localeCompare(b.id));
    if (journal.defaultApps) check(JSON.stringify(journal.defaultApps) === JSON.stringify(baseline), 'INK_CLOUD_PROOF_DEFAULT_APPS_CHANGED');
    const userApps = apps.filter(app => !defaults.includes(app));
    check(userApps.length <= 1 && userApps.every(app => app.id === journal.appId && app.title === journal.title && bodyOf(app).slug === journal.slug && !bodyOf(app).repository && !bodyOf(app).projectId), 'INK_CLOUD_PROOF_NONEMPTY_CATALOG');
    if (!journal.defaultApps) await save({defaultApps:baseline});
    return userApps[0];
  };
  const runtime = async () => {
    const result = await sdk.runtimes.list(); check(Array.isArray(result.slots), 'INK_CLOUD_PROOF_RUNTIME');
    check(result.slots.every(slot => !slot.appId ? slot.status === 'idle' && !slot.leaseId : slot.appId === journal.appId && (!journal.releaseId || slot.releaseId === journal.releaseId)), 'INK_CLOUD_PROOF_FOREIGN_WORKER');
    return result;
  };
  const quiesce = async app => {
    stage = 'quiescence'; await catalog();
    let state = await runtime();
    if (state.slots.some(slot => slot.appId === journal.appId)) {
      check(app && !app.archived && journal.releaseId, 'INK_CLOUD_PROOF_WORKER_PRESERVED');
      const result = await sdk.request('apps/' + journal.appId + '/invoke', { method: 'POST', body: { path: '/allow-idle', method: 'POST' } });
      assert.deepEqual(result.body, { marker: journal.nonce, idleAllowed: true });
      const deadline = Date.now() + idleTimeoutMs;
      while (state.slots.some(slot => slot.appId === journal.appId)) {
        check(Date.now() < deadline, 'INK_CLOUD_PROOF_IDLE_TIMEOUT');
        check(state.slots.every(slot => !slot.appId || slot.inFlight === 0 && Array.isArray(slot.holds) && slot.holds.length === 0), 'INK_CLOUD_PROOF_WORKER_PRESERVED');
        await sleep(pollMs); state = await runtime();
      }
    }
    check(state.slots.every(slot => slot.status === 'idle' && !slot.appId && !slot.leaseId), 'INK_CLOUD_PROOF_WORKER_PRESERVED');
  };
  const checkEdge = async () => {
    stage = 'edge'; const launch = await sdk.request('apps/' + journal.appId + '/launch', { method: 'POST', body: {} });
    const origin = new URL(launch.origin), link = new URL(launch.url);
    check(origin.origin !== host.origin && origin.protocol === host.protocol && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password && link.origin === origin.origin && link.pathname === '/_ink/launch' && launch.releaseId === journal.releaseId && origin.hostname.startsWith(journal.releaseId + '-'), 'INK_CLOUD_PROOF_EDGE_ORIGIN');
    check(!journal.edgeOriginSha256 || journal.edgeOriginSha256 === sha(origin.origin), 'INK_CLOUD_PROOF_EDGE_ORIGIN');
    check((await fetcher(origin)).status === 401, 'INK_CLOUD_PROOF_EDGE_ANONYMOUS');
    const redirect = await fetcher(link); check([302, 303].includes(redirect.status) && redirect.headers.get('location') === '/', 'INK_CLOUD_PROOF_EDGE_LAUNCH');
    const setCookie = redirect.headers.get('set-cookie') || '';
    check(/^__Host-ink_app_session=[A-Za-z0-9_.-]+;/.test(setCookie) && /;\s*Secure(?:;|$)/i.test(setCookie) && /;\s*HttpOnly(?:;|$)/i.test(setCookie) && /;\s*Path=\/(?:;|$)/i.test(setCookie) && /;\s*SameSite=None(?:;|$)/i.test(setCookie) && /;\s*Partitioned(?:;|$)/i.test(setCookie), 'INK_CLOUD_PROOF_EDGE_COOKIE');
    const headers = { Cookie: setCookie.split(';')[0] };
    const page = await fetcher(origin, { headers }); check(page.status === 200, 'INK_CLOUD_PROOF_EDGE_HTML');
    check(await page.text() === Buffer.from(canaryBundle(journal.nonce).files[0].base64, 'base64').toString(), 'INK_CLOUD_PROOF_EDGE_HTML');
    const hidden = await fetcher(new URL('/server/main.mjs', origin), { headers }); check(hidden.status === 404, 'INK_CLOUD_PROOF_SOURCE_PRIVACY');
    const backend = await fetcher(new URL('/backend/count', origin), { headers }); check(backend.status === 200, 'INK_CLOUD_PROOF_EDGE_BACKEND');
    assert.deepEqual(await backend.json(), { marker: journal.nonce, count: 1 });
    await save({ edgeOriginSha256: sha(origin.origin), edgeVerified: true });
  };
  try {
    const healthResponse = await fetcher(new URL('/api/health', host)); check(healthResponse.ok, 'INK_CLOUD_PROOF_HEALTH');
    const health = await healthResponse.json(); check(health.ok === true && health.draining !== true && /^[a-f0-9]{32}$/.test(health.instanceId), 'INK_CLOUD_PROOF_HEALTH');
    try { journal = await privateRead(journalFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!journal) {
      check(phase === 'run' || phase === 'prepare-restart', 'INK_CLOUD_PROOF_JOURNAL_REQUIRED');
      const nonce = randomBytes(16).toString('hex'), slug = 'ink-host-proof-' + nonce.slice(0, 16);
      journal = { format: 'ink-os-cloud-host-journal-v1', host: host.origin, instanceId: health.instanceId, nonce, slug, title: 'Hosted acceptance ' + nonce, appId: sha('ink-os-app:' + slug).slice(0, 32), createdAt: new Date().toISOString(), phase: 'catalog-intent' };
      await save({});
    }
    check(journal.format === 'ink-os-cloud-host-journal-v1' && journal.host === host.origin && journal.instanceId === health.instanceId && /^[a-f0-9]{32}$/.test(journal.nonce) && journal.slug === 'ink-host-proof-' + journal.nonce.slice(0, 16) && journal.title === 'Hosted acceptance ' + journal.nonce && journal.appId === sha('ink-os-app:' + journal.slug).slice(0, 32), 'INK_CLOUD_PROOF_JOURNAL_IDENTITY');
    stage = 'catalog'; let app = await catalog(); await runtime();
    if (!journal.initialCatalogVerified) { check(!app, 'INK_CLOUD_PROOF_NONEMPTY_CATALOG'); await save({ initialCatalogVerified: true }); }
    if (journal.phase === 'complete') { check(!app, 'INK_CLOUD_PROOF_CATALOG'); proof = journal.proof; check(['passed', 'cleaned'].includes(proof?.status), 'INK_CLOUD_PROOF_JOURNAL_IDENTITY'); await atomicJSON(output, proof); return proof; }
    if (phase === 'resume') {
      check(journal.phase === 'awaiting-restart' && restartReceipt, 'INK_CLOUD_PROOF_RESTART_RECEIPT');
      const receipt = await privateRead(resolve(restartReceipt));
      check(receipt.format === 'ink-os-cloud-restart-receipt-v1' && receipt.challenge === journal.restartChallenge && receipt.instanceId === journal.instanceId && /^[a-f0-9]{64}$/.test(receipt.evidenceSha256) && Number.isFinite(Date.parse(receipt.completedAt)) && Date.parse(receipt.completedAt) >= Date.parse(journal.restartPreparedAt) && Date.parse(receipt.completedAt) <= Date.now() + 60000, 'INK_CLOUD_PROOF_RESTART_RECEIPT');
      await save({ restartAttestationSha256: sha(JSON.stringify(receipt)) });
    } else check(journal.phase !== 'awaiting-restart' || phase === 'cleanup', 'INK_CLOUD_PROOF_RESTART_PENDING');
    const cleanupOnly = phase === 'cleanup' || journal.phase === 'cleanup-intent';
    if (phase === 'resume') check(app && journal.releaseId && bodyOf(app).releaseId === journal.releaseId, 'INK_CLOUD_PROOF_RESTART_STATE');
    if (!app && !cleanupOnly) {
      check(!journal.releaseId && ['catalog-intent', 'create-intent'].includes(journal.phase), 'INK_CLOUD_PROOF_CANARY_MISSING');
      stage = 'create'; await save({ phase: 'create-intent' });
      await sdk.apps.create({ slug: journal.slug, title: journal.title, capabilities: ['world.read', 'world.write'] });
      app = await catalog(); check(app, 'INK_CLOUD_PROOF_CREATE');
    }
    if (app) {
      check(!app.archived || cleanupOnly, 'INK_CLOUD_PROOF_ARCHIVED'); stage = 'release';
      const wanted = canaryBundle(journal.nonce); const releases = (await sdk.apps.status(journal.appId)).releases;
      check(Array.isArray(releases) && releases.length <= 1, 'INK_CLOUD_PROOF_RELEASE_IDENTITY');
      let release = releases[0];
      if (!release && !cleanupOnly) { check(phase !== 'resume', 'INK_CLOUD_PROOF_RESTART_STATE'); await save({ phase: 'release-intent' }); release = await sdk.request('apps/' + journal.appId + '/releases', { method: 'POST', body: wanted }); }
      if (release) {
      check(/^[a-f0-9]{32}$/.test(release.id) && bodyOf(release).appId === journal.appId, 'INK_CLOUD_PROOF_RELEASE_IDENTITY');
      assert.deepEqual(await sdk.request('runtime/bundle/' + release.id), wanted);
      const meta = bodyOf(release); check(/^[a-f0-9]{32}$/.test(meta.bundleObjectId) && meta.bundleLocation?.startsWith('r2://'), 'INK_CLOUD_PROOF_R2_SOURCE');
      const sourceBytes = await sdk.assets.get(meta.bundleObjectId);
      check(sha(sourceBytes) === meta.digest, 'INK_CLOUD_PROOF_R2_SOURCE');
      assert.deepEqual(parse(Buffer.from(sourceBytes).toString()), wanted);
      check(!journal.releaseId || journal.releaseId === release.id, 'INK_CLOUD_PROOF_RELEASE_IDENTITY');
      await save({ releaseId: release.id, sourceAssetId: meta.bundleObjectId, bundleSha256: sha(JSON.stringify(wanted)), ...(cleanupOnly || phase === 'resume' ? {} : { phase: 'publish-intent' }) });
      }
      if (!cleanupOnly) {
      if (bodyOf(app).releaseId !== release.id) await sdk.apps.publish(journal.appId, release.id);
      app = await catalog(); check(bodyOf(app).releaseId === release.id, 'INK_CLOUD_PROOF_PUBLICATION');
      stage = 'invoke'; if (phase !== 'resume') await save({ phase: 'invoke-intent' });
      const result = await sdk.request('apps/' + journal.appId + '/invoke', { method: 'POST', body: { path: '/count', method: phase === 'resume' ? 'GET' : 'POST', ...(phase === 'resume' ? {} : { body: { operation: journal.nonce } }) } });
      check(result.status === 200, 'INK_CLOUD_PROOF_BACKEND'); assert.deepEqual(result.body, { marker: journal.nonce, count: 1 });
      const state = await sdk.request('state/hosted-canary?namespace=' + journal.appId);
      assert.deepEqual(state.value, { marker: journal.nonce, count: 1, operation: journal.nonce });
      await save({ backendVerified: true, stateSha256: sha(JSON.stringify(state.value)) });
      await checkEdge();
      }
    }
    await quiesce(app);
    if (phase === 'prepare-restart') {
      const restartPreparedAt = new Date().toISOString();
      await save({ phase: 'awaiting-restart', restartPreparedAt, restartChallenge: sha(JSON.stringify([journal.instanceId, journal.appId, journal.releaseId, journal.stateSha256, restartPreparedAt])) });
      proof = { format: 'ink-os-cloud-host-proof-v1', status: 'awaiting-restart', instanceId: journal.instanceId, challenge: journal.restartChallenge, canaryId: journal.appId, backendVerified: true, edgeVerified: true, quiescent: true, restartVerified: false };
      await atomicJSON(output, proof); return proof;
    }
    stage = 'cleanup'; await catalog();
    if (app) {
      const namespace = await sdk.data.list({ namespace: journal.appId });
      const stateDocument = sha(journal.appId + '\0state');
      check(Array.isArray(namespace) && namespace.every(record => {
        if (record.namespace !== journal.appId) return false;
        if (record.id === journal.sourceAssetId) return record.kind === 'file' && record.tags.includes('app-source');
        if (record.kind === 'state') return record.id === sha(journal.appId + '\0state\0hosted-canary').slice(0, 32) && record.title === 'hosted-canary' && sha(record.body) === sha(JSON.stringify({ marker: journal.nonce, count: 1, operation: journal.nonce }));
        if (record.kind === 'collaboration') { const meta = bodyOf(record); return record.id === stateDocument.slice(0, 32) && record.title === 'state' && record.location === 'ink-collaboration:' + stateDocument && meta.key === 'state' && meta.kind === 'state' && Number.isInteger(meta.cursor) && meta.cursor >= 0; }
        return false;
      }), 'INK_CLOUD_PROOF_NAMESPACE_IDENTITY');
      if (journal.sourceAssetId) check(namespace.some(record => record.id === journal.sourceAssetId), 'INK_CLOUD_PROOF_SOURCE_ASSET');
      await save({ phase: 'cleanup-intent' });
      if (!app.archived) await sdk.apps.delete(journal.appId);
      const removed = await sdk.request('apps/' + journal.appId + '?permanent=true', { method: 'DELETE' });
      check(removed.deleted === true && removed.permanent === true && (!journal.sourceAssetId || removed.removedBlobs >= 1), 'INK_CLOUD_PROOF_SOURCE_CLEANUP');
      await save({ removedBlobs: removed.removedBlobs });
    }
    check(!await catalog(), 'INK_CLOUD_PROOF_CLEANUP');
    check((await sdk.data.list({ namespace: journal.appId })).length === 0, 'INK_CLOUD_PROOF_SOURCE_CLEANUP');
    if (journal.sourceAssetId) { let missing = false; try { await sdk.assets.get(journal.sourceAssetId); } catch (error) { if (error.status === 404) missing = true; else throw error; } check(missing, 'INK_CLOUD_PROOF_SOURCE_CLEANUP'); }
    await runtime();
    proof = { format: 'ink-os-cloud-host-proof-v1', status: journal.backendVerified && journal.edgeVerified ? 'passed' : 'cleaned', instanceId: journal.instanceId, hostOriginSha256: sha(host.origin), canaryId: journal.appId, releaseId: journal.releaseId || null, bundleSha256: journal.bundleSha256 || null, edgeOriginSha256: journal.edgeOriginSha256 || null, backendVerified: journal.backendVerified === true, edgeVerified: journal.edgeVerified === true, sourcePrivacyVerified: journal.edgeVerified === true, quiescentCleanup: true, appsIncludingArchived: journal.defaultApps.length, defaultAppsPreserved: journal.defaultApps.length, userAppsIncludingArchived: 0, sourceAssetsRemaining: 0, removedBlobs: journal.removedBlobs || 0, sourceDeletionAcknowledged: journal.removedBlobs >= 1, restartExternallyAttested: !!journal.restartAttestationSha256, restartAttestationSha256: journal.restartAttestationSha256 || null, persistenceAfterRestartHookVerified: phase === 'resume', limits: ['HTTP cookie/auth checks do not prove graphical browser behavior.', 'Restart execution is externally attested; the health API exposes no process generation.', 'Source deletion is checked through owner API disappearance and, when the purge response is received, storage deletion acknowledgement; no direct cloud credentials are used.'] };
    await save({ phase: 'complete', proof }); await atomicJSON(output, proof); return proof;
  } catch (error) {
    const safe = { format: 'ink-os-cloud-host-proof-v1', status: 'failed', stage, code: error.name === 'AssertionError' ? 'INK_CLOUD_PROOF_CONTRACT' : /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'INK_CLOUD_PROOF_REQUEST', ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}), journalRetained: true, restartVerified: false };
    await atomicJSON(output, safe); throw Object.assign(Error(safe.code), { code: safe.code, stage });
  } finally { await lock.close(); await unlink(journalFile + '.lock'); }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) { console.log('Usage: node scripts/verify-cloud-host.mjs --url HTTPS_ORIGIN --journal PRIVATE_FILE --output FILE [--phase run|prepare-restart|resume|cleanup] [--restart-receipt PRIVATE_FILE] [--idle-timeout-ms N] [--token-stdin]\nOwner credential: INK_OS_VERIFY_OWNER_TOKEN or --token-stdin. Never pass credentials in arguments. Restart receipts use ink-os-cloud-restart-receipt-v1, challenge, instanceId, completedAt and evidenceSha256.'); return; }
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i]; if (name === '--token-stdin') { stdin = true; continue; }
    const key = { '--url': 'url', '--journal': 'journal', '--output': 'output', '--phase': 'phase', '--restart-receipt': 'restartReceipt', '--idle-timeout-ms': 'idleTimeoutMs' }[name];
    check(key && args[i + 1] && !args[i + 1].startsWith('--'), 'INK_CLOUD_PROOF_ARGUMENT'); options[key] = args[++i];
  }
  if (options.idleTimeoutMs !== undefined) options.idleTimeoutMs = Number(options.idleTimeoutMs);
  if (stdin) { let bytes = ''; for await (const chunk of process.stdin) { bytes += chunk; check(bytes.length <= 4096, 'INK_CLOUD_PROOF_CREDENTIAL'); } options.token = bytes.trim(); }
  else options.token = process.env.INK_OS_VERIFY_OWNER_TOKEN;
  const proof = await verifyCloudHost(options); console.log(JSON.stringify({ status: proof.status, restartExternallyAttested: proof.restartExternallyAttested || false }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'INK_CLOUD_PROOF_INPUT' })); process.exitCode = 1; });
