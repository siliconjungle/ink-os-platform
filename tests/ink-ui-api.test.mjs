import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '../sdk/src/server.js';
import { uiFiles, event } from './ink-ui-fixture.mjs';
const execute = promisify(execFile);
test(
  'authenticated HTTP and SDK mount Ink interfaces, enforce API scopes and preview isolation',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ink-ui-api-')),
      data = join(root, 'data'),
      source = join(root, 'source');
    await mkdir(source);
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const url = 'http://127.0.0.1:' + port;
    const env = {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      PORT: String(port),
      INK_OS_DEFAULT_APPS: '0',
      INK_OS_DATA_DIR: data,
      INK_OS_CONFIG: join(data, 'client.json'),
      NODE_ENV: 'production',
      INK_OS_NATIVE: '0',
    };
    let output = '';
    const child = spawn(process.execPath, ['scripts/start.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => (output = (output + b).slice(-12000)));
    child.stderr.on('data', (b) => (output = (output + b).slice(-12000)));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(root, { recursive: true, force: true });
    });
    let ready = false;
    for (let n = 0; n < 200; n++) {
      if (child.exitCode !== null || child.signalCode !== null)
        assert.fail(output);
      try {
        const response = await fetch(url + '/api/health', {
          headers: { Connection: 'close' },
        });
        ready = response.ok;
        await response.body.cancel();
        if (ready) break;
      } catch {}
      await new Promise((done) => setTimeout(done, 30));
    }
    assert.ok(ready, output);
    const config = JSON.parse(await readFile(env.INK_OS_CONFIG)),
      sdk = createClient({
        url,
        token: config.token,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...init.headers, Connection: 'close' },
          }),
      }),
      files = uiFiles().files;
    for (const file of files)
      await writeFile(
        join(source, file.path),
        Buffer.from(file.base64, 'base64'),
      );
    const git = async (...args) =>
      execute('git', ['-C', source, ...args], { env });
    await git('init', '-b', 'main');
    await git('add', '--all');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=' + join(source, '.git/no-hooks'),
      'commit',
      '-m',
      'Typed UI source',
    );
    const deployed = JSON.parse(
        (
          await execute(
            process.execPath,
            ['cli/bin/ink-os.mjs', 'deploy', source],
            { env, maxBuffer: 4 * 1024 * 1024 },
          )
        ).stdout,
      ),
      ui = sdk.apps.ink.ui(deployed.appId),
      frame = await ui.open(),
      nav = frame.tree.nodes.find(
        (node) => node.kind === 'NavItem' && node.props.text === 'Second',
      );
    assert.equal(
      (await ui.event(frame.id, event(frame, nav, 'Activate'))).event.status,
      'accepted',
    );
    assert.equal((await ui.refresh(frame.id, { revision: 0 })).target, 'dom');
    const readKey = await sdk.account.keys.create({
        name: 'ui-read',
        scopes: ['apps:read'],
      }),
      readClient = createClient({ url, token: readKey.token });
    await assert.rejects(readClient.apps.ink.ui(deployed.appId).open(), {
      status: 403,
    });
    const invokeKey = await sdk.account.keys.create({
        name: 'ui-invoke',
        scopes: ['apps:invoke'],
      }),
      invokeClient = createClient({ url, token: invokeKey.token }),
      scoped = invokeClient.apps.ink.ui(deployed.appId),
      scopedFrame = await scoped.open();
    assert.equal(scopedFrame.format, 'ink-ui-v1');
    await scoped.dispose(scopedFrame.id);
    await assert.rejects(scoped.refresh(scopedFrame.id, { revision: 0 }), {
      status: 410,
    });
    const preview = await sdk.ink.previews.create({ files }),
      previewUi = 'ink/previews/' + preview.id + '/ui',
      mounted = await sdk.request(previewUi, {
        method: 'POST',
        body: { target: 'dom' },
      });
    assert.equal(mounted.releaseId, null);
    await assert.rejects(
      sdk.request(previewUi + '/' + frame.id + '/refresh', {
        method: 'POST',
        body: { revision: 0 },
      }),
      { status: 403 },
    );
    await sdk.request(previewUi + '/' + mounted.id, { method: 'DELETE' });
    const { loadInkSystem } = await import('../cli/bin/ink-system.mjs'),
      { fileURLToPath } = await import('node:url');
    const systemInput = await loadInkSystem(
      fileURLToPath(new URL('../examples/tables-system/', import.meta.url)),
    );
    await assert.rejects(
      readClient.ink.systems.build({ version: 1, apps: [], links: [] }),
      { status: 403 },
    );
    const system = await sdk.ink.systems.deploy(systemInput),
      again = await sdk.ink.systems.deploy(systemInput);
    assert.deepEqual(again, system);
    assert.equal(system.status, 'deployed');
    const queryUi = sdk.apps.ink.ui(system.apps.dashboard.appId),
      queryFrame = await queryUi.open();
    await sdk.apps.ink.run(
      system.apps.tables.appId,
      'put',
      '[0,{"id":1,"title":"Connected API","amount":7,"open":true}]',
    );
    const changed = await queryUi.refresh(queryFrame.id, {
      revision: queryFrame.revision,
    });
    assert.deepEqual(changed.computed, ['results']);
    assert.ok(
      changed.patch.operations.some(
        (op) =>
          op.props?.text === 'Open total: 7' ||
          op.node?.props.text === 'Open total: 7',
      ),
    );
    await queryUi.dispose(queryFrame.id);
    await ui.dispose(frame.id);
    await assert.rejects(ui.refresh(frame.id, { revision: 0 }), {
      status: 410,
    });
  },
);
