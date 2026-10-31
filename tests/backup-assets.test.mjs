import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { initializeInstance } from '../server/instance.mjs';
import { World } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Platform } from '../server/platform.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { createMaintenanceHostAdapter } from '../server/maintenance-host.mjs';
import { SnapshotGate, createLiveBackup } from '../sdk/src/backup.js';
import { restoreBackup } from '../server/backup-store.mjs';
import { backupAssetClosure } from '../server/backup-assets.mjs';

const password = 'disposable remote backup password';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, kind = 'r2') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-backup-assets-'))), directory = join(root, 'source');
  await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: { source: 'Active generated remote asset backup fixture.' }, safe_to_remove: {} }));
  const remote = new Map(), calls = [];
  const server = createServer(async (req,res) => {
    if(kind==='r2')assert.equal(req.headers.authorization, 'Bearer disposable-fixture-storage-token');
    else assert.match(req.headers.authorization,/^AWS4-HMAC-SHA256 Credential=fixture-access-key\//);
    const path=new URL(req.url,'http://fixture.invalid').pathname;
    calls.push({ path, method: req.method });
    if (req.method === 'PUT') { const chunks = []; for await (const chunk of req) chunks.push(chunk); remote.set(path, Buffer.concat(chunks)); res.end(); return; }
    if (!remote.has(path)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Length', remote.get(path).length); res.end(remote.get(path));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const identity = await initializeInstance({ directory });
  const world = await new World(directory).open();
  const endpoint='http://127.0.0.1:' + server.address().port;
  const env=kind==='r2'?{INK_OS_R2_URL:endpoint,INK_OS_R2_TOKEN:'disposable-fixture-storage-token',INK_OS_R2_BUCKET:'current-bucket'}:{INK_OS_S3_ENDPOINT:endpoint,INK_OS_S3_BUCKET:'current-bucket',INK_OS_STORAGE_PREFIX:'custom/prefix',AWS_ACCESS_KEY_ID:'fixture-access-key',AWS_SECRET_ACCESS_KEY:'fixture-secret-key',AWS_REGION:'auto'};
  const storage = await new Storage(directory, { env }).open();
  const provider = new LocalProvider(), platform = await new Platform({ root: directory, directory, world, storage, provider, origin: 'http://127.0.0.1', adminToken: identity.adminToken, environmentKey: identity.environmentKey }).open();
  platform.collaboration = new Collaboration({ directory, world, storage }); await platform.collaboration.recover();
  let gate; const adapter = createMaintenanceHostAdapter({ platform, requests: new Set(), responses: new Set(), externalClosed: () => !!gate?.closed });
  gate = new SnapshotGate({ directory, adapter, otherClosed: () => false, pollMs: 2 });
  t.after(async () => {
    await provider.close(); await platform.collaboration.close(); await world.tail;
    await new Promise(resolve => server.close(resolve));
    await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:{source:'Completed generated World/storage fixture; all owned handles closed.',restored:'Completed raw asset readback.', 'remote.inkbackup':'Completed generated encrypted archive.', 'failed.inkbackup':'Failed archive must not be published.'}}));
    await rm(root,{recursive:true});
  });
  const put = async bytes => { const blob = await storage.put(bytes); await world.create({ namespace:'os',kind:'file',title:'Backup fixture',location:blob.location,body:JSON.stringify({ bytes:bytes.length }) }, { writer:'os' }); return blob; };
  return { root,directory,world,storage,gate,remote,calls,put };
}

test('real current-store HTTP assets and aliases stream once per digest into an encrypted live backup; retired content stays excluded', async t => {
  const f = await fixture(t), firstBytes = Buffer.from('first remote file\0\xff'), secondBytes = Buffer.alloc(160000, 37), localBytes = Buffer.from('local retained content');
  const first = await f.put(firstBytes), second = await f.put(secondBytes), localDigest = sha(localBytes);
  await writeFile(join(f.directory,'blobs',localDigest),localBytes);
  await f.world.create({namespace:'os',kind:'file',title:'Local fixture',location:'blob:'+localDigest},{writer:'os'});
  const old = 'r2://former-bucket/objects/'+first.digest;
  await f.storage.installAliases({operation:'backup-fixture',inputDigest:sha('fixture source cut'),aliases:{[old]:first.location}});
  await f.world.create({namespace:'os',kind:'file',title:'Alias fixture',location:old},{writer:'os'});
  const retired = sha('explicitly removed bytes'); f.world.retiredBlobs.add(retired); f.world.blobRefs['f'.repeat(32)] = ['r2://current-bucket/objects/'+retired];
  f.calls.length = 0;
  const archive=join(f.root,'remote.inkbackup');
  const result=await createLiveBackup({gate:f.gate,archive,password,world:f.world,storage:f.storage,remoteAssets:true});
  assert.equal(result.coverage.remoteAssets,true); assert.equal(result.assets.objects,3); assert.equal(result.assets.locations,4); assert.equal(f.gate.closed,false);
  assert.deepEqual(f.calls.filter(call=>call.method==='GET').map(call=>call.path).sort(),['/objects/'+first.digest,'/objects/'+second.digest].sort());
  const target=join(f.root,'restored'); await restoreBackup({archive,directory:target,password});
  for(const[digest,bytes]of[[first.digest,firstBytes],[second.digest,secondBytes],[localDigest,localBytes]])assert.deepEqual(await readFile(join(target,'blobs',digest)),bytes);
  await assert.rejects(lstat(join(target,'blobs',retired)),{code:'ENOENT'});
  const manifest=JSON.parse(await readFile(join(target,result.assets.path)));
  assert.equal(manifest.format,result.assets.format); assert.equal(manifest.totalBytes,firstBytes.length+secondBytes.length+localBytes.length);
  assert.deepEqual(manifest.objects.find(row=>row.digest===first.digest).locations,[first.location,old].sort());
  assert.ok(manifest.objects.every(row=>row.path==='blobs/'+row.digest));
});

test('missing, corrupt and oversized current-store objects fail without a published archive and release live admission', async t => {
  for(const mode of ['missing','corrupt','object-limit','total-limit'])await t.test(mode,async t=>{
    const f=await fixture(t),blob=await f.put(Buffer.from('bounded retained remote bytes'));
    if(mode==='missing')f.remote.delete('/objects/'+blob.digest);
    if(mode==='corrupt')f.remote.set('/objects/'+blob.digest,Buffer.from('changed bytes'));
    const assetLimits=mode==='object-limit'?{objectBytes:5}:mode==='total-limit'?{totalBytes:5}:undefined;
    const archive=join(f.root,'failed.inkbackup');
    await assert.rejects(createLiveBackup({gate:f.gate,archive,password,world:f.world,storage:f.storage,remoteAssets:true,assetLimits}),/missing|verification|limit|bound/);
    assert.equal(f.gate.closed,false); await assert.rejects(lstat(archive),{code:'ENOENT'});
  });
});

test('the official S3 client reads only the current endpoint, bucket and prefix for aliased backup content',async t=>{
  const f=await fixture(t,'s3'),bytes=Buffer.from('S3 retained bytes'),blob=await f.put(bytes),old='r2://former-bucket/objects/'+blob.digest;
  await f.storage.installAliases({operation:'s3-backup-fixture',inputDigest:sha('S3 source cut'),aliases:{[old]:blob.location}});
  await f.world.create({namespace:'os',kind:'file',title:'Old alias',location:old},{writer:'os'});f.calls.length=0;
  const archive=join(f.root,'remote.inkbackup'),result=await createLiveBackup({gate:f.gate,archive,password,world:f.world,storage:f.storage,remoteAssets:true});
  assert.deepEqual(f.calls,[{path:'/current-bucket/custom/prefix/objects/'+blob.digest,method:'GET'}]);
  const target=join(f.root,'restored');await restoreBackup({archive,directory:target,password});
  assert.deepEqual(await readFile(join(target,'blobs',blob.digest)),bytes);
  const manifest=JSON.parse(await readFile(join(target,result.assets.path)));assert.deepEqual(manifest.objects[0].locations,[blob.location,old].sort());
});

test('unmapped former stores and malformed retained locations fail before any transport',async t=>{
  const f=await fixture(t); f.world.blobRefs.foreign=['r2://former-bucket/objects/'+sha('missing mapping')];f.calls.length=0;
  assert.throws(()=>backupAssetClosure({world:f.world,storage:f.storage}),/current storage binding/);assert.equal(f.calls.length,0);
  f.world.blobRefs.foreign=['https://former.invalid/objects/'+sha('not a content location')];
  assert.throws(()=>backupAssetClosure({world:f.world,storage:f.storage}),/canonical/);assert.equal(f.calls.length,0);
});

test('asset closure is bounded, one-shot and refuses a different instance',async t=>{
  const f=await fixture(t);await f.put(Buffer.from('one'));await f.put(Buffer.from('two'));f.calls.length=0;
  assert.throws(()=>backupAssetClosure({world:f.world,storage:f.storage,limits:{objects:1}}),/object limit/);
  assert.throws(()=>backupAssetClosure({world:f.world,storage:f.storage,limits:{locations:1}}),/location limit/);
  assert.throws(()=>backupAssetClosure({world:{...f.world,directory:f.root},storage:f.storage}),/same opened/);
  assert.throws(()=>createLiveBackup({gate:f.gate,archive:join(f.root,'never'),password,remoteAssets:true,world:{...f.world,directory:f.root},storage:f.storage}),/same instance/);
  const closure=backupAssetClosure({world:f.world,storage:f.storage});for await(const _ of closure.extraFiles()){}
  await assert.rejects(async()=>{for await(const _ of closure.extraFiles()){}},/already consumed/);
});
