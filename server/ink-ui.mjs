import { randomBytes, createHash } from 'node:crypto';
import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { inkProgramKey } from './ink-compiler.mjs';
import { inkUiComponents } from '../shared/ink-ui.mjs';
import { inkPublicEntries } from '../shared/ink-app.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { wireValue } from '../shared/ink-values.mjs';
import { composeUiTree, uiInput, UI_CONTROLS } from './ink-ui-tree.mjs';
import { UiQueries, currentUiQuery, scopedUiQuery } from './ink-ui-queries.mjs';
import { InkUiReads } from './ink-ui-reads.mjs';
import { diffUiTree, UI_FORMAT } from '../sdk/src/ui-model.js';
import { hostBudget } from './execution-budget.mjs';
const fail = (status, message, current) => {
  throw Object.assign(Error(message), {
    status,
    ...(current ? { current } : {}),
  });
};
const key = (appId, stateKey) => appId + '\0' + stateKey;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fields = (value, allowed) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((name) => allowed.includes(name));
const LIMIT = 64 * 1024 * 1024;
export class InkViews {
  constructor({ platform, ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { platform, ttlMs, now });
    this.mounts = new Map();
    this.tasks = new Set();
    this.bytes = 0;
    this.deliveryBytes = 0;
    this.deliveryTick = 0;
    this.queries = new UiQueries(platform.world);
    this.reads = new InkUiReads(platform);
    this.accepting = true;
    this.ready = false;
  }
  async open() {
    this.stop = this.platform.world.subscribe((event) =>
      this.invalidate(event),
    );
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref();
    this.ready = true;
    return this;
  }
  closeAdmission() {
    this.accepting = false;
    this.reads.pause();
    for (const mount of this.mounts.values())
      this.wake(
        mount,
        Object.assign(Error('Interface admission is closed'), { status: 503 }),
      );
  }
  disposePreview(id) {
    for (const mount of this.mounts.values())
      if (mount.previewId === id) this.drop(mount);
  }
  resumeAdmission() {
    this.accepting = true;
    this.reads.resume();
  }
  actor(principal) {
    if (principal?.owner) return 'account:' + (principal.accountId || 'owner');
    if (principal?.appId) return 'app:' + principal.appId;
    fail(401, 'Sign in to mount an Ink interface');
  }
  authorize(mount, principal) {
    if (
      this.actor(principal) !== mount.owner &&
      !(principal?.owner && principal.accountId === 'owner')
    )
      fail(403, 'This interface belongs to another account or application');
    if (!principal.owner && principal.appId !== mount.appId)
      fail(403, 'Wrong app identity');
    if (principal.releaseId && principal.releaseId !== mount.releaseId)
      fail(409, 'This interface belongs to another release');
  }
  get(id, principal) {
    if (!/^[a-f0-9]{32}$/.test(id || '')) fail(400, 'Invalid interface mount');
    const mount = this.mounts.get(id);
    if (!mount || mount.disposed || mount.expiresAt <= this.now())
      fail(410, 'Interface session expired; reopen it');
    this.authorize(mount, principal);
    return mount;
  }
  track(execute) {
    const task = Promise.resolve().then(execute);
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  serial(mount, execute) {
    if (!this.accepting) fail(503, 'Interface admission is closed');
    const previous = mount.tail;
    mount.busy++;
    const task = this.track(async () => {
      try {
        return await previous.catch(() => {}).then(execute);
      } finally {
        mount.busy--;
      }
    });
    mount.tail = task;
    return task;
  }
  touch(mount) {
    mount.expiresAt = Math.min(
      this.now() + this.ttlMs,
      mount.previewExpiry || Infinity,
    );
  }
  async program(mount, principal) {
    let app, compiled;
    if (mount.previewId) {
      const preview = this.platform.inkPreviews.get(mount.previewId, principal);
      app = { spec: preview.spec, source: preview.source, releaseId: null };
      compiled = preview.compiled;
      mount.previewExpiry = preview.expiresAt;
    } else {
      const meta = JSON.parse(this.platform.app(mount.appId).body);
      if (!meta.capabilities?.includes('code.execute'))
        fail(403, 'This app does not declare code.execute');
      app = await installedInk(this.platform, mount.appId, mount.releaseId);
      if (
        app.spec.ui?.components.some(
          (c) => c.read && c.read.appId !== 'self',
        ) &&
        !meta.capabilities?.includes('apps.invoke')
      )
        fail(403, 'Cross-app UI reads require apps.invoke');
      if (
        app.spec.ui?.components.some((component) => component.query) &&
        !meta.capabilities?.includes('world.read')
      )
        fail(403, 'Data-backed UI requires world.read');
      compiled = await this.platform.code.compile(app.source);
    }
    if (!app.spec.ui) fail(400, 'This app has no typed Ink interface');
    const identity = inkProgramKey(app.source);
    if (mount.source && mount.source !== identity)
      fail(409, 'Interface source changed; reopen it');
    const components = inkUiComponents(
      app.spec,
      inkPublicEntries(
        app.spec,
        compiled.entries,
        compiled.artifact.manifest.named_types,
      ),
      compiled.artifact.manifest.named_types,
    ).map((component) => {
      const entry = compiled.entries.find(
        (entry) => entry.name === component.entry,
      );
      return {
        ...component,
        roots: (entry.roots || []).map(
          (index) => compiled.artifact.manifest.state.roots[index].name,
        ),
      };
    });
    return {
      app,
      compiled,
      identity,
      components: new Map(
        components.map((component) => [component.name, component]),
      ),
    };
  }
  async openApp(appId, principal, input = {}) {
    return this.openMount({ appId }, principal, input);
  }
  async openPreview(previewId, principal, input = {}) {
    return this.openMount({ previewId }, principal, input);
  }
  openMount(target, principal, input) {
    if (!this.accepting) fail(503, 'Interface admission is closed');
    if (
      !fields(input, ['releaseId', 'target']) ||
      (input.target !== undefined && input.target !== 'dom')
    )
      fail(
        501,
        'This host supports the DOM UI target; native widgets require a separate adapter',
      );
    const owner = this.actor(principal);
    if (!principal.owner && target.appId !== principal.appId)
      fail(403, 'Wrong app identity');
    return this.track(async () => {
      this.prune();
      if (
        this.mounts.size >= 64 ||
        [...this.mounts.values()].filter((mount) => mount.owner === owner)
          .length >= 16
      )
        fail(429, 'Close existing interface sessions');
      const mount = {
        ...target,
        id: randomBytes(16).toString('hex'),
        owner,
        releaseId:
          principal.releaseId ||
          input.releaseId ||
          (!target.previewId
            ? JSON.parse(this.platform.app(target.appId).body).releaseId
            : null),
        revision: 0,
        stream: randomBytes(16).toString('hex'),
        deliverySequence: 0,
        history: [],
        waiters: new Set(),
        subscriptions: new Map(),
        sequence: 0,
        receipts: new Map(),
        cache: new Map(),
        dirty: new Set(),
        all: true,
        epoch: 0,
        bytes: 0,
        tail: Promise.resolve(),
        busy: 0,
      };
      const program = await this.program(mount, principal);
      if (!this.accepting) fail(503, 'Interface admission is closed');
      if (
        this.mounts.size >= 64 ||
        [...this.mounts.values()].filter((mount) => mount.owner === owner)
          .length >= 16
      )
        fail(429, 'Interface session capacity is busy');
      mount.source = program.identity;
      this.touch(mount);
      this.mounts.set(mount.id, mount);
      try {
        await this.render(mount, principal, program);
        return this.frame(mount, 0, null);
      } catch (error) {
        this.drop(mount);
        throw error;
      }
    });
  }
  invalidate(event) {
    if (event.type === 'ink-reads') return;
    const provider = this.reads.invalidate(event),
      readers = new Set();
    for (const mount of this.mounts.values()) {
      if (mount.disposed || mount.previewId) continue;
      let changed = false,
        needsRender = false;
      if (event.type === 'object' && event.object.id === mount.appId) {
        mount.all = true;
        changed = true;
        needsRender = true;
      }
      if (
        (event.type === 'ink-state' && event.appId === mount.appId) ||
        (event.type === 'object' &&
          event.object.namespace === mount.appId &&
          event.object.kind === 'state' &&
          event.object.title === 'ink-app:state' &&
          (event.restore ||
            this.platform.world.stateCommits?.get(
              mount.appId + '\0ink-app:state',
            )?.body !== event.object.body))
      ) {
        const hint = this.platform.code.commitHints.get(
          key(mount.appId, 'ink-app:state'),
        );
        if (hint?.source === mount.source) {
          for (const root of hint.roots) mount.dirty.add(root);
          // Use the same compiler-checked dependencies as component caching.
          // Input-backed pure components wait for their retained result instead
          // of computing once before it is ready and then computing again.
          needsRender ||= [...mount.cache.values()].some(
            (entry) =>
              !entry.roots ||
              entry.roots.some((root) => hint.roots.includes(root)),
          );
        } else {
          mount.all = true;
          needsRender = true;
        }
        changed = true;
      }
      for (const [name, entry] of mount.cache) {
        if (
          entry.querySnapshot &&
          !currentUiQuery(this.platform.world, entry.querySnapshot)
        ) {
          entry.dataDirty = true;
          changed = true;
          needsRender = true;
        }
        if (entry.readSnapshot && !this.reads.current(entry.readSnapshot)) {
          entry.dataDirty = true;
          changed = true;
          if (entry.readSnapshot.binding.appId !== mount.appId)
            readers.add(mount.appId);
          if (!mount.subscriptions.has(name)) needsRender = true;
        }
      }
      if (event.type === 'deleted' && event.ids.includes(mount.appId)) {
        mount.all = true;
        changed = true;
        needsRender = true;
      }
      if (changed) {
        mount.epoch++;
        if (needsRender) this.schedule(mount);
      }
    }
    // Tell desktops which apps read the changed provider, so only their frames
    // refresh; other apps holding apps.invoke are not woken by this commit.
    if (provider && readers.size)
      for (const listener of [...this.platform.world.listeners])
        listener({ type: 'ink-reads', provider: provider.appId, apps: [...readers].sort() });
  }
  async render(mount, principal, provided, { passive = false } = {}) {
    if (mount.disposed) fail(410, 'Interface was disposed');
    const program = provided || (await this.program(mount, principal)),
      code = this.platform.code,
      signal = AbortSignal.timeout(30000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = mount.epoch,
        dirty = new Set(mount.dirty),
        all = mount.all,
        cache = new Map(mount.cache),
        computed = [];
      // Read outside the consumer's state lock. This also permits self reads and
      // prevents reciprocal query consumers from holding each other's locks.
      const readSnapshots = new Map();
      for (const component of program.components.values())
        if (component.read) {
          const binding =
            component.read.appId === 'self'
              ? {
                  ...component.read,
                  appId: mount.appId,
                  releaseId: mount.releaseId,
                }
              : component.read;
          readSnapshots.set(
            component.name,
            mount.previewId
              ? null
              : await this.reads.read(binding, component.data, signal, {
                  appId: mount.appId,
                  releaseId: mount.releaseId,
                }),
          );
        }
      const compute = async () => {
        const readComponent = async (name) => {
          const component = program.components.get(name);
          if (!component) fail(400, 'View references an undeclared component');
          let entry = cache.get(name);
          if (computed.includes(name)) return entry.view;
          // A reused read snapshot (same exact value) supersedes its dirty mark.
          if (
            entry?.dataDirty &&
            component.read &&
            entry.readSnapshot === readSnapshots.get(name)
          )
            entry.dataDirty = false;
          const needed =
            all ||
            !entry ||
            entry.dataDirty ||
            (component.read &&
              entry.readSnapshot !== readSnapshots.get(name)) ||
            (entry.querySnapshot &&
              !currentUiQuery(this.platform.world, entry.querySnapshot)) ||
            component.roots.some((root) => dirty.has(root));
          if (!needed) return entry.view;
          let querySnapshot = entry?.querySnapshot,
            args = [];
          const readSnapshot = readSnapshots.get(name);
          if (component.port) fail(400, 'The UI data port is unbound');
          if (component.read)
            args = [
              mount.previewId
                ? { rows: [], total: { None: null }, version: 0n }
                : readSnapshot.value,
            ];
          if (component.query) {
            if (mount.previewId) {
              args = [{ rows: [], total: { None: null }, version: 0n }];
            } else {
              querySnapshot = await hostBudget.run(
                {
                  owner: mount.appId,
                  resources: { cpu: 1 },
                  signal,
                  label: 'UI query',
                },
                () =>
                  this.queries.read(
                    scopedUiQuery(component.query, mount.appId),
                    this.queries.control(
                      program.app,
                      mount.appId,
                      component.name,
                    ),
                  ),
              );
              args = [
                wireValue(
                  {
                    ...querySnapshot.data,
                    rows: querySnapshot.data.rows.map((row) =>
                      uiDataValue(
                        row,
                        component.data.fields.find(
                          (field) => field.name === 'rows',
                        ).type.element,
                      ),
                    ),
                  },
                  component.data,
                ),
              ];
            }
          }
          const input = stringifyExactJSON(args);
          if (Buffer.byteLength(input) > 128 * 1024)
            fail(413, 'Typed UI input exceeds 128 KiB');
          let result;
          if (mount.previewId)
            result = await this.platform.inkPreviews.run(
              mount.previewId,
              principal,
              { entry: component.entry, input },
              { locked: true },
            );
          else {
            const authority = this.platform.runtime.bind({
              appId: mount.appId,
              namespace: mount.appId,
              releaseId: mount.releaseId,
            });
            result = await code.execute({
              source: program.app.source,
              entry: component.entry,
              input,
              wire: input,
              namespace: mount.appId,
              stateKey: 'ink-app:state',
              principal: authority,
              signal,
            });
          }
          const wire =
            result.valueWire ??
            (program.compiled.entries.find(
              (entry) => entry.name === component.entry,
            ).action
              ? stringifyExactJSON(parseExactJSON(result.wire).result)
              : result.wire);
          if (Buffer.byteLength(wire) > 1024 * 1024)
            fail(413, 'UI component output exceeds 1 MiB');
          entry = {
            view: parseExactJSON(wire),
            wire,
            querySnapshot,
            readSnapshot,
            dataDirty: false,
            roots: component.roots,
          };
          cache.set(name, entry);
          computed.push(name);
          return entry.view;
        };
        return composeUiTree({ mountId: mount.id, readComponent });
      };
      let frame;
      mount.busy++;
      try {
        if (mount.previewId)
          frame = await code.serializeState(
            'ink-preview:' + mount.previewId,
            'session',
            compute,
          );
        else {
          const authority = this.platform.runtime.bind({
            appId: mount.appId,
            namespace: mount.appId,
            releaseId: mount.releaseId,
          });
          frame = await code.serializeState(mount.appId, 'ink-app:state', () =>
            authority.writeAccess.run(compute),
          );
        }
      } finally {
        mount.busy--;
      }
      if (mount.disposed) fail(410, 'Interface was disposed');
      if (epoch !== mount.epoch) continue;
      const retained = new Map(
          [...cache].filter(([name]) => frame.components.has(name)),
        ),
        bytes =
          [...retained.values()].reduce(
            (n, entry) =>
              n +
              Buffer.byteLength(entry.wire) +
              (entry.readSnapshot?.bytes || 0),
            0,
          ) + Buffer.byteLength(JSON.stringify(frame.tree));
      if (bytes > 4 * 1024 * 1024 || this.bytes - mount.bytes + bytes > LIMIT)
        fail(429, 'Interface memory budget is busy');
      this.bytes += bytes - mount.bytes;
      mount.bytes = bytes;
      mount.cache = retained;
      mount.frame = frame;
      mount.computed = computed;
      const previousTree = mount.tree,
        previousRevision = mount.revision,
        previousSnapshots = mount.snapshotKey;
      const changed =
        !mount.tree ||
        diffUiTree(mount.tree, frame.tree).operations.length ||
        mount.tree.root !== frame.tree.root;
      if (changed) mount.revision++;
      mount.tree = frame.tree;
      mount.all = false;
      mount.dirty.clear();
      mount.snapshotKey = JSON.stringify(this.snapshots(mount));
      if (!passive) this.touch(mount);
      if (mount.live && (changed || previousSnapshots !== mount.snapshotKey))
        this.publish(mount, previousRevision, previousTree);
      return;
    }
    fail(409, 'State changed during interface computation; refresh again', {
      notApplied: true,
      uiRetry: true,
    });
  }
  frame(mount, baseRevision, previous) {
    return {
      format: UI_FORMAT,
      id: mount.id,
      releaseId: mount.releaseId,
      revision: mount.revision,
      baseRevision,
      expiresAt: mount.expiresAt,
      target: 'dom',
      computed: mount.computed || [],
      ...(!mount.previewId
        ? {
            updates: { stream: mount.stream, sequence: mount.deliverySequence },
            snapshots: this.snapshots(mount),
          }
        : {}),
      ...(previous
        ? { patch: diffUiTree(previous, mount.tree) }
        : { tree: mount.tree }),
    };
  }
  refresh(id, principal, input = {}) {
    const mount = this.get(id, principal);
    if (
      !fields(input, ['revision', 'reset']) ||
      (input.reset !== undefined && typeof input.reset !== 'boolean') ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      input.revision > mount.revision
    )
      fail(409, 'Interface revision changed', { notApplied: true });
    return this.serial(mount, async () => {
      const previous =
        !input.reset && input.revision === mount.revision ? mount.tree : null;
      await this.render(mount, principal);
      const value = this.frame(mount, input.revision, previous);
      return input.reset
        ? { ...value, updates: { ...value.updates, reset: true } }
        : value;
    });
  }
  snapshots(mount) {
    return [...mount.cache]
      .filter(([, entry]) => entry.readSnapshot)
      .map(([component, entry]) => {
        const snapshot = entry.readSnapshot;
        return {
          component,
          id: snapshot.id,
          sequence: snapshot.sequence,
          appId: snapshot.binding.appId,
          releaseId: snapshot.binding.releaseId,
          stateRevision: snapshot.stateRevision,
          versionWire: snapshot.versionWire,
        };
      })
      .sort((a, b) =>
        a.component < b.component ? -1 : a.component > b.component ? 1 : 0,
      );
  }
  async enableLive(mount, principal) {
    if (mount.live) return;
    const program = await this.program(mount, principal);
    mount.live = true;
    try {
      for (const component of program.components.values())
        if (component.read) {
          const binding =
            component.read.appId === 'self'
              ? {
                  ...component.read,
                  appId: mount.appId,
                  releaseId: mount.releaseId,
                }
              : component.read;
          mount.subscriptions.set(
            component.name,
            this.reads.retain(
              binding,
              component.data,
              ({ snapshot, error }) => {
                if (mount.disposed) return;
                if (error) {
                  mount.deliveryError = error;
                  this.wake(mount, error);
                  return;
                }
                mount.deliveryError = null;
                const entry = mount.cache.get(component.name);
                if (entry?.readSnapshot !== snapshot) {
                  if (entry) entry.dataDirty = true;
                  mount.epoch++;
                  this.schedule(mount);
                }
              },
              { appId: mount.appId, releaseId: mount.releaseId },
            ),
          );
        }
      await this.render(mount, principal, program);
    } catch (error) {
      for (const release of mount.subscriptions.values()) release();
      mount.subscriptions.clear();
      mount.live = false;
      throw error;
    }
  }
  schedule(mount) {
    if (!mount.live || mount.disposed || mount.scheduled || !this.accepting)
      return;
    mount.scheduled = true;
    queueMicrotask(() => {
      if (mount.disposed || !this.accepting) {
        mount.scheduled = false;
        return;
      }
      this.serial(mount, async () => {
        mount.scheduled = false;
        try {
          await this.render(mount, undefined, undefined, { passive: true });
          mount.deliveryError = null;
        } catch (error) {
          if (error.current?.uiRetry) {
            mount.updateTimer = setTimeout(() => this.schedule(mount), 10);
            mount.updateTimer.unref();
          } else {
            mount.deliveryError = error;
            this.wake(mount, error);
          }
        }
      }).catch((error) => {
        mount.scheduled = false;
        this.wake(mount, error);
      });
    });
  }
  publish(mount, baseRevision, previous) {
    mount.deliverySequence++;
    const value = this.frame(mount, baseRevision, previous),
      bytes = Buffer.byteLength(JSON.stringify(value));
    mount.history.push({
      sequence: mount.deliverySequence,
      value,
      bytes,
      tick: ++this.deliveryTick,
    });
    this.deliveryBytes += bytes;
    const discard = (target) => {
      const first = target.history.shift();
      if (first) this.deliveryBytes -= first.bytes;
    };
    while (
      mount.history.length > 32 ||
      mount.history.reduce((n, r) => n + r.bytes, 0) > 1024 * 1024
    )
      discard(mount);
    while (this.deliveryBytes > 8 * 1024 * 1024) {
      const oldest = [...this.mounts.values()]
        .filter((m) => m.history.length)
        .sort((a, b) => a.history[0].tick - b.history[0].tick)[0];
      if (!oldest) break;
      discard(oldest);
    }
    this.wake(mount);
  }
  available(mount, input) {
    const meta = JSON.parse(this.platform.app(mount.appId).body);
    if (meta.releaseId !== mount.releaseId)
      fail(409, 'Interface release changed; reopen it');
    if (!meta.capabilities?.includes('code.execute'))
      fail(403, 'This app does not declare code.execute');
    for (const entry of mount.cache.values())
      if (entry.readSnapshot) {
        const binding = entry.readSnapshot.binding;
        if (
          binding.appId !== mount.appId &&
          !meta.capabilities?.includes('apps.invoke')
        )
          fail(403, 'Cross-app UI reads require apps.invoke');
        this.reads.stamp(binding.appId, binding.releaseId);
      }
    if (mount.deliveryError) throw mount.deliveryError;
    if (input.sequence < mount.deliverySequence) {
      const next = mount.history.find(
        (entry) => entry.sequence === input.sequence + 1,
      );
      if (next) return next.value;
      return {
        ...this.frame(mount, input.revision, null),
        updates: {
          stream: mount.stream,
          sequence: mount.deliverySequence,
          reset: true,
        },
      };
    }
    if (input.revision !== mount.revision)
      return {
        ...this.frame(mount, input.revision, null),
        updates: {
          stream: mount.stream,
          sequence: mount.deliverySequence,
          reset: true,
        },
      };
    return null;
  }
  wake(mount, error) {
    for (const notify of [...mount.waiters]) notify(error);
  }
  async watch(id, principal, input = {}, { signal } = {}) {
    const mount = this.get(id, principal);
    if (mount.previewId) fail(501, 'Preview interfaces use explicit refresh');
    if (
      !fields(input, ['stream', 'sequence', 'revision']) ||
      input.stream !== mount.stream ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      input.sequence > mount.deliverySequence ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      input.revision > mount.revision
    )
      fail(409, 'Interface subscription cursor changed', {
        notApplied: true,
        uiReset: true,
      });
    if (!this.accepting) fail(503, 'Interface admission is closed');
    if (mount.waiters.size >= 2)
      fail(429, 'Interface already has active delivery requests');
    await this.serial(mount, () => this.enableLive(mount, principal));
    const program = await this.program(mount, principal);
    for (const component of program.components.values())
      if (component.read) {
        const binding =
          component.read.appId === 'self'
            ? {
                ...component.read,
                appId: mount.appId,
                releaseId: mount.releaseId,
              }
            : component.read;
        this.reads.stamp(binding.appId, binding.releaseId);
      }
    this.touch(mount);
    const ready = this.available(mount, input);
    if (ready) return ready;
    if (mount.waiters.size >= 2)
      fail(429, 'Interface already has active delivery requests');
    return new Promise((resolve, reject) => {
      let timer,
        done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        mount.waiters.delete(notify);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const notify = (error) => {
        try {
          if (error) return finish(error);
          const value = this.available(mount, input);
          if (value) finish(null, value);
        } catch (error) {
          finish(error);
        }
      };
      const abort = () =>
        finish(
          Object.assign(Error('Interface delivery cancelled'), { status: 499 }),
        );
      mount.waiters.add(notify);
      timer = setTimeout(() => {
        notify();
        if (!done)
          finish(null, {
            heartbeat: true,
            id: mount.id,
            revision: input.revision,
            updates: { stream: mount.stream, sequence: input.sequence },
          });
      }, 15000);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else notify();
    });
  }
  event(id, principal, input) {
    const mount = this.get(id, principal);
    if (
      !fields(input, [
        'sequence',
        'revision',
        'node',
        'kind',
        'token',
        'input',
      ]) ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1 ||
      typeof input.node !== 'string' ||
      typeof input.kind !== 'string' ||
      typeof input.token !== 'string' ||
      !Number.isSafeInteger(input.revision) ||
      Buffer.byteLength(JSON.stringify(input)) > 128 * 1024
    )
      fail(400, 'Invalid typed UI event');
    const digest = hash(JSON.stringify(input));
    return this.serial(mount, async () => {
      const previousReceipt = mount.receipts.get(input.sequence);
      if (previousReceipt) {
        if (previousReceipt.digest !== digest)
          fail(409, 'UI event sequence was used for another input', {
            notApplied: true,
          });
        const previous = input.revision === mount.revision ? mount.tree : null;
        await this.render(mount, principal);
        return {
          ...this.frame(mount, input.revision, previous),
          event: previousReceipt.event,
        };
      }
      if (input.sequence <= mount.sequence)
        fail(410, 'UI event receipt expired; it cannot execute again');
      if (input.sequence !== mount.sequence + 1)
        fail(409, 'UI event sequence has a gap', { notApplied: true });
      await this.render(mount, principal);
      if (input.revision !== mount.revision)
        fail(409, 'Interface changed; refresh before acting', {
          notApplied: true,
        });
      const binding = mount.frame.bindings.get(input.node + '\0' + input.kind);
      if (!binding || binding.token !== input.token)
        fail(409, 'This event binding changed', { notApplied: true });
      const value = uiInput(mount.frame, input.node, input.kind, input.input),
        program = await this.program(mount, principal),
        component = program.components.get(binding.component),
        event = {
          node: mount.frame.origins.get(input.node).name,
          kind: 'UiEventKind.' + input.kind,
          action: binding.action,
          input: value,
        },
        wire = stringifyExactJSON([event]);
      const receipt = {
        digest,
        event: {
          sequence: input.sequence,
          status: 'unknown',
          error: 'The event outcome could not be confirmed',
        },
        requestId: this.now() + ':' + globalThis.crypto.randomUUID(),
      };
      mount.sequence = input.sequence;
      mount.receipts.set(input.sequence, receipt);
      while (mount.receipts.size > 64)
        mount.receipts.delete(mount.receipts.keys().next().value);
      const previous = mount.tree;
      try {
        let result;
        if (mount.previewId) {
          result = await this.platform.inkPreviews.run(
            mount.previewId,
            principal,
            { entry: component.event, input: wire },
          );
          const handler = program.compiled.entries.find(
            (entry) => entry.name === component.event,
          );
          for (const root of handler.roots || [])
            mount.dirty.add(
              program.compiled.artifact.manifest.state.roots[root].name,
            );
          mount.epoch++;
        } else
          result = await runInstalledInk(
            this.platform,
            mount.appId,
            {
              entry: component.event,
              input: wire,
              requestId: receipt.requestId,
            },
            principal,
            mount.releaseId,
            { signal: AbortSignal.timeout(30000) },
          );
        const resultValue = parseExactJSON(result.valueWire);
        receipt.event = {
          sequence: input.sequence,
          status:
            resultValue &&
            typeof resultValue === 'object' &&
            Object.hasOwn(resultValue, 'Err')
              ? 'rejected'
              : 'accepted',
          ...(resultValue?.Err !== undefined
            ? { error: String(resultValue.Err) }
            : {}),
        };
      } catch (error) {
        receipt.event = {
          sequence: input.sequence,
          status: 'unknown',
          error: String(error.message).slice(0, 500),
        };
      }
      try {
        await this.render(mount, principal);
      } catch (error) {
        receipt.event.viewError = String(error.message).slice(0, 500);
      }
      receipt.event.fields = Object.fromEntries(
        mount.tree.nodes
          .filter(
            (node) =>
              UI_CONTROLS.has(node.kind) &&
              (node.id === input.node ||
                input.input.fields.some((field) => field.id === node.id)),
          )
          .map((node) => [node.id, { token: node.props.valueToken }]),
      );
      while (
        mount.receipts.size > 1 &&
        [...mount.receipts.values()].reduce(
          (n, receipt) => n + Buffer.byteLength(JSON.stringify(receipt)),
          0,
        ) >
          512 * 1024
      )
        mount.receipts.delete(mount.receipts.keys().next().value);
      return {
        ...this.frame(mount, input.revision, previous),
        event: receipt.event,
      };
    });
  }
  dispose(id, principal) {
    const mount = this.get(id, principal);
    return this.serial(mount, async () => {
      this.drop(mount);
      return { id, disposed: true };
    });
  }
  drop(mount) {
    if (mount.disposed) return;
    mount.disposed = true;
    clearTimeout(mount.updateTimer);
    this.wake(
      mount,
      Object.assign(Error('Interface session expired; reopen it'), {
        status: 410,
      }),
    );
    for (const release of mount.subscriptions.values()) release();
    mount.subscriptions.clear();
    for (const entry of mount.history) this.deliveryBytes -= entry.bytes;
    mount.history.length = 0;
    this.mounts.delete(mount.id);
    this.bytes -= mount.bytes;
    mount.bytes = 0;
    mount.cache.clear();
    mount.receipts.clear();
  }
  prune() {
    for (const mount of this.mounts.values())
      if (!mount.busy && mount.expiresAt <= this.now()) this.drop(mount);
  }
  async close() {
    this.closeAdmission();
    this.stop?.();
    await Promise.allSettled([...this.tasks]);
    clearInterval(this.timer);
    this.stop?.();
    for (const mount of this.mounts.values()) this.drop(mount);
    this.queries.close();
    await this.reads.close();
    this.ready = false;
  }
}

function uiDataValue(value, type) {
  if (type.kind === 'option')
    return value === null
      ? { None: null }
      : { Some: uiDataValue(value, type.element) };
  if (type.kind === 'record') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail(400, 'Relational UI row type mismatch');
    return Object.fromEntries(
      type.fields.map((field) => [
        field.name,
        uiDataValue(value[field.name], field.type),
      ]),
    );
  }
  if (type.kind === 'list' || type.kind === 'vector') {
    if (!Array.isArray(value))
      fail(400, 'Relational UI collection type mismatch');
    return value.map((item) => uiDataValue(item, type.element));
  }
  return value;
}

export async function watchInkUi(service, id, principal, input, response) {
  const controller = new AbortController(),
    abort = () => controller.abort();
  response.once('close', abort);
  try {
    return await service.watch(id, principal, input, {
      signal: controller.signal,
    });
  } finally {
    response.removeListener('close', abort);
  }
}
