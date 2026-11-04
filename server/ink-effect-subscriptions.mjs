import { randomBytes } from 'node:crypto';
export class EffectSubscriptions {
  constructor(world) {
    this.world = world;
    this.handles = new Map();
    this.stop = null;
  }
  ensure() {
    if (this.stop) return;
    this.stop = this.world.subscribe((event) => {
      const objects =
        event.type === 'object'
          ? [
              {
                type: 'object',
                id: event.object.id,
                namespace: event.object.namespace,
                version: event.version,
              },
            ]
          : event.type === 'deleted'
            ? event.ids.map((id) => ({
                type: 'deleted',
                id,
                namespace: event.namespace || '',
                version: event.version,
              }))
            : [];
      for (const handle of this.handles.values())
        for (const value of objects)
          if (value.namespace === handle.appId) {
            if (handle.queue.length >= 128) {
              handle.gap = true;
              handle.queue = [];
            } else handle.queue.push(value);
            handle.wake?.();
          }
    });
  }
  open(run) {
    if (this.handles.size >= 64)
      throw Object.assign(Error('Subscription handle capacity exceeded'), {
        effectCode: 'ResourceLimit',
        certainty: 'not-applied',
      });
    this.ensure();
    const id = randomBytes(24).toString('hex');
    this.handles.set(id, {
      runId: run.id,
      appId: run.appId,
      releaseId: run.releaseId,
      expiresAt: run.deadlineAt,
      queue: [],
      gap: false,
    });
    return {
      handle: id,
      version: BigInt(this.world.version),
      event: { None: null },
    };
  }
  owned(run, id) {
    const handle = this.handles.get(id);
    if (
      !handle ||
      handle.runId !== run.id ||
      handle.appId !== run.appId ||
      handle.releaseId !== run.releaseId ||
      handle.expiresAt <= Date.now()
    )
      throw Object.assign(
        Error(
          'Subscription is absent or its host lifetime ended; resynchronize',
        ),
        { effectCode: 'Gap', certainty: 'not-applied' },
      );
    return handle;
  }
  async next(run, id, signal) {
    const handle = this.owned(run, id);
    while (!handle.queue.length && !handle.gap) {
      if (signal.aborted) throw signal.reason;
      await new Promise((resolve, reject) => {
        const abort = () => {
          handle.wake = null;
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        handle.wake = () => {
          handle.wake = null;
          signal.removeEventListener('abort', abort);
          resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
      });
      this.owned(run, id);
    }
    if (handle.gap)
      throw Object.assign(
        Error('Subscription buffer overflowed; resynchronize'),
        { effectCode: 'Gap', certainty: 'not-applied' },
      );
    const event = handle.queue.shift();
    return {
      handle: id,
      version: BigInt(event.version),
      event: { Some: { ...event, version: BigInt(event.version) } },
    };
  }
  close(run, id) {
    this.owned(run, id);
    const handle = this.handles.get(id);
    this.handles.delete(id);
    handle.gap = true;
    handle.wake?.();
    this.idle();
    return {
      handle: id,
      version: BigInt(this.world.version),
      event: { None: null },
    };
  }
  release(runId) {
    for (const [id, handle] of this.handles)
      if (handle.runId === runId) {
        this.handles.delete(id);
        handle.gap = true;
        handle.wake?.();
      }
    this.idle();
  }
  idle() {
    if (!this.handles.size && this.stop) {
      this.stop();
      this.stop = null;
    }
  }
  shutdown() {
    for (const handle of this.handles.values()) {
      handle.gap = true;
      handle.wake?.();
    }
    this.handles.clear();
    this.idle();
  }
}
