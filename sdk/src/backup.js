// Local owner tooling only: recovery requires a stopped host; live capture
// requires the same host's bound admission adapter, not a filesystem-only lock.
export { createStoppedBackup, recoverBackup, assertOfflineInstance } from '../../server/backup-recovery.mjs';
export { SnapshotGate, createLiveBackup } from '../../server/snapshot-gate.mjs';
