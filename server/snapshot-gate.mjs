import { resolve } from 'node:path';
import { waitForQuiescence } from './quiescence.mjs';
import { createBackup } from './backup-store.mjs';
import { backupAssetClosure } from './backup-assets.mjs';

const fail = (status, message) => { throw Object.assign(Error(message), { status }); };

/** One in-process reader owns the complete host admission barrier. Process exit
 * interrupts that reader; no stale barrier grants a new process a snapshot.
 * The host must bind HTTP, WebSocket and local-app admission to closed, exclude
 * its control requests from activity, and mutually exclude upgrades/shutdown.
 * Existing work drains or acquisition fails. The runtime pool may release only
 * verified idle workers through its normal lifecycle before returning a proof.
 */
export class SnapshotGate {
  constructor({ directory, adapter, otherClosed, pollMs = 500 } = {}) {
    if (!directory || !adapter || typeof otherClosed !== 'function' || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60000) throw Error('Provide snapshot storage, a host adapter and exclusive admission binding.');
    for (const name of ['closeAdmission', 'resumeAdmission', 'continueDraining', 'activity', 'quiesceSnapshot', 'flush']) if (typeof adapter[name] !== 'function') throw Error('Missing snapshot host adapter: ' + name);
    Object.assign(this, { directory: resolve(directory), adapter, otherClosed, pollMs, closed: false, active: null });
  }
  inspect() { return { closed: this.closed, phase: this.active?.phase || 'idle' }; }
  async acquireSnapshot({ signal, timeoutMs = 300000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) fail(400, 'Snapshot timeout must be 1–3600000 milliseconds.');
    const busy = this.otherClosed();
    if (typeof busy !== 'boolean') fail(503, 'The other host admission gates could not be verified.');
    if (busy || this.active) fail(409, 'Another snapshot, upgrade or shutdown owns host admission.');
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    signal.throwIfAborted();
    const lease = { phase: 'draining', released: false, poolClosed: false };
    this.active = lease; this.closed = true;
    const release = async () => {
      if (lease.released) return;
      if (this.active !== lease) fail(409, 'This snapshot no longer owns host admission.');
      // resumeAdmission is synchronous, matching the shared host adapter. No
      // request can run between reopening this gate and resuming its queues.
      this.closed = false;
      try {
        const result = this.adapter.resumeAdmission();
        if (result?.then) throw Error('Snapshot admission resume must be synchronous.');
      } catch (error) {
        this.closed = true;
        this.adapter.closeAdmission({ poolClosed: lease.poolClosed });
        throw error;
      }
      lease.released = true; this.active = null;
    };
    try {
      const result = this.adapter.closeAdmission({ poolClosed: false });
      if (result?.then) throw Error('Snapshot admission closure must be synchronous.');
      await waitForQuiescence({ adapter: this.adapter, signal, pollMs: this.pollMs,
        checkOwnership: () => { if (this.otherClosed() !== false) fail(409, 'Another host admission gate changed during snapshot acquisition.'); },
        onPoolAdmission: closed => { lease.poolClosed = closed; },
      });
      lease.phase = 'reading';
      return { directory: this.directory, consistency: 'quiesced', coverage: { remoteAssets: false, externalProjects: false, externalSecrets: false }, release };
    } catch (error) {
      try { await release(); } catch (releaseError) { throw new AggregateError([error, releaseError], 'Snapshot acquisition failed and admission needs recovery.'); }
      throw error;
    }
  }
}

/** Encrypted local-tree capture with a real bound host gate. Remote asset and
 * external-project coverage is deliberately reported separately by the archive.
 */
export function createLiveBackup({ gate, directory = gate?.directory, archive, password, limits, signal, timeoutMs, world, storage, remoteAssets = false, assetLimits, excludeBackupDirectory = false } = {}) {
  if (!(gate instanceof SnapshotGate) || !directory || resolve(directory) !== gate.directory) throw Error('Bind this backup to the same instance as its snapshot gate.');
  if ((typeof password !== 'string' && !Buffer.isBuffer(password)) || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 4096) throw Error('Backup password must contain 12–4096 bytes');
  if (typeof remoteAssets !== 'boolean' || remoteAssets && (!world || !storage || resolve(world.directory) !== gate.directory || resolve(storage.directory) !== gate.directory)) throw Error('Remote asset capture requires the same instance World and current storage.');
  if (typeof excludeBackupDirectory !== 'boolean') throw Error('Choose whether this host owns an excluded backup directory.');
  return createBackup({ directory, archive, password, limits, signal, acquireSnapshot: async () => {
    const snapshot = await gate.acquireSnapshot({ signal, timeoutMs });
    try {
      const closure = remoteAssets ? backupAssetClosure({ world, storage, directory, limits: assetLimits }) : null;
      return { ...snapshot, ...(closure || {}), excludeBackupDirectory, coverage: { ...snapshot.coverage, ...closure?.coverage } };
    } catch (error) { await snapshot.release(); throw error; }
  } });
}
