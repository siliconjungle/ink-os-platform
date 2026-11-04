import { createHash } from 'node:crypto';
import { UI_KINDS, UI_EVENTS, UI_FIELD_KINDS } from '../shared/ink-ui.mjs';
import { validateUiTree, UI_FORMAT } from '../sdk/src/ui-model.js';
import { stringifyExactJSON } from '../shared/exact-json.mjs';
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const some = (value) =>
  Object.hasOwn(value || {}, 'Some') ? value.Some : undefined;
export const UI_CONTROLS = new Set(['Field', 'Toggle', 'Select']);
export const UI_EVENT_KINDS = {
  Activate: new Set(['Button', 'NavItem', 'Item', 'TableRow']),
  Input: new Set(['Field']),
  Change: new Set(['Field', 'Toggle', 'Select']),
  Submit: new Set(['Form']),
};
export function checkedLocalView(view) {
  if (
    !view ||
    !Array.isArray(view.nodes) ||
    view.nodes.length > 5000 ||
    !view.nodes.length ||
    typeof view.root !== 'string'
  )
    fail('Invalid bounded UiView');
  const nodes = new Map();
  for (const node of view.nodes) {
    if (
      !/^[A-Za-z0-9_.:-]{1,120}$/.test(node.id) ||
      nodes.has(node.id) ||
      !UI_KINDS.includes(node.kind?.slice(7)) ||
      !node.kind.startsWith('UiKind.') ||
      !Array.isArray(node.children) ||
      new Set(node.children).size !== node.children.length ||
      !UI_FIELD_KINDS.includes(node.fieldKind?.slice(12)) ||
      !node.fieldKind.startsWith('UiFieldKind.')
    )
      fail(
        'Typed UI nodes require unique stable IDs and supported widget kinds',
      );
    const kind = node.kind.slice(7);
    if (
      (kind === 'Component' && (node.children.length || !node.component)) ||
      (kind !== 'Component' && node.component)
    )
      fail('Only component slots can name a child component');
    if (
      ![
        'Column',
        'Row',
        'Panel',
        'List',
        'Item',
        'Table',
        'TableHead',
        'TableBody',
        'TableRow',
        'HeaderCell',
        'Cell',
        'Form',
        'Navigation',
        'Component',
      ].includes(kind) &&
      node.children.length
    )
      fail('This widget cannot contain child nodes');
    if (
      node.options.length > 256 ||
      new Set(node.options.map((option) => option.value)).size !==
        node.options.length
    )
      fail('Select choices require distinct bounded values');
    for (const event of UI_EVENTS)
      if (
        some(node[event.toLowerCase()]) !== undefined &&
        !UI_EVENT_KINDS[event].has(kind)
      )
        fail('Unsupported event binding for ' + kind);
    nodes.set(node.id, node);
  }
  const reached = new Set(),
    visit = (id, depth) => {
      if (depth > 64 || reached.has(id) || !nodes.has(id))
        fail('UiView requires a bounded tree with one parent per node');
      reached.add(id);
      for (const child of nodes.get(id).children) visit(child, depth + 1);
    };
  visit(view.root, 0);
  if (reached.size !== nodes.size) fail('UiView contains unreachable nodes');
  return nodes;
}
export async function composeUiTree({ mountId, readComponent }) {
  const nodes = [],
    bindings = new Map(),
    origins = new Map(),
    components = new Set();
  async function expand(name, prefix, stack = []) {
    if (stack.length >= 8 || stack.includes(name))
      fail('Component slots contain a recursive or excessive mount graph');
    const view = await readComponent(name),
      local = checkedLocalView(view);
    components.add(name);
    for (const raw of view.nodes) {
      if (nodes.length >= 5000) fail('Composed UI exceeds 5000 widgets');
      const id = prefix + '/' + raw.id,
        kind = raw.kind.slice(7),
        props = Object.fromEntries(
          [
            'text',
            'value',
            'checked',
            'disabled',
            'label',
            'description',
            'selected',
            'invalid',
            'placeholder',
            'options',
          ].map((key) => [key, raw[key]]),
        );
      props.fieldKind = raw.fieldKind.slice(12);
      const events = [];
      for (const event of UI_EVENTS) {
        const action = some(raw[event.toLowerCase()]);
        if (action !== undefined) {
          const wire = stringifyExactJSON(action);
          if (Buffer.byteLength(wire) > 65536)
            fail('UI action binding exceeds 64 KiB');
          const token = createHash('sha256')
            .update(mountId + '\0' + id + '\0' + event + '\0' + wire)
            .digest('hex')
            .slice(0, 32);
          events.push({ kind: event, token });
          bindings.set(id + '\0' + event, { action, component: name, token });
        }
      }
      props.valueToken = UI_CONTROLS.has(kind)
        ? createHash('sha256')
            .update(
              mountId +
                '\0' +
                id +
                '\0' +
                JSON.stringify([
                  props.value,
                  props.checked,
                  props.fieldKind,
                  props.options,
                ]),
            )
            .digest('hex')
            .slice(0, 32)
        : '';
      const node = {
        id,
        kind,
        props,
        events,
        children: raw.children.map((child) => prefix + '/' + child),
      };
      nodes.push(node);
      origins.set(id, { name: raw.id, component: name });
      if (kind === 'Component')
        node.children = [
          await expand(raw.component, id + '/@' + raw.component, [
            ...stack,
            name,
          ]),
        ];
    }
    return prefix + '/' + view.root;
  }
  const root = await expand('root', 'root'),
    tree = { format: UI_FORMAT, root, nodes };
  validateUiTree(tree);
  const byId = new Map(nodes.map((node) => [node.id, node])),
    parents = new Map();
  for (const node of nodes)
    for (const child of node.children) parents.set(child, node.id);
  const controls = (id) => {
    const found = [];
    const visit = (id) => {
      const node = byId.get(id);
      if (UI_CONTROLS.has(node.kind)) found.push(node);
      for (const child of node.children) visit(child);
    };
    visit(id);
    return found;
  };
  for (const node of nodes)
    if (node.kind === 'Form') {
      const names = controls(node.id).map(
        (control) => origins.get(control.id).name,
      );
      if (new Set(names).size !== names.length)
        fail('Form controls require unique local field names');
    }
  return { tree, bindings, origins, parents, components, byId, controls };
}
export function uiInput(frame, nodeId, kind, input) {
  const node = frame.byId.get(nodeId);
  if (!node || !UI_EVENT_KINDS[kind]?.has(node.kind))
    fail('The event does not belong to this widget');
  for (let id = nodeId; id; id = frame.parents.get(id))
    if (frame.byId.get(id).props.disabled) fail('This widget is disabled');
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'checked,expected,fields,text' ||
    typeof input.expected !== 'string' ||
    typeof input.text !== 'string' ||
    typeof input.checked !== 'boolean' ||
    !Array.isArray(input.fields) ||
    Buffer.byteLength(JSON.stringify(input)) > 128 * 1024
  )
    fail('Use the typed UiInput fields');
  if (kind === 'Submit') {
    if (input.text || input.checked || input.expected)
      fail('Submit input uses form fields');
    const expected = frame.controls(nodeId).filter((control) => {
        for (let id = control.id; id; id = frame.parents.get(id))
          if (frame.byId.get(id).props.disabled) return false;
        return true;
      }),
      received = new Map();
    for (const field of input.fields) {
      if (
        !field ||
        Object.keys(field).sort().join(',') !== 'checked,expected,id,text' ||
        typeof field.expected !== 'string' ||
        typeof field.id !== 'string' ||
        received.has(field.id) ||
        typeof field.text !== 'string' ||
        typeof field.checked !== 'boolean'
      )
        fail('Invalid form field');
      received.set(field.id, field);
    }
    if (
      received.size !== expected.length ||
      expected.some((control) => !received.has(control.id))
    )
      fail('Form fields must match the mounted form');
    return {
      text: '',
      checked: false,
      fields: expected.map((control) => {
        const field = received.get(control.id);
        checkControl(control, field);
        return {
          name: frame.origins.get(control.id).name,
          text: field.text,
          checked: field.checked,
        };
      }),
    };
  }
  if (input.fields.length) fail('Only Submit carries form fields');
  if (kind === 'Activate' && (input.text || input.checked || input.expected))
    fail('Activate has no control payload');
  if (kind !== 'Activate') checkControl(node, input);
  return { text: input.text, checked: input.checked, fields: [] };
}
function checkControl(node, input) {
  if (input.expected !== node.props.valueToken)
    throw Object.assign(
      Error('This field changed elsewhere; review the updated value'),
      { status: 409, current: { notApplied: true } },
    );
  if (node.kind === 'Toggle') {
    if (input.text) fail('Toggle input is a Bool');
  } else {
    if (input.checked) fail('Text/select input cannot carry a toggle');
    if (
      node.kind === 'Select' &&
      !node.props.options.some(
        (option) => option.value === input.text && !option.disabled,
      )
    )
      fail('Choose an enabled declared option');
  }
  if (Buffer.byteLength(input.text) > 65536)
    fail('Control input exceeds 64 KiB');
}
