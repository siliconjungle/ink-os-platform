import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function projectCLI({ sub, id, options, request, print }) {
  const settings = async () => options.file ? JSON.parse(await readFile(resolve(String(options.file)), 'utf8')) : {};
  if (sub === 'create') return print(await request('projects', 'POST', { title: options.title || id || 'Project', ...await settings(), ...(options.directory ? { directory: resolve(String(options.directory)) } : {}), ...(options.remote ? { source: { provider: 'local', remote: options.remote } } : {}) }));
  if (!sub || sub === 'list') return print(await request('projects'));
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw Error('Provide a project ID.');
  const base = 'projects/' + id;
  if (sub === 'configure') {
    if (!options.file) throw Error('Provide --file with project settings.');
    return print(await request(base, 'PATCH', await settings()));
  }
  if (sub === 'duplicate') return print(await request(base + '/duplicate', 'POST', { ...await settings(), ...(options.title ? { title: options.title } : {}) }));
  if (sub === 'show' || sub === 'status' || sub === 'publication') return print(await request(base + (sub === 'show' ? '' : '/' + sub)));
  if (sub === 'publish') return print(await request(base + '/publish', 'POST', { create: options.create === true, ...(options.commit ? { commit: options.commit } : {}), ...(options['expected-remote'] ? { expectedRemote: options['expected-remote'] } : {}) }));
  if (sub === 'credentials') {
    if (options.token !== undefined) throw Error('Pass credentials using --stdin or --from-env NAME, never a command argument.');
    if ([options.clear, options.stdin, options['from-env']].filter(Boolean).length > 1) throw Error('Use one of --stdin, --from-env NAME or --clear.');
    if (options.clear) return print(await request(base + '/credentials', 'DELETE'));
    if (options.stdin || options['from-env']) {
      let token;
      if (options.stdin) {
        if (process.stdin.isTTY) throw Error('Pipe a token to stdin.');
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 8192) throw Error('Credential input is too large.'); chunks.push(chunk); }
        token = Buffer.concat(chunks).toString('utf8').trim();
      } else token = process.env[String(options['from-env'])];
      return print(await request(base + '/credentials', 'PUT', { token }));
    }
    return print(await request(base + '/credentials'));
  }
  throw Error('Use projects list, create, show, status, configure, duplicate, credentials, publication or publish.');
}
