/** Transport-neutral typed Ink interface sessions. */
export function createInkUi(request) {
  return Object.freeze({
    open: (options = {}) => request('open', options),
    refresh: (id, input) => request('refresh', { id, ...input }),
    watch: (id, input) => request('watch', { id, ...input }),
    event: (id, input) => request('event', { id, ...input }),
    dispose: (id) => request('dispose', { id }),
  });
}
