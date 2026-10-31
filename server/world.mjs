import{withWriteAccess}from './runtime-credentials.mjs';
import { createState, metadata } from '../generated/world.mjs';
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';

export const id = () => randomBytes(16).toString('hex');
export const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? Number(v) : v));
export class Conflict extends Error { constructor(current) { super('This object changed in another view. Your draft is still here.'); this.status = 409; this.current = current; } }
export class World {
  constructor(directory) { this.directory = directory; this.state = createState(); this.history = []; this.blobRefs={};this.retiredBlobs=new Set();this.deleting=new Set();this.deletingNamespaces=new Set();this.mutations = {}; this.restorations={}; this.purged = new Set(); this.versionOffset = 0; this.tail = Promise.resolve(); this.listeners = new Set(); }
  async open() {
    await mkdir(this.directory, { recursive: true });
    try {
      const stored = await readFile(join(this.directory, 'world.json'), 'utf8'), record = JSON.parse(stored);
      this.versionOffset = Number.isSafeInteger(record.versionOffset) && record.versionOffset >= 0 ? record.versionOffset : 0;
      let migrated = false;
      if(record.format === 'ink-os-ink-world-v1') {
        const legacy = (await import('./migrations/world-v1.mjs')).createState();
        await legacy.restore(new Uint8Array(Buffer.from(record.snapshot, 'base64')));
        for(const object of plain(legacy.invoke('all',[]).result)) {
          const next={...object,namespace:'os',created:BigInt(object.created),updated:BigInt(object.updated)};
          const result=this.state.invoke('put',[next,0,'os']);
          if(!result.committed) throw Error('Legacy object migration failed');
        }
      } else {
        const snapshot = new Uint8Array(Buffer.from(record.snapshot, 'base64'));
        try { await this.state.restore(snapshot); }
        catch (error) {
          if (!String(error.message).includes('snapshot program or schema identity mismatch')) throw error;
          // The erase operation changed the program identity without changing Object fields.
          // Decode only the exact preceding program, then import through the current checked API.
          const legacy = (await import('./migrations/world-v2.mjs')).createState();
          await legacy.restore(snapshot);
          this.state = createState();
          for (const object of legacy.invoke('all', []).result) {
            if (!this.state.invoke('put', [object, 0, object.namespace]).committed) throw Error('World checkpoint migration failed');
          }
          this.versionOffset += Math.max(0, Number(legacy.version) - Number(this.state.version));
          migrated = true;
          await writeFile(join(this.directory, 'world-before-erase.json'), stored, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        }
      }
      if (!migrated && record.format === 'ink-os-world-v2' && record.versionOffset === undefined) {
        try {
          const before = JSON.parse(await readFile(join(this.directory, 'world-before-erase.json'), 'utf8'));
          const legacy = (await import('./migrations/world-v2.mjs')).createState();
          await legacy.restore(new Uint8Array(Buffer.from(before.snapshot, 'base64')));
          this.versionOffset = Math.max(0, Number(legacy.version) - legacy.invoke('all', []).result.length);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.history = record.history || [];
      this.mutations = record.mutations || {};this.restorations=record.restorations||{};
      this.purged = new Set(record.purged || []);this.blobRefs=record.blobRefs||{};this.retiredBlobs=new Set(record.retiredBlobs||[]);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for(const object of [...this.all(),...this.history.flatMap(entry=>[entry.before,entry.after]).filter(Boolean)])this.rememberBlob(object);
    return this;
  }
  rememberBlob(object){if(!object?.id||!blobDigest(object.location))return;const values=this.blobRefs[object.id]||[];if(!values.includes(object.location))this.blobRefs={...this.blobRefs,[object.id]:[...values,object.location]};}
  freeze(ids,namespace){if(ids.some(id=>this.deleting.has(id))||namespace&&this.deletingNamespaces.has(namespace))throw Object.assign(Error('Permanent deletion is already in progress'),{status:409});ids.forEach(id=>this.deleting.add(id));if(namespace)this.deletingNamespaces.add(namespace);return()=>{ids.forEach(id=>this.deleting.delete(id));if(namespace)this.deletingNamespaces.delete(namespace);};}
  get version() { return Number(this.state.version) + this.versionOffset; }
  query(name, args = []) { return plain(this.state.invoke(name, args).result); }
  all() { return this.query('all'); }
  get(key) { return this.query('get', [key]).Some || null; }
  captureVersion() { return this.transact(() => structuredClone({version:this.version,core:metadata.core_sha256,objects:this.all().filter(object=>!(object.namespace==='os'&&object.kind==='os.version')),history:this.history.filter(entry=>!(entry.before?.namespace==='os'&&entry.before?.kind==='os.version')&&!(entry.after?.namespace==='os'&&entry.after?.kind==='os.version')),blobRefs:Object.fromEntries(Object.entries(this.blobRefs).filter(([id])=>this.get(id)?.kind!=='os.version')),mutations:this.mutations,purged:[...this.purged]})); }
  async persist() {
    const snapshot = Buffer.from(await this.state.checkpoint()).toString('base64');
    const temp = join(this.directory, 'world.json.next');
    await writeFile(temp, JSON.stringify({ format: 'ink-os-world-v2', snapshot, history: this.history, mutations: this.mutations, restorations:this.restorations, versionOffset: this.versionOffset, purged: [...this.purged],blobRefs:this.blobRefs,retiredBlobs:[...this.retiredBlobs] }), { mode: 0o600, flush: true });
    await rename(temp, join(this.directory, 'world.json'));
    const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
  }
  transact(run) {
    const next = this.tail.then(async()=>{try{return await run();}finally{this.statsCache=undefined;}}); this.tail = next.catch(() => {}); return next;
  }
  restoreTransaction(plan,intent,run) {
    return this.transact(async()=>{
      const digest=hash(JSON.stringify(plan)),completed=this.restorations[plan.operation];
      if(completed){if(completed.planDigest!==digest)throw Object.assign(Error('Restore identity was already committed with another plan'),{status:409});return completed;}
      if(plan.format!=='ink-os-restore-plan-v1'||intent?.planDigest!==digest||intent.operation!==plan.operation)throw Object.assign(Error('A durable matching restore intent is required'),{status:409});
      if(!Array.isArray(plan.runtimeTransitions)||plan.runtimeTransitions.length||[...this.all(),...plan.objects].some(object=>object.namespace==='os'&&object.kind==='app'&&!object.archived&&JSON.parse(object.body).releaseId))throw Object.assign(Error('Whole-OS restore still needs coordinated app runtime activation'),{status:409});
      if(this.version!==plan.sourceWorldVersion||this.deleting.size||this.deletingNamespaces.size||this.all().some(object=>['purging','purge-failed'].includes(object.status)))throw Object.assign(Error('The World changed before restore acquired its transaction'),{status:409});
      const barrier=this.collaboration?.activeVersionBarrier;
      if(!barrier?.active||barrier.documents.size!==plan.documents.length||plan.documents.some(item=>!barrier.documents.has(item.id)))throw Object.assign(Error('Restore requires the complete live journal barrier'),{status:409});
      // Clone the current Ink state, then append forward writes. This never
      // loads the historical core checkpoint or rewinds the global version.
      const next=createState();await next.restore(await this.state.checkpoint());const events=[];
      for(const row of plan.objects){
        const previous=this.get(row.id);if(this.purged.has(row.id)||this.retiredBlobs.has(blobDigest(row.location))||row.revision!==(previous?.revision||0)+1||previous&&(previous.namespace!==row.namespace||previous.kind!==row.kind)||row.namespace==='os'&&row.kind==='os.version')throw Object.assign(Error('Restore object identity, content or revision changed'),{status:409});
        const object={...row,created:BigInt(row.created),updated:BigInt(row.updated)};
        if(!next.invoke('put',[object,previous?.revision||0,object.namespace]).committed)throw Object.assign(Error('Ink rejected the restore object transition'),{status:409});events.push({before:previous,after:plain(object)});
      }
      let receipt,attempted=false,active=true;
      try{await run({commit:async backup=>{
        if(!active||!barrier.active||this.collaboration.activeVersionBarrier!==barrier)throw Object.assign(Error('The restore transaction is no longer active'),{status:409});
        if(attempted)throw Error('A restore transaction can commit only once');attempted=true;
        if(plan.documents.some(item=>{const doc=barrier.documents.get(item.id);return doc.cursor!==item.afterCursor||(doc.entries[item.beforeCursor-1]?.checksum||null)!==item.beforeJournalHead||JSON.stringify(this.collaboration.documentMetadata.get(item.id))!==JSON.stringify(item.metadata)||item.batches.some((batch,index)=>doc.entries[item.beforeCursor+index]?.checksum!==hash(JSON.stringify(batch)));}))throw Object.assign(Error('Restore journals are not durably complete'),{status:409});
        if(backup?.id!==intent.input.backupId||backup.namespace!=='os'||backup.kind!=='os.version'||blobDigest(backup.location)!==hash(JSON.stringify(intent.input.before))||JSON.parse(backup.body).manifestDigest!==blobDigest(backup.location))throw Object.assign(Error('A stored matching automatic backup is required'),{status:409});
        const existing=this.get(backup.id);if(existing){if(existing.location!==backup.location||existing.body!==backup.body)throw Object.assign(Error('Restore backup identity changed'),{status:409});}
        else{
          const object={id:backup.id,namespace:'os',kind:'os.version',title:backup.title,body:backup.body,location:backup.location,summary:'',tags:['os-version'],spaces:[],status:'saved',cover:'',source:'',revision:1,created:BigInt(plan.plannedAt),updated:BigInt(plan.plannedAt),starred:false,archived:false,vector:[]};
          if(!next.invoke('put',[object,0,'os']).committed)throw Error('Ink rejected the automatic backup');events.push({before:null,after:plain(object)});
        }
        const previous={state:this.state,history:this.history,refs:this.blobRefs,restorations:this.restorations};
        this.state=next;this.blobRefs={...this.blobRefs};for(const [id,refs]of Object.entries(plan.retainedBlobs||{}))this.blobRefs[id]=[...new Set([...(this.blobRefs[id]||[]),...refs])];for(const event of events)this.rememberBlob(event.after);
        this.history=[...events.map(event=>({id:id(),objectId:event.after.id,title:event.after.title,kind:event.after.kind,action:'restored OS version '+plan.target,actor:'Version history',at:plan.plannedAt,...event})).reverse(),...this.history].slice(0,300);
        receipt={operation:plan.operation,planDigest:digest,target:plan.target,backupId:backup.id,version:this.version,committedAt:Date.now()};this.restorations={...this.restorations,[plan.operation]:receipt};
        try{await this.persist();}catch(error){this.state=previous.state;this.history=previous.history;this.blobRefs=previous.refs;this.restorations=previous.restorations;receipt=undefined;throw error;}
        for(const event of events)for(const listener of this.listeners)listener({type:'object',object:event.after,version:this.version,actor:'Version history',restore:plan.operation});
      }});}finally{active=false;}
      if(!receipt)throw Object.assign(Error('Restore did not commit its World transition'),{status:503});return receipt;
    });
  }
  async create(input, options = {}) {
    // Client-generated identities make a lost create acknowledgement safe to retry.
    try { return await this.put(input, { ...options, expected: 0 }); }
    catch (error) {
      const current = error.current, namespace = input.namespace || options.writer || 'os';
      if (error.status === 409 && current?.namespace === namespace && current.kind === (input.kind || 'note')) return current;
      throw error;
    }
  }
  mutation(key, mutationId) {
    if (!mutationId) return null;
    const match = /^([a-f0-9-]{36}):([1-9][0-9]{0,15})$/.exec(mutationId);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw Object.assign(Error('Invalid local mutation identity'), {status:400});
    return { key: key + ':' + match[1], sequence: Number(match[2]) };
  }
  hasMutation(key, mutationId) { const op = this.mutation(key, mutationId); return !!op && (this.mutations[op.key] || 0) >= op.sequence; }
  async put(input, { expected, actor = 'Owner', quiet = false, action = 'updated', writer, projection = false, mutationId, bindingChecked = false, writeAccess } = {}) {
    const existing=typeof input==='object'&&input.id?this.get(input.id):null;
    if(this.collaboration&&!projection&&!bindingChecked&&existing&&typeof input.body==='string')return this.collaboration.writeObject(existing,input,{expected,actor,quiet,action,writer,mutationId,writeAccess},()=>this.put(input,{expected,actor,quiet,action,writer,mutationId,writeAccess,bindingChecked:true}));
    return this.transact(() => withWriteAccess(writeAccess,async () => {
      if (typeof input === 'function') input = input();
      if (this.purged.has(input.id)) throw Object.assign(Error('This identity was permanently deleted'), { status: 410 });
      const previous = input.id ? this.get(input.id) : null;
      if(input.status==='purging'&&previous?.status!=='purging')await this.versions?.assertCanPurge([input.id]);
      if(this.deleting.has(input.id)||this.deletingNamespaces.has(input.namespace||previous?.namespace||writer))throw Object.assign(Error('Permanent deletion is in progress'),{status:409});
      if(previous&&['purging','purge-failed'].includes(previous.status)&&input.archived===false)throw Object.assign(Error('Permanent deletion has started; retry deletion instead of restoring'),{status:409});
      const location=input.location||previous?.location,digest=blobDigest(location);if(digest&&this.retiredBlobs.has(digest)&&!this.storage?.pending(location))throw Object.assign(Error('This content was permanently deleted; upload it again to create a new file'),{status:410});
      const mutation = this.mutation(input.id, mutationId);
      if (previous && this.hasMutation(input.id, mutationId)) {
        if ((writer || input.namespace || 'os') !== previous.namespace) throw Object.assign(Error('Only the owning app can write this namespace'), {status:403});
        return previous;
      }
      if (expected !== undefined && expected !== (previous?.revision || 0)) throw new Conflict(previous);
      const now = Date.now();
      const object = {
        id: input.id || id(), namespace: input.namespace || previous?.namespace || writer || 'os', kind: input.kind || 'note', title: input.title || '', body: input.body || '',
        summary: input.summary || '', tags: input.tags || [], spaces: input.spaces || [], status: input.status || 'idea',
        cover: input.cover || '', source: input.source || '', location: input.location || '', revision: quiet && previous ? previous.revision : (previous?.revision || 0) + 1,
        created: BigInt(previous?.created || input.created || now), updated: BigInt(quiet && previous ? previous.updated : now),
        starred: !!input.starred, archived: !!input.archived, vector: input.vector || [],
      };
      if (!/^[0-9a-f]{32}$/.test(object.id) || !object.spaces.every(s => /^[0-9a-f]{32}$/.test(s))) throw Error('Invalid object identity');
      if ([object.title, object.summary, object.body].some(v => typeof v !== 'string')) throw Error('Object text must be strings');
      const checkpoint = await this.state.checkpoint();
      const beforeHistory = this.history,beforeRefs=this.blobRefs,beforeRetired=this.retiredBlobs;
      const beforeMutation = mutation ? this.mutations[mutation.key] : undefined;
      const result = this.state.invoke('put', [object, previous?.revision || 0, writer || object.namespace]);
      if (!result.committed) { if(JSON.stringify(result.result).includes('Forbidden'))throw Object.assign(Error('Only the owning app can write this namespace'),{status:403});throw new Conflict(previous); }
      if (!quiet) this.history = [{ id: id(), objectId: object.id, title: object.title || 'Untitled thought', kind: object.kind, action, actor, at: now, before: previous, after: plain(object) }, ...this.history].slice(0, 300);
      if (mutation) this.mutations[mutation.key] = mutation.sequence;this.rememberBlob(object);if(digest&&this.retiredBlobs.has(digest)){this.retiredBlobs=new Set(this.retiredBlobs);this.retiredBlobs.delete(digest);}
      try { await this.persist(); } catch (error) { await this.state.restore(checkpoint); this.history = beforeHistory;this.blobRefs=beforeRefs;this.retiredBlobs=beforeRetired;if(mutation){if(beforeMutation===undefined)delete this.mutations[mutation.key];else this.mutations[mutation.key]=beforeMutation;} throw error; }
      const saved = this.get(object.id);
      for (const listener of this.listeners) listener({ type: 'object', object: saved, version: this.version, actor, quiet });
      return saved;
    }));
  }
  async update(key, changes, options = {}) {
    options.writeAccess?.check();
    const current = this.get(key); if (!current) throw Object.assign(Error('Object not found'), { status: 404 });
    if (this.hasMutation(key, options.mutationId)) {
      if(options.writer && options.writer!==current.namespace) throw Object.assign(Error('Only the owning app can write this namespace'),{status:403});
      return current;
    }
    if(this.collaboration&&!options.projection&&!options.bindingChecked&&typeof changes.body==='string')return this.collaboration.writeObject(current,changes,options,()=>this.update(key,changes,{...options,bindingChecked:true}));
    return this.put(() => ({ ...this.get(key), ...changes, id: key }), { expected: current.revision, ...options });
  }
  async erase(ids,{cleanup}={}) {
    return this.transact(async () => {
      await this.versions?.assertCanPurge(ids);
      const targets = new Set(ids), objects = this.all().filter(o => targets.has(o.id));
      const checkpoint = await this.state.checkpoint(), history = this.history, mutations = this.mutations, purged = this.purged,refs=this.blobRefs,retired=this.retiredBlobs;
      try {
        this.retiredBlobs=new Set(retired);if(cleanup)await cleanup();
        for (const object of objects) {
          if (!this.state.invoke('erase', [object.id, object.namespace]).committed) throw Error('Permanent deletion failed');
        }
        this.purged = new Set([...purged, ...targets]);this.blobRefs=Object.fromEntries(Object.entries(this.blobRefs).filter(([id])=>!targets.has(id)));
        this.history = history.filter(entry => !targets.has(entry.objectId));
        this.mutations = Object.fromEntries(Object.entries(mutations).filter(([key]) => !targets.has(key.slice(0,32))));
        await this.persist();
      } catch (error) { await this.state.restore(checkpoint); this.history = history; this.mutations = mutations; this.purged = purged;this.blobRefs=refs;this.retiredBlobs=retired;throw error; }
      const namespaces = new Map(objects.map(object => [object.id, object.namespace])), groups = new Map();
      for (const id of targets) { const namespace = namespaces.get(id); if (!groups.has(namespace)) groups.set(namespace, []); groups.get(namespace).push(id); }
      for (const [namespace, ids] of groups) for (const listener of this.listeners) listener({type:'deleted',ids,namespace,version:this.version});
      return objects;
    });
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  stats() {
    if(this.statsCache?.version===this.version)return {...this.statsCache};
    const objects = this.all();
    this.statsCache = { count: Number(this.query('count_objects').Int || this.query('count_objects')), version: this.version,
      indexed: objects.filter(o => o.vector.length && !o.archived).length, engine: 'Ink', core: metadata.core_sha256, source: 'world.ink' };
    return {...this.statsCache};
  }
  publicObject(object) { const { vector, ...rest } = object; return rest; }
  desktopAll() { return this.publicAll().filter(o=>!(o.namespace==='os'&&['release','collaboration','os.version'].includes(o.kind))&&!(o.kind==='file'&&o.tags.includes('app-artifact'))&&!(o.kind==='file'&&o.tags.includes('app-source')&&(()=>{try{return JSON.parse(o.body).mime==='application/vnd.ink-os.bundle+json';}catch{return false;}})())); }
  publicAll() { return this.all().filter(o => !o.archived).map(o => this.publicObject(o)); }
}

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export const blobDigest=location=>String(location||'').match(/(?:blob:|\/objects\/)([a-f0-9]{64})$/)?.[1];
