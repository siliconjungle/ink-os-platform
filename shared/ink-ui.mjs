import { resolveEffectType, effectTypeEqual } from './ink-effects.mjs';
import { inkLinkPlan } from './ink-link-plan.mjs';
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const object = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed, required = allowed) =>
  object(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
const symbol = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value) &&
  !value.startsWith('__');
export const UI_KINDS = [
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
];
export const UI_EVENTS = ['Activate', 'Input', 'Change', 'Submit'];
export const UI_FIELD_KINDS = [
  'Text',
  'Number',
  'Email',
  'Url',
  'Date',
  'Multiline',
];
const scalar = (kind) => ({ kind }),
  record = (values) => ({
    kind: 'record',
    fields: Object.entries(values).map(([name, type]) => ({ name, type })),
  }),
  list = (element) => ({ kind: 'list', element }),
  option = (element) => ({ kind: 'option', element }),
  enumeration = (name, values) => ({
    kind: 'enum',
    name,
    variants: values.map((value) => name + '.' + value),
  });
const text = scalar('string'),
  bool = scalar('bool'),
  unit = scalar('unit'),
  u64 = scalar('u64');
export const UI_INPUT = record({
  text,
  checked: bool,
  fields: list(record({ name: text, text, checked: bool })),
});
const nodeFields = {
  id: text,
  kind: enumeration('UiKind', UI_KINDS),
  children: list(text),
  text,
  value: text,
  checked: bool,
  disabled: bool,
  label: text,
  description: text,
  selected: bool,
  invalid: bool,
  placeholder: text,
  fieldKind: enumeration('UiFieldKind', UI_FIELD_KINDS),
  options: list(record({ value: text, label: text, disabled: bool })),
};
export function inkUi(input) {
  if (
    !fields(
      input,
      ['version', 'entry', 'event', 'components'],
      ['version', 'entry', 'event'],
    ) ||
    input.version !== 1 ||
    !symbol(input.entry) ||
    !symbol(input.event) ||
    input.entry === input.event ||
    (input.components !== undefined &&
      (!Array.isArray(input.components) || input.components.length > 31))
  )
    fail(
      'Declare a version 1 typed Ink UI entry, event and at most 31 components',
    );
  const names = new Set(['root']),
    entries = new Set([input.entry]);
  return {
    version: 1,
    entry: input.entry,
    event: input.event,
    components: (input.components || []).map((component) => {
      if (
        !fields(
          component,
          ['name', 'entry', 'event', 'query', 'read', 'data'],
          ['name', 'entry', 'event'],
        ) ||
        !symbol(component.name) ||
        !symbol(component.entry) ||
        !symbol(component.event) ||
        component.entry === component.event ||
        names.has(component.name) ||
        entries.has(component.entry)
      )
        fail('UI components require unique names and readonly view entries');
      names.add(component.name);
      entries.add(component.entry);
      if (
        [
          component.query !== undefined,
          component.read !== undefined,
          component.data !== undefined,
        ].filter(Boolean).length > 1
      )
        fail('Choose one UI data source');
      if (component.data !== undefined && component.data !== true)
        fail('An unbound UI data port is true');
      if (component.read !== undefined) {
        const read = component.read;
        if (
          !fields(
            read,
            ['appId', 'releaseId', 'entry', 'input', 'plan'],
            ['appId', 'releaseId', 'entry'],
          ) ||
          !(
            (read.appId === 'self' && read.releaseId === 'self') ||
            (/^[a-f0-9]{32}$/.test(read.appId || '') &&
              /^[a-f0-9]{32}$/.test(read.releaseId || ''))
          ) ||
          !symbol(read.entry) ||
          (read.input !== undefined &&
            (typeof read.input !== 'string' ||
              new TextEncoder().encode(read.input).length > 65536))
        )
          fail(
            'UI reads bind an exact app, release, exported entry and bounded arguments',
          );
      }
      if (component.query !== undefined) {
        if (
          !object(component.query) ||
          component.query.format !== 'ink-relational-v1' ||
          BufferlessBytes(component.query) > 32768 ||
          component.query.cursor !== undefined
        )
          fail(
            'UI data inputs require a bounded fixed relational query without a cursor',
          );
        const visit = (value, depth = 0) => {
          if (depth > 32) fail('UI relational query nesting exceeds 32');
          if (value?.op === 'scan' && value.namespace !== 'self')
            fail('UI query scans use the fixed self namespace');
          if (value?.op === 'join') {
            visit(value.left, depth + 1);
            visit(value.right, depth + 1);
          } else if (value?.input) visit(value.input, depth + 1);
        };
        visit(component.query.relation);
      }
      return {
        ...component,
        ...(component.query ? { query: structuredClone(component.query) } : {}),
        ...(component.read?.plan !== undefined
          ? { read: { ...component.read, plan: inkLinkPlan(component.read.plan) } }
          : {}),
      };
    }),
  };
}
const BufferlessBytes = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function inkUiComponents(spec, entries, named = {}) {
  if (!spec.ui) return [];
  const components = [
    { name: 'root', entry: spec.ui.entry, event: spec.ui.event },
    ...spec.ui.components,
  ];
  return components.map((component) => {
    const view = entries.find((entry) => entry.name === component.entry),
      event = entries.find((entry) => entry.name === component.event);
    if (
      !view ||
      view.change ||
      view.effectProtocol ||
      view.hostBinding ||
      view.params.length !==
        (component.query || component.read || component.data ? 1 : 0) ||
      !event ||
      !spec.exports.includes(event.name) ||
      event.hostBinding ||
      event.params.length !== 1
    )
      fail(
        'Typed UI components require readonly views and exported one-argument event handlers',
      );
    const result = resolveEffectType(view.result, named),
      node = result.fields?.find((field) => field.name === 'nodes')?.type
        ?.element,
      action = node?.fields?.find((field) => field.name === 'activate')?.type;
    if (action?.kind !== 'option') fail('Views must return UiView<Action>');
    const expected = record({
      ...nodeFields,
      activate: action,
      input: action,
      change: action,
      submit: action,
      component: text,
    });
    if (!effectTypeEqual(result, record({ root: text, nodes: list(expected) })))
      fail('Views must use the version 1 typed UI schema');
    const eventType = record({
      node: text,
      kind: enumeration('UiEventKind', UI_EVENTS),
      action: action.element,
      input: UI_INPUT,
    });
    if (
      !effectTypeEqual(
        resolveEffectType(event.params[0].type, named),
        eventType,
      )
    )
      fail('UI event action/input type does not match its view');
    const eventResult = resolveEffectType(event.result, named);
    if (
      !effectTypeEqual(eventResult, unit) &&
      !effectTypeEqual(eventResult, { kind: 'result', ok: unit, error: text })
    )
      fail('UI event handlers return Unit or Result<Unit,String>');
    let data;
    if (component.query || component.read || component.data) {
      data = resolveEffectType(view.params[0].type, named);
      const rows = data.fields?.find((field) => field.name === 'rows')?.type;
      if (
        rows?.kind !== 'list' ||
        !effectTypeEqual(
          data,
          record({ rows, total: option(u64), version: u64 }),
        )
      )
        fail('Data-backed views accept UiData<Row>');
    }
    return {
      ...component,
      action: action.element,
      ...(data ? { data } : {}),
      ...(component.data === true ? { port: true } : {}),
    };
  });
}
