/** Portable keyed widget model and ordered patch protocol, shared by adapters. */
export const UI_FORMAT = 'ink-ui-v1';
export const UI_KINDS = Object.freeze([
  'Column',
  'Row',
  'Panel',
  'Heading',
  'Text',
  'Button',
  'Field',
  'Toggle',
  'Select',
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
  'NavItem',
  'Component',
]);
export const UI_EVENTS = Object.freeze([
  'Activate',
  'Input',
  'Change',
  'Submit',
]);
const fail = (message) => {
    throw Error(message);
  },
  plain = (value) =>
    !!value && typeof value === 'object' && !Array.isArray(value);
export function validateUiTree(tree) {
  if (
    !plain(tree) ||
    tree.format !== UI_FORMAT ||
    typeof tree.root !== 'string' ||
    !Array.isArray(tree.nodes) ||
    !tree.nodes.length ||
    tree.nodes.length > 5000
  )
    fail('Invalid bounded UI tree');
  const nodes = new Map();
  let bytes = 0;
  for (const node of tree.nodes) {
    if (
      !plain(node) ||
      typeof node.id !== 'string' ||
      !node.id ||
      node.id.length > 1024 ||
      nodes.has(node.id) ||
      !UI_KINDS.includes(node.kind) ||
      !Array.isArray(node.children) ||
      node.children.some((child) => typeof child !== 'string') ||
      !plain(node.props) ||
      !Array.isArray(node.events) ||
      node.events.length > 4 ||
      node.events.some(
        (event) =>
          !plain(event) ||
          !UI_EVENTS.includes(event.kind) ||
          !/^[a-f0-9]{32}$/.test(event.token || ''),
      ) ||
      new Set(node.events.map((event) => event.kind)).size !==
        node.events.length
    )
      fail('Invalid UI node identity, shape or event binding');
    validateProps(node.props);
    nodes.set(node.id, node);
    bytes += new TextEncoder().encode(JSON.stringify(node)).length;
  }
  if (bytes > 1024 * 1024) fail('UI tree exceeds 1 MiB');
  const seen = new Set(),
    visit = (id, depth, insideForm = false) => {
      if (depth > 64 || seen.has(id) || !nodes.has(id))
        fail('UI nodes need one parent and an acyclic bounded tree');
      seen.add(id);
      const node = nodes.get(id);
      if (insideForm && node.kind === 'Form') fail('Forms cannot be nested');
      const eventKinds = {
        Activate: ['Button', 'NavItem', 'Item', 'TableRow'],
        Input: ['Field'],
        Change: ['Field', 'Toggle', 'Select'],
        Submit: ['Form'],
      };
      if (
        node.events.some((event) => !eventKinds[event.kind].includes(node.kind))
      )
        fail('Unsupported event binding for ' + node.kind);
      if (
        [
          'Heading',
          'Text',
          'Button',
          'Field',
          'Toggle',
          'Select',
          'NavItem',
        ].includes(node.kind) &&
        node.children.length
      )
        fail('Leaf widgets cannot contain children');
      if (new Set(node.children).size !== node.children.length)
        fail('Duplicate child identity');
      for (const child of node.children)
        visit(child, depth + 1, insideForm || node.kind === 'Form');
    };
  visit(tree.root, 0);
  for (const node of nodes.values()) {
    const allowed = {
      Table: ['TableHead', 'TableBody'],
      TableHead: ['TableRow'],
      TableBody: ['TableRow'],
      TableRow: ['HeaderCell', 'Cell'],
      List: ['Item'],
      Navigation: ['NavItem'],
    }[node.kind];
    if (
      allowed &&
      node.children.some((id) => !allowed.includes(nodes.get(id).kind))
    )
      fail('Invalid semantic widget hierarchy');
  }
  if (seen.size !== nodes.size) fail('UI tree contains unreachable nodes');
  return nodes;
}
function validateProps(props) {
  const names = [
    'text',
    'value',
    'checked',
    'disabled',
    'label',
    'description',
    'selected',
    'invalid',
    'placeholder',
    'fieldKind',
    'options',
    'valueToken',
  ];
  if (
    Object.keys(props).length !== names.length ||
    Object.keys(props).some((key) => !names.includes(key)) ||
    ['text', 'value', 'label', 'description', 'placeholder'].some(
      (key) => typeof props[key] !== 'string' || props[key].length > 65536,
    ) ||
    ['checked', 'disabled', 'selected', 'invalid'].some(
      (key) => typeof props[key] !== 'boolean',
    ) ||
    !['Text', 'Number', 'Email', 'Url', 'Date', 'Multiline'].includes(
      props.fieldKind,
    ) ||
    typeof props.valueToken !== 'string' ||
    (props.valueToken !== '' && !/^[a-f0-9]{32}$/.test(props.valueToken)) ||
    !Array.isArray(props.options) ||
    props.options.length > 256 ||
    props.options.some(
      (option) =>
        !plain(option) ||
        Object.keys(option).sort().join(',') !== 'disabled,label,value' ||
        typeof option.value !== 'string' ||
        typeof option.label !== 'string' ||
        typeof option.disabled !== 'boolean',
    ) ||
    new Set(props.options.map((option) => option.value)).size !==
      props.options.length
  )
    fail('Invalid typed UI properties');
}
function postorder(tree) {
  if (!tree) return [];
  const nodes = new Map(tree.nodes.map((node) => [node.id, node])),
    result = [];
  const visit = (id) => {
    const node = nodes.get(id);
    for (const child of node.children) visit(child);
    result.push(node);
  };
  visit(tree.root);
  return result;
}
export function diffUiTree(previous, next) {
  const before = previous ? validateUiTree(previous) : new Map(),
    after = validateUiTree(next),
    operations = [];
  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (
      !old ||
      old.kind !== node.kind ||
      (node.kind === 'Field' && old.props.fieldKind !== node.props.fieldKind)
    ) {
      operations.push({ op: 'mount', node });
      continue;
    }
    if (
      JSON.stringify(old.props) !== JSON.stringify(node.props) ||
      JSON.stringify(old.events) !== JSON.stringify(node.events)
    )
      operations.push({
        op: 'update',
        id: node.id,
        props: node.props,
        events: node.events,
      });
    if (JSON.stringify(old.children) !== JSON.stringify(node.children))
      operations.push({ op: 'children', id: node.id, children: node.children });
  }
  for (const node of postorder(previous))
    if (!after.has(node.id)) operations.push({ op: 'dispose', id: node.id });
  return { format: UI_FORMAT, root: next.root, operations };
}
/** Adapters must implement these lifecycle/layout/input/accessibility operations.
 * The core validates whole transactions before invoking an adapter. */
export function createUiModel(adapter) {
  for (const method of ['mount', 'update', 'children', 'root', 'dispose'])
    if (typeof adapter[method] !== 'function')
      throw Error('UI adapters implement ' + method);
  if (
    !adapter.capabilities ||
    adapter.capabilities.format !== UI_FORMAT ||
    !Array.isArray(adapter.capabilities.kinds) ||
    ['layout', 'input', 'accessibility', 'lifecycle'].some(
      (key) =>
        adapter.capabilities[key] !==
        {
          layout: 'flow-v1',
          input: 'controls-v1',
          accessibility: 'semantic-v1',
          lifecycle: 'explicit-v1',
        }[key],
    )
  )
    throw Error(
      'UI adapters declare their layout, input, accessibility and lifecycle capabilities',
    );
  let tree = null,
    revision = 0,
    closed = false;
  function apply(frame) {
    if (closed) throw Error('UI model is disposed');
    if (
      frame.format !== UI_FORMAT ||
      !Number.isSafeInteger(frame.revision) ||
      frame.revision < 1 ||
      frame.revision < revision
    )
      throw Error('Invalid UI frame revision');
    if (frame.baseRevision !== revision)
      throw Error('UI patch base revision changed');
    let next;
    if (frame.tree) next = structuredClone(frame.tree);
    else {
      const nodes = new Map(
        (tree?.nodes || []).map((node) => [node.id, structuredClone(node)]),
      );
      for (const operation of frame.patch?.operations || []) {
        if (operation.op === 'mount')
          nodes.set(operation.node.id, structuredClone(operation.node));
        else if (operation.op === 'dispose') nodes.delete(operation.id);
        else {
          const node = nodes.get(operation.id);
          if (!node) throw Error('UI patch references an absent node');
          if (operation.op === 'update') {
            node.props = structuredClone(operation.props);
            node.events = structuredClone(operation.events);
          } else if (operation.op === 'children')
            node.children = [...operation.children];
          else throw Error('Unknown UI patch operation');
        }
      }
      next = {
        format: UI_FORMAT,
        root: frame.patch?.root,
        nodes: [...nodes.values()],
      };
    }
    validateUiTree(next);
    if (
      next.nodes.some((node) => !adapter.capabilities.kinds.includes(node.kind))
    )
      throw Error('Unsupported widget in this UI adapter');
    const patch = diffUiTree(tree, next),
      old = new Map((tree?.nodes || []).map((node) => [node.id, node]));
    if (frame.revision === revision && patch.operations.length)
      throw Error('UI content changed without a revision');
    const childUpdates = new Set(
      patch.operations
        .filter(
          (operation) =>
            operation.op === 'mount' || operation.op === 'children',
        )
        .map((operation) => operation.id || operation.node.id),
    );
    try {
      for (const operation of patch.operations)
        if (operation.op === 'mount') {
          const replaced = old.get(operation.node.id);
          if (replaced) {
            adapter.children(replaced.id, []);
            adapter.dispose(replaced.id);
          }
          adapter.mount(operation.node);
        } else if (operation.op === 'update')
          adapter.update(operation.id, operation.props, operation.events);
      for (const node of next.nodes)
        if (childUpdates.has(node.id)) adapter.children(node.id, node.children);
      adapter.root(next.root);
      for (const operation of patch.operations)
        if (operation.op === 'dispose') adapter.dispose(operation.id);
    } catch (error) {
      closed = true;
      for (const id of new Set([
        ...(tree?.nodes || []).map((node) => node.id),
        ...next.nodes.map((node) => node.id),
      ])) {
        try {
          adapter.dispose(id);
        } catch {}
      }
      throw error;
    }
    tree = freeze(structuredClone(next));
    revision = frame.revision;
    return patch;
  }
  return Object.freeze({
    apply,
    rebase(frame) {
      if (!frame.tree || frame.baseRevision !== 0)
        throw Error('UI session reset requires a complete tree');
      revision = 0;
      return apply(frame);
    },
    get tree() {
      return tree;
    },
    get revision() {
      return revision;
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const node of postorder(tree)) adapter.dispose(node.id);
      tree = null;
    },
  });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
