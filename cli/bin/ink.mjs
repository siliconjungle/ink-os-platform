import { mkdir, readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, sep, basename } from 'node:path';
import { Projects } from '../../server/projects.mjs';
import { buildInkApp } from '../../server/ink-apps.mjs';
import { parseEnv } from 'node:util';
import { sourceFiles } from '../../shared/source-files.mjs';
import { inkModuleGraph } from '../../shared/ink-app.mjs';
import{prepareProjectSnapshot}from'./project-checkout.mjs';

async function manifestFrom(files, manifestName='ink-app.json') {
  const file = files.find(file => file.path === manifestName);
  if (!file) throw Error('The source needs '+manifestName+'.');
  return JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8'));
}

export async function committedSource(directory, revision, manifestName='ink-app.json') {
  directory = await realpath(directory);
  const projects = new Projects(directory);
  const root = await projects.git(directory, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== directory) throw Error('Deploy from the root of the application Git repository.');
  if (await projects.git(directory, ['status', '--porcelain', '--untracked-files=all'])) throw Error('Commit source changes before deployment.');
  const commit = revision || await projects.git(directory, ['rev-parse', 'HEAD']);
  projects.records.local = { directory };
  const files = await projects.files('local', commit);
  const tree = await projects.git(directory, ['rev-parse', commit + '^{tree}']);
  return { files, commit, tree, manifest: await manifestFrom(files,manifestName) };
}

export async function initInk(directory, options = {}) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw Error('Create an Ink app in an empty directory.');
  const slug = options.slug || basename(directory).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(slug)) throw Error('Use --slug with 2–40 lowercase letters, digits or hyphens.');
  const title = options.title || 'My app';
  const manifest = { slug, title, language: 'ink', source: 'main.ink', ui: { entry: 'view' }, exports: ['add', 'total'], desktop: { entry: 'app', icon: 'code', collaborative: true } };
  await writeFile(join(directory, 'ink-app.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, 'main.ink'), await readFile(new URL('../templates/main.ink', import.meta.url)));
  await writeFile(join(directory, '.gitignore'), '.ink/\n.env\n.env.*\n!.env.example\nnode_modules\n.DS_Store\n');
  await writeFile(join(directory, 'ink-project.json'), JSON.stringify({ branch: 'main', source: { provider: 'local' }, target: 'local' }, null, 2) + '\n');
  await writeFile(join(directory, 'storage-retention.json'), JSON.stringify({ keep: { '.git': 'Application source history.', 'storage-retention.json': 'Source and generated-output retention policy.', 'main.ink': 'Application source.', 'ink-app.json': 'Application manifest.', 'ink-project.json': 'Project source settings.', '.gitignore': 'Local output and credential exclusions.' }, safe_to_remove: {} }, null, 2) + '\n');
  const projects = new Projects(directory);
  await projects.git(directory, ['init', '-b', 'main']);
  await projects.git(directory, ['add', '--', 'main.ink', 'ink-app.json', 'ink-project.json', '.gitignore', 'storage-retention.json']);
  await projects.git(directory, ['-c', 'user.name=Ink OS', '-c', 'user.email=ink-os@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(directory, '.git', 'no-hooks'), 'commit', '-m', 'Create Ink application']);
  return { directory, slug, commit: await projects.git(directory, ['rev-parse', 'HEAD']) };
}

export async function buildInk(directory, options = {}) {
  directory = await realpath(resolve(directory));
  const manifest = JSON.parse(await readFile(join(directory, 'ink-app.json'), 'utf8'));
  const names = new Set(manifest.modules !== undefined ? inkModuleGraph(manifest.modules).modules.map(module => module.path) : [manifest.source || 'main.ink']);
  const icon = manifest.desktop?.icon;
  if (typeof icon === 'string' && /\.svg$/i.test(icon)) names.add(icon);
  if (typeof icon?.svg === 'string' && !icon.svg.trim().startsWith('<')) names.add(icon.svg);
  const files = [];
  for (const name of names) {
    sourceFiles([{ path: name, base64: '' }]);
    const path = resolve(directory, name), inside = relative(directory, await realpath(path));
    if (inside === '..' || inside.startsWith('..' + sep) || (await lstat(path)).isSymbolicLink()) throw Error('App source must be inside the application directory.');
    const bytes = await readFile(path);
    if (bytes.length > 128 * 1024) throw Error('Ink source and icons must each be at most 128 KiB.');
    files.push({ path: name, base64: bytes.toString('base64') });
  }
  const bundle = await buildInkApp(manifest, files);
  const output = resolve(options.output || join(directory, '.ink', 'build.json'));
  await mkdir(join(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(bundle), { mode: 0o600 });
  return { output, commands: bundle.commands.map(command => command.id), bytes: bundle.files.reduce((size, file) => size + Buffer.byteLength(file.base64, 'base64'), 0) };
}

export async function deployInk(directory, options, request,target) {
  const snapshot = await committedSource(directory, options.commit), manifest = snapshot.manifest;
  let app = options.app ? (await request('apps/' + options.app + '/status')).app : (await request('apps')).find(app => JSON.parse(app.body).slug === manifest.slug);
  const projectId = app && JSON.parse(app.body).projectId;
  const settingsFile = snapshot.files.find(file => file.path === 'ink-project.json');
  const settings = settingsFile && JSON.parse(Buffer.from(settingsFile.base64, 'base64').toString('utf8'));
  const checkout=await prepareProjectSnapshot({directory,snapshot,projectId,request,target});
  const project = await request(projectId ? 'projects/' + projectId + '/snapshot' : 'projects/import', 'POST', { title: manifest.title, files: snapshot.files, originCommit: snapshot.commit, tree: snapshot.tree,expectedCommit:checkout.expectedCommit, ...(settings ? { settings } : {}) });await checkout.complete(project);
  if (!app) app = await request('apps', 'POST', { slug: manifest.slug, title: manifest.title, projectId: project.id, sourceCommit: project.commit });
  if (options['env-file']) {
    const text = await readFile(resolve(options['env-file']), 'utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw Error('Environment input exceeds 256 KiB.');
    await request('apps/' + app.id + '/env', 'PUT', { values: parseEnv(text) });
  }
  const release = await request('apps/' + app.id + '/build', 'POST', { projectId: project.id, commit: project.commit });
  if (options['preview-only']) return { appId: app.id, projectId: project.id, releaseId: release.id, status: 'ready' };
  const published = await request('apps/' + app.id + '/releases/' + release.id + '/publish', 'POST', {});
  return { appId: app.id, projectId: project.id, releaseId: release.id, url: JSON.parse(published.body).url };
}

export async function previewInkCLI(action,value,entry,options,request,target){
 if(action==='preview'){
  const snapshot=await committedSource(resolve(value||'.'),options.commit),preview=await request('ink/previews','POST',{files:snapshot.files,tree:snapshot.tree,originCommit:snapshot.commit});
  return{...preview,...(target?.origin?{url:new URL(preview.url,target.origin).href}:{}),...(options.entry?{result:await request('ink/previews/'+preview.id+'/run','POST',{entry:options.entry,input:options.input??'[]',backend:options.backend??'javascript'})}:{})};
 }
 if(!/^[a-f0-9]{32}$/.test(value||''))throw Error('Select a preview ID');const path='ink/previews/'+value;
 if(action==='preview-status')return request(path);
 if(action==='preview-close')return request(path,'DELETE');
 if(action==='preview-run'){if(!entry&&!options.entry)throw Error('Select a preview entry');return request(path+'/run','POST',{entry:entry||options.entry,input:options.input??'[]',backend:options.backend??'javascript'});}
 throw Error('Unknown Ink preview command');
}
