import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { filesFrom, desktopFromManifest, boundedReleasePaths } from '../cli/bin/ink-os.mjs';
import { commandAssets } from '../cli/bin/command-assets.mjs';
import { validateBundle } from '../server/platform.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = resolve(process.argv[2] || join(root, '..'));
const target = join(root, 'default-apps');
const prior = JSON.parse(await readFile(join(target, 'lock.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"version":1,"apps":[]}'; throw error; }));
const apps = [];
await mkdir(target, { recursive: true });
for (const slug of ['finder', 'preview', 'ink-environment']) {
  const directory = join(sources, 'ink-app-' + slug);
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain'])) throw Error('Commit default app source before bundling: ' + slug);
  const commit = git(['rev-parse', 'HEAD']);
  const manifest = JSON.parse(await readFile(join(directory, 'ink-app.json'), 'utf8'));
  const pinned = prior.apps.find(app => app.slug === slug);
  if (pinned && (pinned.commit !== commit || pinned.repository !== manifest.repository)) throw Error('Update the reviewed default-apps/lock.json source pin first: ' + slug);
  const { assetDirectory } = await boundedReleasePaths(manifest, directory);
  const commands = await commandAssets(manifest, directory);
  const files = await filesFrom(assetDirectory);
  for (const file of files) if (commands.transform && file.path === commands.transformPath) file.base64 = Buffer.from(await commands.transform(file.path, Buffer.from(file.base64, 'base64'))).toString('base64');
  for (const [path, bytes] of commands.extraFiles) {
    const existing = files.find(file => file.path === path);
    if (existing) existing.base64 = bytes.toString('base64');
    else files.push({ path, base64: bytes.toString('base64') });
  }
  const bundle = validateBundle({ files, entry: manifest.entry, commands: manifest.commands, desktop: await desktopFromManifest(manifest, directory), capabilities: manifest.capabilities, source: { repository: manifest.repository, commit } });
  const bytes = Buffer.from(JSON.stringify(bundle) + '\n');
  await writeFile(join(target, slug + '.json'), bytes);
  apps.push({ slug, title: manifest.title, repository: manifest.repository, commit, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(target, 'lock.json'), JSON.stringify({ version: 1, apps }, null, 2) + '\n');
console.log('Bundled Finder, Preview and Ink Environment from exact public source commits.');
