import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUiModel,
  validateUiTree,
  diffUiTree,
  UI_FORMAT,
  UI_KINDS,
} from '../sdk/src/ui-model.js';
const props = {
  text: '',
  value: '',
  checked: false,
  disabled: false,
  label: '',
  description: '',
  selected: false,
  invalid: false,
  placeholder: '',
  fieldKind: 'Text',
  options: [],
  valueToken: '',
};
const widget = (id, kind, children = [], extra = {}) => ({
  id,
  kind,
  children,
  props: { ...props, ...extra },
  events: [],
});
const tree = (nodes) => ({ format: UI_FORMAT, root: nodes[0].id, nodes });
const frame = (value, revision = 1, baseRevision = 0) => ({
  format: UI_FORMAT,
  revision,
  baseRevision,
  tree: value,
});
function fixture() {
  const calls = [],
    live = new Map();
  const adapter = {
    capabilities: {
      format: UI_FORMAT,
      kinds: UI_KINDS,
      layout: 'flow-v1',
      input: 'controls-v1',
      accessibility: 'semantic-v1',
      lifecycle: 'explicit-v1',
    },
    mount(node) {
      assert.ok(!live.has(node.id));
      live.set(node.id, node);
      calls.push(['mount', node.id]);
    },
    update(id) {
      assert.ok(live.has(id));
      calls.push(['update', id]);
    },
    children(id, children) {
      assert.ok(live.has(id));
      for (const child of children) assert.ok(live.has(child));
      calls.push(['children', id, ...children]);
    },
    root(id) {
      assert.ok(live.has(id));
    },
    dispose(id) {
      assert.ok(live.has(id));
      live.delete(id);
      calls.push(['dispose', id]);
    },
  };
  return { model: createUiModel(adapter), adapter, calls, live };
}
test('keyed patches retain identity, order lifecycle, and dispose each widget once', () => {
  const f = fixture(),
    a = tree([
      widget('list', 'List', ['a', 'b']),
      widget('a', 'Item', [], { text: 'A' }),
      widget('b', 'Item', [], { text: 'B' }),
    ]);
  f.model.apply(frame(a));
  f.calls.length = 0;
  const b = structuredClone(a);
  b.nodes[0].children = ['b', 'a'];
  b.nodes[1].props.text = 'Updated';
  f.model.apply({
    format: UI_FORMAT,
    revision: 2,
    baseRevision: 1,
    patch: diffUiTree(a, b),
  });
  assert.deepEqual(f.calls, [
    ['update', 'a'],
    ['children', 'list', 'b', 'a'],
  ]);
  f.calls.length = 0;
  f.model.apply(frame(b, 2, 2));
  assert.deepEqual(f.calls, []);
  f.model.dispose();
  assert.deepEqual(f.calls, [
    ['dispose', 'b'],
    ['dispose', 'a'],
    ['dispose', 'list'],
  ]);
  f.model.dispose();
  assert.equal(f.live.size, 0);
});
test('invalid whole patches and unsupported widgets fail before adapter effects', () => {
  const f = fixture(),
    a = tree([widget('root', 'Column', ['field']), widget('field', 'Field')]);
  f.model.apply(frame(a));
  f.calls.length = 0;
  assert.throws(
    () =>
      f.model.apply({
        format: UI_FORMAT,
        revision: 2,
        baseRevision: 1,
        patch: {
          root: 'root',
          operations: [
            {
              op: 'update',
              id: 'field',
              props: { ...props, text: 'changed' },
              events: [],
            },
            { op: 'children', id: 'root', children: ['absent'] },
          ],
        },
      }),
    /acyclic/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.model.revision, 1);
  assert.throws(() => f.model.apply(frame(a, 2, 0)), /base revision/);
  f.adapter.capabilities.kinds = ['Text'];
  assert.throws(() => f.model.apply(frame(a, 2, 1)), /Unsupported/);
  assert.deepEqual(f.calls, []);
  f.model.dispose();
});
test('portable model rejects nested forms, semantic hierarchy violations and invalid event kinds', () => {
  assert.throws(
    () =>
      validateUiTree(
        tree([widget('form', 'Form', ['inner']), widget('inner', 'Form')]),
      ),
    /nested/,
  );
  assert.throws(
    () =>
      validateUiTree(
        tree([widget('table', 'Table', ['text']), widget('text', 'Text')]),
      ),
    /hierarchy/,
  );
  const invalid = tree([widget('text', 'Text')]);
  invalid.nodes[0].events = [{ kind: 'Submit', token: 'a'.repeat(32) }];
  assert.throws(() => validateUiTree(invalid), /Unsupported event/);
});
test('kind replacement detaches retained children before disposal; session rebase preserves identity', () => {
  const f = fixture(),
    a = tree([widget('root', 'Column', ['child']), widget('child', 'Text')]);
  f.model.apply(frame(a));
  f.calls.length = 0;
  const b = structuredClone(a);
  b.nodes[0].kind = 'Panel';
  f.model.apply(frame(b, 2, 1));
  assert.deepEqual(f.calls, [
    ['children', 'root'],
    ['dispose', 'root'],
    ['mount', 'root'],
    ['children', 'root', 'child'],
  ]);
  f.calls.length = 0;
  f.model.rebase(frame(b));
  assert.deepEqual(f.calls, []);
  f.model.dispose();
});
