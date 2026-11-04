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
    drainScheduled = false;
  const queue = [];
  const renderer = createDomUi(element, { onEvent: enqueue, onLifecycle });
  function serial(run) {
    const task = tail.catch(() => {}).then(run);
    tail = task;
    task.catch((error) => {
      if (!closed) onError(error);
    });
    return task;
  }
  function apply(value) {
    if (closed) return;
    if (!frame || value.id !== frame.id) {
      renderer.rebase(value);
      sequence = 0;
    } else if (
      value.revision >= renderer.revision &&
      value.baseRevision === renderer.revision
    )
      renderer.apply(value);
    else dirty = true;
    frame = { ...value, revision: renderer.revision };
    element.setAttribute('aria-busy', 'false');
  }
  async function open() {
    const value = await transport.open({ target: 'dom' });
    if (closed) {
      await transport.dispose(value.id).catch(() => {});
      return;
    }
    apply(value);
  }
  async function read() {
    if (closed || hidden || pending) return;
    dirty = false;
    try {
      apply(await transport.refresh(frame.id, { revision: renderer.revision }));
    } catch (error) {
      if (error.status === 410) {
        await open();
        return;
      }
      throw error;
    }
  }
  function invalidate() {
    dirty = true;
    if (closed || hidden || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void serial(read);
    }, 32);
  }
  function status(value) {
    element.setAttribute('aria-busy', String(value.pending));
    renderer.setBusy(value.pending);
    onStatus(value);
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
          reopen: () => serial(reopen),
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
      if (hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else invalidate();
    },
    dispose() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      clearTimeout(timer);
      clearInterval(heartbeat);
      stop?.();
      renderer.dispose();
      if (frame) void transport.dispose(frame.id).catch(() => {});
    },
  });
}
