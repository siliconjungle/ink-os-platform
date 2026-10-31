import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.');
const excluded = new Set(['.git', 'node_modules', 'dist', '.data', '.local', 'target', 'release', 'coverage']);
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub credential', /\bgh[pousr]_[A-Za-z0-9_]{25,}\b|\bgithub_pat_[A-Za-z0-9_]{25,}\b/],
  ['provider credential', /\b(?:sk-proj-|sk-ant-|r8_)[A-Za-z0-9_-]{25,}\b|\bAKIA[A-Z0-9]{16}\b/],
  ['Fly credential', /\bFlyV1\s+[A-Za-z0-9_-]{30,}/],
  ['hardcoded infrastructure', /https?:\/\/[a-z0-9-]+\.fly\.dev|registry\.fly\.io\/[a-z0-9_-]+|\/Users\/[^/]+\//i],
];
const errors = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = resolve(directory, entry.name), name = relative(root, path);
    if (entry.isSymbolicLink()) { errors.push(name + ': symlink must not enter a release'); continue; }
    if (entry.isDirectory()) { await visit(path); continue; }
    if (/^(?:\.env(?:\..*)?|auth\.json|credentials\.json|owner\.json)$/.test(entry.name) && entry.name !== '.env.example') errors.push(name + ': credential file');
    const bytes = await readFile(path), source = bytes.toString('utf8');
    for (const [label, pattern] of rules) if (pattern.test(source)) errors.push(name + ': ' + label);
  }
}
await visit(root);
try {
  const index = execFileSync('git', ['-C', root, 'ls-files', '-s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const line of index.split('\n')) if (line.startsWith('120000 ')) errors.push(line.split('\t')[1] + ': tracked symlink');
} catch {}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Source audit passed.');
