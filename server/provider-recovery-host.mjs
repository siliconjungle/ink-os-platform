import { join } from 'node:path';
import { recoveredAssets, recoveredBlob, recoveryAliasJournal, recoveryHash, readRecoveryPlan } from './provider-recovery.mjs';
import { privateJSON, writePrivateJSON, unboundDeployment } from './provider-bindings.mjs';

/** Startup owns this directory before apps, HTTP and compute admission exist.
 * Remote writes use only the destination's configured content-addressed store.
 * An interrupted copy may repeat exact digest PUTs, never source-worker calls. */
export async function activateRecoveredStorage(storage) {
  const directory = storage.directory, plan = await readRecoveryPlan(directory);
  if (!plan || plan.storage.provider !== 'host' || plan.storage.state === 'complete') return;
  const manifest = await recoveredAssets(directory, plan.storage.assets, plan.storage.manifestSha256);
  const target = recoveryHash(JSON.stringify({r2:storage.r2?{url:storage.r2.url,bucket:storage.r2.bucket}:null,s3:storage.config?{endpoint:storage.config.endpoint||null,bucket:storage.config.bucket,region:storage.config.region||null,prefix:storage.config.prefix||''}:null}));
  if (plan.storage.target && plan.storage.target !== target) throw Error('Recovery object store changed during its pending copy.');
  Object.assign(plan.storage, { state:'copying',target }); await writePrivateJSON(directory,'provider-recovery.json',plan);
  const targets = new Map();
  for (const row of manifest.objects) {
    const bytes = await recoveredBlob(directory,row), blob = await storage.put(bytes);
    if (blob.digest !== row.digest || blob.bytes !== row.bytes || !storage.aliasIsCurrent(blob.location)) throw Error('Recovery destination changed content identity.');
    const verified = await storage.readAliasCurrent(blob.location,{maxBytes:row.bytes});
    if (verified.length !== row.bytes || recoveryHash(verified) !== row.digest) throw Error('Recovery destination failed byte verification.');
    targets.set(row.digest,blob.location);
  }
  await writePrivateJSON(directory,'storage-aliases.json',recoveryAliasJournal(manifest.objects,targets,plan.operation,manifest.digest));
  await storage.aliases.open(); plan.storage.state='complete'; await writePrivateJSON(directory,'provider-recovery.json',plan);
}
export async function activateRecoveredRuntimes(world) {
  const directory = world.directory, plan = await readRecoveryPlan(directory);
  if (!plan || plan.runtime.provider === 'preserve' || plan.runtime.state === 'complete') return;
  const auditPath=join(directory,plan.auditDirectory,'deployments.json');
  let audit=await privateJSON(auditPath,128*1024*1024,true);
  if(!audit){
    const releases=world.all().filter(object=>object.kind==='release').flatMap(object=>{const meta=JSON.parse(object.body);return meta.deployment?[{id:object.id,bodyDigest:recoveryHash(object.body),deployment:meta.deployment}]:[];});
    const ids=new Set(releases.map(row=>row.id)),apps=world.all().filter(object=>object.kind==='app'&&object.namespace==='os').flatMap(object=>{const meta=JSON.parse(object.body);return ids.has(meta.releaseId)?[{id:object.id,bodyDigest:recoveryHash(object.body),url:meta.url||null}]:[];});
    audit={format:'ink-os-recovered-deployments-v1',operation:plan.operation,releases,apps};
    if(Buffer.byteLength(JSON.stringify(audit))>128*1024*1024)throw Error('Recovery deployment audit exceeds its bound.');
    await writePrivateJSON(join(directory,plan.auditDirectory),'deployments.json',audit);
  }
  if(audit.format!=='ink-os-recovered-deployments-v1'||audit.operation!==plan.operation||!Array.isArray(audit.releases)||audit.releases.length>100000||new Set(audit.releases.map(row=>row.id)).size!==audit.releases.length||!Array.isArray(audit.apps)||audit.apps.length>100000)throw Error('Invalid recovery deployment audit.');
  for(const row of audit.releases){
    const object=world.get(row.id);if(object?.kind!=='release')throw Error('Recovered release identity changed.');const meta=JSON.parse(object.body);
    if(unboundDeployment(meta.deployment)&&meta.deployment.recovery===plan.operation)continue;
    if(recoveryHash(object.body)!==row.bodyDigest)throw Error('Recovered deployment changed before rebinding.');
    await world.update(object.id,{body:JSON.stringify({...meta,deployment:{provider:'unbound',parked:true,recovery:plan.operation}})},{writer:'os',quiet:true,actor:'Recovery',action:'detached source deployment'});
  }
  for(const row of audit.apps){const object=world.get(row.id);if(object?.kind!=='app'||object.namespace!=='os')throw Error('Recovered app identity changed.');const meta=JSON.parse(object.body);if(meta.runtimeRecovery===plan.operation&&!meta.url)continue;if(recoveryHash(object.body)!==row.bodyDigest)throw Error('Recovered app changed before detaching its source URL.');delete meta.url;meta.runtimeRecovery=plan.operation;await world.update(object.id,{body:JSON.stringify(meta)},{writer:'os',quiet:true,actor:'Recovery',action:'detached source URL'});}
  plan.runtime.state='complete';plan.runtime.releases=audit.releases.length;await writePrivateJSON(directory,'provider-recovery.json',plan);
}
