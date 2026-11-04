import { createDomUi } from './ui-dom.js';
export { createDomUi } from './ui-dom.js';
export { createInkUi } from './ui-client.js';
export {
  createUiModel,
  validateUiTree,
  diffUiTree,
  UI_FORMAT,
  UI_KINDS,
} from './ui-model.js';
/** A serialized, bounded event lane; keystrokes update their local controls first. */
export async function mountInkUi({
  element,
  transport,
  subscribe = () => () => {},
  onError = () => {},
  onStatus = () => {},
  onLifecycle = () => {},
  onTrace,
}) {
  let closed = false,
    hidden = false,
    frame,
    sequence = 0,
    tail = Promise.resolve(),
    dirty = false,
    timer,
    heartbeat,
    pending = null,
    draining = false,
    drainScheduled = false,
    watching = false,
    live = false,
    watchWake,
    watchStopped = false;
  // Optional local timing observer. Observer failures cannot alter interaction.
  const trace = (name, start, detail = {}) => {
    if (!onTrace) return;
    try {
      onTrace({ name, start, end: performance.now(), detail });
    } catch {}
  };
  const queue = [];
  const renderer = createDomUi(element, { onEvent: enqueue, onLifecycle });
  function serial(run) {
    const queued = onTrace ? performance.now() : 0;
    const task = tail
      .catch(() => {})
      .then(() => {
        trace('ui.queue', queued);
        return run();
      });
    tail = task;
    task.catch((error) => {
      if (!closed) onError(error);
    });
    return task;
  }
  function apply(value) {
    if (closed) return;
    const started = onTrace ? performance.now() : 0;
    if (
      value.updates &&
      (!/^[a-f0-9]{32}$/.test(value.updates.stream || '') ||
        !Number.isSafeInteger(value.updates.sequence) ||
        value.updates.sequence < 0)
    )
      throw Error('Invalid interface delivery cursor');
    if (!frame || value.id !== frame.id) {
      renderer.rebase(value);
      sequence = 0;
    } else if (value.updates?.reset && value.tree) {
      renderer.rebase({ ...value, baseRevision: 0 });
    } else if (
      value.revision >= renderer.revision &&
      value.baseRevision === renderer.revision
    )
      renderer.apply(value);
    else {
      dirty = true;
      return false;
    }
    dirty = false;
    frame = { ...value, revision: renderer.revision };
    element.setAttribute('aria-busy', 'false');
    trace('ui.apply', started, {
      revision: renderer.revision,
      operations: value.patch?.operations.length ?? null,
    });
    return true;
  }
  async function open() {
    const value = await transport.open({ target: 'dom' });
    if (closed) {
      await transport.dispose(value.id).catch(() => {});
      return;
    }
    apply(value);
  }
  async function read(reset = false) {
    if (closed || hidden || pending) return;
    dirty = false;
    try {
      apply(
        await transport.refresh(frame.id, {
          revision: renderer.revision,
          ...(reset ? { reset: true } : {}),
        }),
      );
    } catch (error) {
      if (error.status === 409 && error.current?.uiRetry) {
        invalidate();
        return;
      }
      if (error.status === 410) {
        await open();
        return;
      }
      throw error;
    }
  }
  function invalidate() {
    if (live) return;
    dirty = true;
    if (closed || hidden || timer !== undefined) return;
    const started = onTrace ? performance.now() : 0;
    trace('ui.invalidate', started, { delayMs: 32 });
    timer = setTimeout(() => {
      trace('ui.coalesce', started);
      timer = undefined;
      void serial(read);
    }, 32);
  }
  async function receive(value, requestedId) {
    if (closed || frame?.id !== requestedId || value.id !== requestedId) return;
    if (pending || hidden) return false;
    const cursor = value.updates;
    if (
      !cursor ||
      cursor.stream !== frame.updates?.stream ||
      !Number.isSafeInteger(cursor.sequence)
    ) {
      await read(true);
      return true;
    }
    if (
      cursor.sequence < frame.updates.sequence ||
      (cursor.sequence === frame.updates.sequence && !cursor.reset)
    )
      return true;
    if (cursor.reset && value.revision < renderer.revision) return true;
    if (value.heartbeat) {
      await read(true);
      return true;
    }
    if (
      (!cursor.reset && cursor.sequence !== frame.updates.sequence + 1) ||
      (!value.tree && value.baseRevision !== renderer.revision)
    ) {
      await read(true);
      return true;
    }
    if (!apply(value)) await read(true);
    return true;
  }
  function beginWatch() {
    if (
      watching ||
      closed ||
      watchStopped ||
      !transport.watch ||
      !frame?.updates
    )
      return;
    live = true;
    watching = true;
    clearTimeout(timer);
    timer = undefined;
    void (async () => {
      let backoff = 50,
        failures = 0;
      while (!closed && live && !watchStopped) {
        if (hidden || pending) {
          await new Promise((resolve) => {
            watchWake = resolve;
          });
          continue;
        }
        const id = frame.id,
          input = { ...frame.updates, revision: renderer.revision };
        delete input.reset;
        try {
          const value = await transport.watch(id, input);
          if (closed) return;
          while (!closed && (hidden || pending))
            await new Promise((resolve) => {
              watchWake = resolve;
            });
          if (closed) return;
          await serial(() => receive(value, id));
          backoff = 50;
          failures = 0;
        } catch (error) {
          if (closed) return;
          if ([404, 405, 501].includes(error.status)) {
            live = false;
            invalidate();
            break;
          }
          if (error.status === 410) {
            await serial(open);
            continue;
          }
          if (error.current?.uiReset) {
            await serial(() => read(true));
            continue;
          }
          if (
            [401, 403, 409].includes(error.status) &&
            !error.current?.uiRetry
          ) {
            watchStopped = true;
            onError(error);
            break;
          }
          if (
            ++failures === 3 &&
            !error.current?.uiRetry &&
            ![429, 503].includes(error.status)
          )
            onError(error);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(2000, backoff * 2);
        }
      }
    })()
      .catch((error) => {
        if (!closed) onError(error);
      })
      .finally(() => {
        watching = false;
      });
  }
  function status(value) {
    element.setAttribute('aria-busy', String(value.pending));
    renderer.setBusy(value.pending);
    onStatus(value);
    if (!value.pending) {
      watchWake?.();
      watchWake = undefined;
    }
  }
  async function reopen() {
    if (pending)
      onError(
        Error(
          'The previous action may have completed; the refreshed interface shows current state',
        ),
      );
    pending = null;
    queue.length = 0;
    status({ pending: false });
    await open();
  }
  async function send() {
    if (!pending || closed) return;
    try {
      const value = await transport.event(frame.id, pending.input);
      if (closed) return;
      const current = pending;
      apply(value);
      if (value.event?.sequence !== current.input.sequence)
        throw Error('Interface event acknowledgement changed');
      sequence = value.event.sequence;
      pending = null;
      status({ pending: false });
      if (value.event.status === 'accepted')
        renderer.acknowledge(current.versions, value.event.fields);
      else {
        onError(
          Error(value.event.error || 'The action could not be completed'),
        );
        if (value.event.status === 'unknown') queue.length = 0;
      }
      if (value.event.viewError) onError(Error(value.event.viewError));
      if (dirty) await read();
    } catch (error) {
      if (error.current?.notApplied) {
        pending = null;
        queue.length = 0;
        status({ pending: false });
        await read();
      } else if (pending)
        status({
          pending: true,
          retry: () =>
            serial(async () => {
              await send();
              await drain();
            }),
          reopen: () =>
            serial(async () => {
              await reopen();
              watchStopped = false;
              watchWake?.();
              beginWatch();
            }),
        });
      throw error;
    }
  }
  async function drain() {
    if (draining || closed || pending) return;
    draining = true;
    try {
      while (queue.length && !closed && !pending) {
        const value = queue.shift();
        if (dirty) await read();
        const node = renderer.tree.nodes.find((node) => node.id === value.node),
          binding = node?.events.find((binding) => binding.kind === value.kind);
        if (!binding || binding.token !== value.token) {
          queue.length = 0;
          throw Error('This control changed before the action was sent');
        }
        const input = structuredClone(value.input);
        if (value.kind === 'Input' || value.kind === 'Change')
          input.expected = renderer.rebaseExpected(value.node, input.expected);
        for (const field of input.fields)
          field.expected = renderer.rebaseExpected(field.id, field.expected);
        pending = {
          versions: value.versions,
          input: {
            sequence: sequence + 1,
            revision: renderer.revision,
            node: value.node,
            kind: value.kind,
            token: value.token,
            input,
          },
        };
        status({ pending: true });
        await send();
      }
    } finally {
      draining = false;
    }
  }
  function enqueue(value) {
    if (closed) return;
    const last = queue.at(-1);
    if (
      ['Input', 'Change'].includes(value.kind) &&
      last?.kind === value.kind &&
      last.node === value.node
    )
      queue[queue.length - 1] = value;
    else {
      if (queue.length >= 32) {
        onError(Error('The interface is busy; the local draft has been kept'));
        return;
      }
      queue.push(value);
    }
    if (!drainScheduled) {
      drainScheduled = true;
      void serial(async () => {
        drainScheduled = false;
        await drain();
      });
    }
  }
  const stop = subscribe(invalidate);
  try {
    await serial(open);
  } catch (error) {
    stop?.();
    renderer.dispose();
    throw error;
  }
  beginWatch();
  heartbeat = setInterval(invalidate, 60000);
  return Object.freeze({
    get renderer() {
      return renderer;
    },
    refresh: () => serial(read),
    retry: () =>
      serial(async () => {
        await send();
        await drain();
      }),
    reopen: () => serial(reopen),
    get pending() {
      return !!pending;
    },
    suspend(value) {
      hidden = !!value;
      if (!hidden) {
        watchWake?.();
        watchWake = undefined;
      }
      if (hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else invalidate();
    },
    dispose() {
      if (closed) return;
      closed = true;
      watchWake?.();
      watchWake = undefined;
      queue.length = 0;
      clearTimeout(timer);
      clearInterval(heartbeat);
      stop?.();
      renderer.dispose();
      if (frame) void transport.dispose(frame.id).catch(() => {});
    },
  });
}
