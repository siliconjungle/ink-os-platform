import { open, readlink, realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile), FORMAT = 'ink-os-process-receipt-v1';
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const validPID = pid => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
const providers = { linux: 'linux-proc-start-v1', darwin: 'darwin-libproc-start-v1' };
const unknown = reason => ({ state: 'unverified', reason, preserveWorker: true, verified: false });
const gone = () => ({ state: 'gone', preserveWorker: false, verified: true });
const toolEnvironment = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

async function smallText(path, maxBytes = 65536) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(maxBytes + 1); let size = 0;
    while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > maxBytes) throw Error('Probe output exceeded bound');
    return bytes.subarray(0, size).toString('utf8');
  } finally { await file.close(); }
}
function numericLiveness(pid) {
  if (!validPID(pid)) return unknown('missing-process-identity');
  try { process.kill(pid, 0); return unknown('numeric-pid-only'); }
  catch (error) { return error.code === 'ESRCH' ? gone() : unknown('process-access-unavailable'); }
}
function linuxStat(text, expectedPID) {
  const boundary = text.lastIndexOf(') '), first = text.indexOf(' (');
  if (boundary < 0 || first < 0 || Number(text.slice(0, first)) !== expectedPID) throw Error('Invalid proc identity');
  const fields = text.slice(boundary + 2).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[1] || '') || !/^\d+$/.test(fields[19] || '')) throw Error('Invalid proc start identity');
  return { parentPID: Number(fields[1]), start: fields[19], exited: ['Z', 'X', 'x'].includes(fields[0]) };
}
async function linuxProcess(pid) {
  try { return { state: 'observed', ...linuxStat(await smallText('/proc/' + pid + '/stat'), pid) }; }
  catch { return numericLiveness(pid); }
}

// Apple's public proc_bsdinfo is 136 bytes on little-endian macOS arm64/x64;
// pbi_start_tvsec/usec are uint64 at offsets 120/128, pid/ppid at 12/16.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
// Read only these numeric fields. No process command, environment, name or path
// leaves libproc. Ruby/Fiddle is an optional existing system bridge, never an
// installed dependency, and is invoked only for worker receipt probes.
const darwinScript = `
require 'fiddle'
require 'json'
pid = Integer(ARGV.fetch(0), 10)
lib = Fiddle.dlopen('/usr/lib/libproc.dylib')
fn = Fiddle::Function.new(lib['proc_pidinfo'], [Fiddle::TYPE_INT, Fiddle::TYPE_INT, Fiddle::TYPE_LONG_LONG, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT], Fiddle::TYPE_INT)
buffer = Fiddle::Pointer.malloc(136)
count = fn.call(pid, 3, 0, buffer, 136)
if count != 136
  puts JSON.generate({count: count, errno: Fiddle.last_error})
else
  bytes = buffer.to_s(136)
  puts JSON.generate({count: count, pid: bytes[12,4].unpack('L<')[0], parentPID: bytes[16,4].unpack('L<')[0], status: bytes[4,4].unpack('L<')[0], sec: bytes[120,8].unpack('Q<')[0].to_s, usec: bytes[128,8].unpack('Q<')[0].to_s})
end
`;
async function darwinProcess(pid) {
  if (!['arm64', 'x64'].includes(process.arch)) return unknown('unsupported-darwin-architecture');
  try { await access('/usr/bin/ruby', constants.X_OK); } catch { return unknown('darwin-system-bridge-unavailable'); }
  try {
    const { stdout } = await execute('/usr/bin/ruby', ['--disable-gems', '-e', darwinScript, String(pid)], { env: toolEnvironment, timeout: 3000, maxBuffer: 4096, encoding: 'utf8' });
    const value = JSON.parse(stdout);
    if (value.count !== 136) return value.errno === 3 ? numericLiveness(pid) : unknown('darwin-process-access-unavailable');
    if (value.pid !== pid || !validPID(value.parentPID) || !Number.isInteger(value.status) || !/^[1-9]\d{0,15}$/.test(value.sec) || !/^\d{1,6}$/.test(value.usec) || Number(value.usec) >= 1_000_000) return unknown('darwin-probe-layout-unverified');
    return { state: 'observed', parentPID: value.parentPID, start: value.sec + ':' + value.usec, exited: value.status === 5 };
  } catch { return unknown('darwin-system-bridge-unavailable'); }
}
async function processObservation(pid) {
  if (process.platform === 'linux') return linuxProcess(pid);
  if (process.platform === 'darwin') return darwinProcess(pid);
  return unknown('unsupported-platform');
}

/** Opaque context survives host-app restarts, but changes after OS boot, PID
 * namespace change, root relocation or replacement of the root directory.
 * No machine serial, hostname, environment, command or raw path is returned. */
export async function processReceiptContext({ directory } = {}) {
  try {
    const canonical = await realpath(directory), root = await stat(canonical, { bigint: true });
    if (!root.isDirectory()) return unknown('execution-root-unavailable');
    const scopeHash = hash('ink-os-process-scope-v1', canonical, root.dev.toString(), root.ino.toString());
    let boot, namespace = '';
    if (process.platform === 'linux') {
      // A host-mounted /proc with another PID namespace must not identify a
      // process merely because its numeric PID happens to match our child.
      linuxStat(await smallText('/proc/self/stat'), process.pid);
      boot = (await smallText('/proc/sys/kernel/random/boot_id', 128)).trim();
      namespace = await readlink('/proc/self/ns/pid');
      if (!/^pid:\[\d+\]$/.test(namespace)) return unknown('linux-pid-namespace-unavailable');
    } else if (process.platform === 'darwin') {
      boot = (await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { env: toolEnvironment, timeout: 1500, maxBuffer: 1024, encoding: 'utf8' })).stdout.trim();
    } else return unknown('unsupported-platform');
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(boot)) return unknown('kernel-boot-identity-unavailable');
    return { state: 'verified-context', verified: true, platform: process.platform, provider: providers[process.platform], hostHash: hash('ink-os-process-host-v1', process.platform, boot.toLowerCase(), namespace), scopeHash };
  } catch { return unknown('host-or-execution-context-unavailable'); }
}
function childGone(child) { return child && (child.exitCode !== null || child.signalCode !== null); }

/** Capture inside onProcess. Passing the actual ChildProcess (transient only)
 * closes the spawn/capture exit window; otherwise the current parent PID must
 * still own the observed process. Never persist the ChildProcess object.
 * Kernel observations are sampled twice. Capture failures return unverified;
 * they do not authorize stopping or replacing an ambiguous worker. */
export async function captureProcessReceipt({ pid, directory, child } = {}) {
  if (!validPID(pid)) return unknown('invalid-pid');
  if (child && (!(child instanceof ChildProcess) || child.pid !== pid)) return unknown('child-handle-pid-mismatch');
  if (childGone(child)) return gone();
  const context = await processReceiptContext({ directory });
  if (!context.verified) return context;
  const first = await processObservation(pid);
  if (first.state !== 'observed') return first;
  if (first.exited) return gone();
  if (first.parentPID !== process.pid) return unknown('process-is-not-owned-child');
  const second = await processObservation(pid);
  if (second.state !== 'observed') return second;
  if (second.exited || childGone(child)) return gone();
  if (first.start !== second.start || second.parentPID !== process.pid) return unknown('process-changed-during-capture');
  const after = await processReceiptContext({ directory });
  if (!after.verified || after.hostHash !== context.hostHash || after.scopeHash !== context.scopeHash) return unknown('context-changed-during-capture');
  return { state: 'captured', verified: true, preserveWorker: true, receipt: { format: FORMAT, pid, platform: context.platform, provider: context.provider, hostHash: context.hostHash, scopeHash: context.scopeHash, startHash: hash('ink-os-process-start-v1', context.provider, pid, first.start) } };
}
function validReceipt(receipt) {
  return receipt && receipt.format === FORMAT && validPID(receipt.pid) && Object.hasOwn(providers, receipt.platform) && providers[receipt.platform] === receipt.provider && ['hostHash', 'scopeHash', 'startHash'].every(name => typeof receipt[name] === 'string' && /^[a-f0-9]{64}$/.test(receipt[name]));
}

/** Check only, never signal a worker except optional signal-0 existence checks.
 * same-process means the original kernel start identity is still observed.
 * foreign-scope means this receipt cannot govern this execution root; its
 * original process may remain live elsewhere and must not be disturbed.
 * Legacy/unreadable live PIDs remain unverified: quarantine/report that job
 * instead of indefinitely polling or treating it as safe to overwrite. */
export async function checkProcessReceipt(receipt, { directory, pid } = {}) {
  if (!receipt) return numericLiveness(pid);
  if (!validReceipt(receipt)) return unknown('invalid-process-receipt');
  if (pid !== undefined && pid !== receipt.pid) return unknown('receipt-pid-mismatch');
  const foreign = reason => ({ state: 'foreign-scope', reason, verified: true, preserveWorker: true, blocksCurrentRoot: false });
  if (receipt.platform !== process.platform) return foreign('different-platform');
  const context = await processReceiptContext({ directory });
  if (!context.verified) return context;
  if (receipt.hostHash !== context.hostHash) return foreign('different-host-boot-or-pid-namespace');
  if (receipt.scopeHash !== context.scopeHash) return foreign('different-execution-root');
  const first = await processObservation(receipt.pid);
  if (first.state !== 'observed') return first;
  if (first.exited) return gone();
  const second = await processObservation(receipt.pid);
  if (second.state !== 'observed') return second;
  if (second.exited) return gone();
  if (first.start !== second.start) return unknown('process-changed-during-check');
  const after = await processReceiptContext({ directory });
  if (!after.verified || after.hostHash !== context.hostHash || after.scopeHash !== context.scopeHash) return unknown('context-changed-during-check');
  if (hash('ink-os-process-start-v1', receipt.provider, receipt.pid, first.start) !== receipt.startHash) return { state: 'different-process', verified: true, preserveWorker: true, blocksCurrentRoot: false };
  return { state: 'same-process', verified: true, preserveWorker: true, blocksCurrentRoot: true };
}
