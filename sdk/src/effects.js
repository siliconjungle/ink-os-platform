/** Retain this ID across transport retries; expired IDs cannot execute again. */
export function effectRequestId() {
  return Date.now() + ':' + globalThis.crypto.randomUUID();
}

/** Transport-neutral, durable typed Ink protocol runs. */
export function createEffects(request) {
  return Object.freeze({
    start: (entry, input = '[]', options = {}) =>
      request('start', {
        entry,
        input,
        requestId: effectRequestId(),
        ...options,
      }),
    get: (id) => request('get', { id }),
    cancel: (id) => request('cancel', { id }),
  });
}
