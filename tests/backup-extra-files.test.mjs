import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBackup, restoreBackup } from '../server/backup-store.mjs';

const password='disposable streamed file backup password';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ink-backup-extra-'))),source=join(root,'source'),archives=join(root,'archives');
  await mkdir(join(source,'blobs'),{recursive:true});await mkdir(archives);await writeFile(join(source,'seed'),'x');
  await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{source:'Active generated additional-file archive input.',archives:'Active generated encrypted outputs.'},safe_to_remove:{}}));
  t.after(async()=>{await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:{source:'Completed generated source input.',archives:'Completed encrypted test outputs.',restored:'Completed raw restoration readback.',staged:'Completed generated staged-source fixture.'}}));await rm(root,{recursive:true});});
  return{root,source,archives};
}
test('bounded extra byte streams restore exact bytes and modes alongside the private local tree',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(160000,131),digest=sha(bytes);let releases=0;
  const archive=join(f.archives,'stream.inkbackup');
  const result=await createBackup({directory:f.source,archive,password,acquireSnapshot:async()=>({directory:f.source,consistency:'quiesced',coverage:{remoteAssets:true},release:async()=>{releases++;},extraFiles:async function*(){yield{path:'blobs/'+digest,mode:0o640,size:bytes.length,sha256:digest,chunks:(async function*(){yield bytes.subarray(0,65539);yield bytes.subarray(65539);})()};}})});
  assert.equal(releases,1);assert.equal(result.files,2);assert.equal(result.bytes,bytes.length+1);
  const target=join(f.root,'restored');await restoreBackup({directory:target,archive,password});
  assert.deepEqual(await readFile(join(target,'blobs',digest)),bytes);assert.equal((await lstat(join(target,'blobs',digest))).mode&0o777,0o640);assert.equal(await readFile(join(target,'seed'),'utf8'),'x');
});
test('unsafe, colliding, malformed, unverified and over-limit extra files cannot publish an archive',async t=>{
  const f=await fixture(t),bytes=Buffer.from('abc');
  const base={path:'blobs/'+sha(bytes),mode:0o600,size:3,sha256:sha(bytes),chunks:[bytes]};
  const cases=[
    [{path:'../outside'},undefined,/Unsafe/],
    [{path:'missing/entry'},undefined,/parent/],
    [{path:'SEED'},undefined,/Ambiguous/],
    [{sha256:'not-a-digest'},undefined,/Invalid/],
    [{sha256:sha('different')},undefined,/digest/],
    [{size:4},undefined,/size|digest/],
    [{size:2},undefined,/size/],
    [{chunks:['abc']},undefined,/bytes/],
    [{mode:0o1000},undefined,/Invalid/],
    [{},{maxEntries:3},/Invalid|limit/],
    [{},{maxFileBytes:2},/limit/],
    [{},{maxBytes:3},/limit/],
  ];
  for(const[index,[patch,limits,error]]of cases.entries()){
    let releases=0,visited=false;const archive=join(f.archives,'invalid-'+index+'.inkbackup');
    await assert.rejects(createBackup({directory:f.source,archive,password,limits,acquireSnapshot:async()=>({directory:f.source,consistency:'quiesced',release:async()=>{releases++;},extraFiles:async function*(){visited=true;yield{...base,...patch};}})}),error);
    assert.equal(visited,true);assert.equal(releases,1);await assert.rejects(lstat(archive),{code:'ENOENT'});
  }
  assert.deepEqual(await readdir(f.archives),[]);assert.equal(await readFile(join(f.source,'seed'),'utf8'),'x');
});
test('staged snapshots authenticate original managed-project mappings without reading the original root',async t=>{
  const f=await fixture(t),staged=join(f.root,'staged'),original=join(f.root,'gone-original'),id='a'.repeat(32);
  await mkdir(join(staged,'projects',id),{recursive:true});await writeFile(join(staged,'projects',id,'main.ink'),'module staged;\n');
  await writeFile(join(staged,'projects.json'),JSON.stringify({[id]:{id,managed:true,directory:join(original,'projects',id)}}));
  const archive=join(f.archives,'stage.inkbackup');
  const result=await createBackup({directory:staged,archive,password,acquireSnapshot:async()=>({directory:staged,sourceRoot:original,consistency:'snapshot',release:async()=>{}})});
  assert.equal(result.source.instanceRoot,original);assert.equal(result.source.managedProjects[0].archivePath,'projects/'+id);await assert.rejects(lstat(original),{code:'ENOENT'});
  const restored=await restoreBackup({directory:join(f.root,'restored'),archive,password});assert.deepEqual(restored.source,result.source);assert.equal(await readFile(join(f.root,'restored','projects',id,'main.ink'),'utf8'),'module staged;\n');
});
