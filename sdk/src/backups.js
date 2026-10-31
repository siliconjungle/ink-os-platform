const operation = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw Error('Provide a backup operation ID.');
  return 'backups/' + value;
};

/** Consume chunks completely to verify the encrypted archive digest. Restore
 * separately authenticates the complete archive with its encryption password. */
export function createBackups({ request, download }) {
  return Object.freeze({
    list: () => request('backups'),
    create: input => request('backups', { method: 'POST', body: input }),
    get: id => request(operation(id)),
    cancel: id => request(operation(id) + '/cancel', { method: 'POST', body: {} }),
    delete: id => request(operation(id), { method: 'DELETE' }),
    download: async (id, { signal } = {}) => {
      const path = operation(id), job = await request(path, { signal });
      if (job.status !== 'ready' || !/^[a-f0-9]{64}$/.test(job.sha256) || !Number.isSafeInteger(job.bytes) || job.bytes < 52) throw Error('Backup is not ready or its receipt is invalid.');
      const response = await download(path + '/download', { signal });
      if (response.status !== 200 || response.headers.get('content-length') !== String(job.bytes) || response.headers.get('x-ink-backup-sha256') !== job.sha256 || !response.body) { await response.body?.cancel(); throw Error('Backup download does not match its committed receipt.'); }
      async function* chunks() {
        const { createHash } = await import('node:crypto'), digest = createHash('sha256'); let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length; if (size > job.bytes) throw Error('Backup download exceeds its receipt.');
          digest.update(chunk); yield chunk;
        }
        if (size !== job.bytes || digest.digest('hex') !== job.sha256) throw Error('Backup download is incomplete or corrupt.');
      }
      return Object.freeze({ id, bytes: job.bytes, sha256: job.sha256, chunks: chunks(), cancel: () => response.body.cancel().catch(() => {}) });
    },
  });
}
