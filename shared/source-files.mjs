import { posix } from 'node:path';

export function sourceFiles(input, { maxBytes = 24 * 1024 * 1024 } = {}) {
  if (!Array.isArray(input) || !input.length || input.length > 5000) throw Object.assign(Error('Provide 1–5000 source files.'), { status: 400 });
  const paths = new Set(); let bytes = 0;
  return input.map(file => {
    const path = file?.path;
    if (typeof path !== 'string' || path.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(path) || path !== posix.normalize(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part.toLowerCase() === '.git' || /^(?:node_modules|\.data|\.local)$/i.test(part) || /^\.(?:env|dev\.vars|npmrc)(?:\.|$)/i.test(part) && part !== '.env.example')) throw Object.assign(Error('Unsafe source file path.'), { status: 400 });
    const key = path.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw Object.assign(Error('Duplicate or case-conflicting source path.'), { status: 400 });
    paths.add(key);
    if (typeof file.base64 !== 'string' || Buffer.from(file.base64, 'base64').toString('base64') !== file.base64) throw Object.assign(Error('Source bytes must be canonical base64.'), { status: 400 });
    bytes += Buffer.byteLength(file.base64, 'base64');
    if (bytes > maxBytes) throw Object.assign(Error('Source snapshot exceeds 24 MiB.'), { status: 413 });
    const mode = file.mode || '100644';
    if (!['100644', '100755'].includes(mode)) throw Object.assign(Error('Source snapshots contain regular files only; resolve symlinks and submodules explicitly.'), { status: 400 });
    return { path, base64: file.base64, mode };
  }).sort((a, b) => a.path.localeCompare(b.path)).map(file => {
    const parts = file.path.normalize('NFC').toLowerCase().split('/');
    for (let index = 1; index < parts.length; index++) if (paths.has(parts.slice(0, index).join('/'))) throw Object.assign(Error('A source file cannot also be a directory.'), { status: 400 });
    return file;
  });
}

export function sourceIdentity(value) {
  if (!value) return undefined;
  if (!/^[a-f0-9]{40}$/.test(value.commit || '')) throw Object.assign(Error('Source requires a full commit SHA.'), { status: 400 });
  if (value.originCommit && !/^[a-f0-9]{40}$/.test(value.originCommit)) throw Object.assign(Error('Source requires a full original commit SHA.'), { status: 400 });
  if (value.projectId) {
    if (!/^[a-f0-9]{32}$/.test(value.projectId)) throw Object.assign(Error('Invalid source project identity.'), { status: 400 });
    return { provider: 'local', projectId: value.projectId, commit: value.commit, ...(value.originCommit ? { originCommit: value.originCommit } : {}) };
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value.repository || '')) throw Object.assign(Error('Source requires a project or GitHub repository.'), { status: 400 });
  return { provider: 'github', repository: value.repository, commit: value.commit };
}
