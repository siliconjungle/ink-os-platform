import { readFile, writeFile, rename, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function save(path, value) {
  await writeFile(path + '.next', JSON.stringify(value), { mode: 0o600, flush: true });
  await rename(path + '.next', path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// Install only on a new World. A private journal makes interrupted first starts
// resumable without reinstalling apps that an owner later updates or removes.
export async function installDefaultApps(platform, { fresh, enabled = true } = {}) {
  const path = join(platform.directory, 'default-apps.json');
  let journal;
  try { journal = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (journal && (journal.version !== 1 || !['installing', 'complete', 'skipped'].includes(journal.status))) throw Error('Invalid default app installation journal');
  if (journal?.status === 'complete' || journal?.status === 'skipped') return;
  if (!journal && (!fresh || !enabled)) {
    await save(path, { version: 1, status: 'skipped', reason: !fresh ? 'existing-instance' : 'disabled' });
    return;
  }
  const lock = JSON.parse(await readFile(join(platform.root, 'default-apps', 'lock.json'), 'utf8'));
  if (lock.version !== 1 || lock.apps.length !== 3 || lock.apps.map(app => app.slug).sort().join(',') !== 'finder,ink-environment,preview') throw Error('Invalid default app distribution');
  const identity = digest(JSON.stringify(lock));
  if (journal && journal.identity !== identity) throw Error('Resume initial default app installation with the same distribution');
  journal ||= { version: 1, status: 'installing', identity, apps: {} };
  await save(path, journal);
  for (const item of lock.apps) {
    if (!/^[a-z-]+$/.test(item.slug) || !/^[a-f0-9]{40}$/.test(item.commit) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid default app source identity');
    const bytes = await readFile(join(platform.root, 'default-apps', item.slug + '.json'));
    if (digest(bytes) !== item.sha256) throw Error('Default app bundle integrity check failed: ' + item.slug);
    const bundle = JSON.parse(bytes);
    if (bundle.source?.repository !== item.repository || bundle.source?.commit !== item.commit || bundle.backend) throw Error('Invalid default app bundle');
    let app = platform.apps({ includeArchived: true }).find(app => JSON.parse(app.body).slug === item.slug);
    if (!app) app = await platform.createApp({ slug: item.slug, title: item.title, desktop: bundle.desktop, commands: bundle.commands, capabilities: bundle.capabilities });
    const saved = journal.apps[item.slug];
    if ((saved && saved.appId !== app.id) || app.archived) throw Error('Default app installation identity changed');
    if (saved?.complete) continue;
    if (JSON.parse(app.body).releaseId && !saved?.releaseId) throw Error('An unrelated release occupies a default app slot');
    journal.apps[item.slug] ||= { appId: app.id };
    await save(path, journal);
    const release = await platform.createRelease(app.id, bundle);
    journal.apps[item.slug].releaseId = release.id;
    await save(path, journal);
    await platform.publish(app.id, release.id);
    journal.apps[item.slug].complete = true;
    await save(path, journal);
  }
  journal.status = 'complete';
  await save(path, journal);
}
