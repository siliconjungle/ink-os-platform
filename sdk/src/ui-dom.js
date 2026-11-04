import { createUiModel, UI_FORMAT, UI_KINDS } from './ui-model.js';
const controls = new Set(['Field', 'Toggle', 'Select']);
const tags = {
  Column: 'div',
  Row: 'div',
  Panel: 'section',
  Heading: 'h1',
  Text: 'p',
  Button: 'button',
  Field: 'label',
  Toggle: 'label',
  Select: 'label',
  List: 'ul',
  Item: 'li',
  Table: 'table',
  TableHead: 'thead',
  TableBody: 'tbody',
  TableRow: 'tr',
  HeaderCell: 'th',
  Cell: 'td',
  Form: 'form',
  Navigation: 'nav',
  NavItem: 'button',
  Component: 'div',
};
const sameText = (node, value) => {
  if (node.textContent !== value) node.textContent = value;
};
export function createDomUi(
  element,
  {
    onEvent = () => {},
    onDraftConflict = () => {},
    onLifecycle = () => {},
  } = {},
) {
  const document = element.ownerDocument,
    records = new Map(),
    parents = new Map();
  let disposed = false,
    savedFocus,
    busy = false;
  const create = (tag, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  function disabled(id) {
    for (let current = id; current; current = parents.get(current))
      if (records.get(current)?.props.disabled) return true;
    return false;
  }
  function binding(record, kind) {
    return record.events.find((event) => event.kind === kind);
  }
  function preserveFocus() {
    const active = document.activeElement;
    if (!active || !element.contains(active)) return;
    savedFocus = {
      element: active,
      start: active.selectionStart,
      end: active.selectionEnd,
      direction: active.selectionDirection,
      scrollTop: active.scrollTop,
      scrollLeft: active.scrollLeft,
    };
  }
  function restoreFocus() {
    const saved = savedFocus;
    savedFocus = null;
    if (!saved || !saved.element.isConnected) return;
    if (document.activeElement !== saved.element)
      saved.element.focus({ preventScroll: true });
    if (
      Number.isInteger(saved.start) &&
      typeof saved.element.setSelectionRange === 'function'
    )
      try {
        saved.element.setSelectionRange(
          saved.start,
          saved.end,
          saved.direction,
        );
      } catch {}
    saved.element.scrollTop = saved.scrollTop;
    saved.element.scrollLeft = saved.scrollLeft;
  }
  function move(parent, node, before) {
    if (node.parentNode === parent && node.nextSibling === before) return;
    if (
      typeof parent.moveBefore === 'function' &&
      parent.isConnected &&
      node.isConnected
    ) {
      parent.moveBefore(node, before);
      return;
    }
    preserveFocus();
    parent.insertBefore(node, before);
    restoreFocus();
  }
  function valueInput(record) {
    return {
      text: record.kind === 'Toggle' ? '' : record.input.value,
      checked: record.kind === 'Toggle' ? record.input.checked : false,
      expected: record.draft?.token || record.props.valueToken,
      fields: [],
    };
  }
  function snapshots(ids) {
    return ids.map((id) => ({
      id,
      generation: records.get(id)?.draft?.generation ?? 0,
      expected: records.get(id)?.draft?.token,
    }));
  }
  function emit(record, kind) {
    if (busy && ['Activate', 'Submit'].includes(kind)) return;
    const event = binding(record, kind);
    if (!event || disabled(record.id)) return;
    let input = { text: '', checked: false, expected: '', fields: [] },
      versions = [];
    if (kind === 'Submit') {
      const ids = [];
      const visit = (id) => {
        const current = records.get(id);
        if (controls.has(current.kind) && !disabled(id)) ids.push(id);
        for (const child of current.children) visit(child);
      };
      visit(record.id);
      input.fields = ids.map((id) => ({ id, ...valueInput(records.get(id)) }));
      for (const field of input.fields) delete field.fields;
      versions = snapshots(ids);
    } else if (kind === 'Input' || kind === 'Change') {
      input = valueInput(record);
      versions = snapshots([record.id]);
    }
    onEvent({ node: record.id, kind, token: event.token, input, versions });
  }
  function draft(record) {
    record.draft.generation++;
    record.draft.dirty = true;
    record.draft.text = record.input.value;
    record.draft.checked = record.input.checked;
  }
  function conflict(record) {
    const conflicted =
      record.draft.dirty && record.draft.token !== record.props.valueToken;
    record.conflict.hidden = !conflicted;
    if (conflicted) onDraftConflict(record.id);
  }
  function adopt(record) {
    const input = record.input,
      props = record.props;
    if (record.kind === 'Toggle') {
      if (input.checked !== props.checked) input.checked = props.checked;
    } else if (input.value !== props.value && !record.composing) {
      const start = input.selectionStart,
        end = input.selectionEnd;
      input.value = props.value;
      if (
        document.activeElement === input &&
        Number.isInteger(start) &&
        typeof input.setSelectionRange === 'function'
      )
        try {
          input.setSelectionRange(
            Math.min(start, input.value.length),
            Math.min(end, input.value.length),
          );
        } catch {}
    }
    record.draft = {
      ...record.draft,
      text: input.value,
      checked: input.checked,
      token: props.valueToken,
      dirty: false,
    };
    conflict(record);
  }
  function reconcile(record) {
    const desired = record.children.map((id) => records.get(id)?.element);
    if (desired.some((node) => !node)) throw Error('UI child was not mounted');
    if (
      typeof record.slot.moveBefore !== 'function' &&
      record.children.some((id) => hasComposition(id))
    )
      return;
    for (const child of [...record.slot.childNodes])
      if (
        records.get(child.dataset?.inkUiId)?.element === child &&
        !desired.includes(child)
      )
        record.slot.removeChild(child);
    let before = null;
    for (let i = desired.length - 1; i >= 0; i--) {
      const node = desired[i];
      if (node.parentNode !== record.slot || node.nextSibling !== before)
        move(record.slot, node, before);
      before = node;
    }
  }
  function hasComposition(id) {
    const record = records.get(id);
    return (
      !!record && (record.composing || record.children.some(hasComposition))
    );
  }
  function update(id, props, events) {
    const record = records.get(id);
    record.props = structuredClone(props);
    record.events = structuredClone(events);
    const target = record.element;
    if (record.label)
      sameText(
        record.label,
        controls.has(record.kind) ? props.label : props.text,
      );
    else if (
      !['Table', 'TableHead', 'TableBody', 'TableRow', 'Component'].includes(
        record.kind,
      )
    )
      sameText(record.text || target, props.text);
    if (record.kind === 'Table' && record.caption)
      sameText(record.caption, props.label);
    if (controls.has(record.kind)) {
      const input = record.input;
      input.placeholder = props.placeholder;
      input.setAttribute('aria-label', props.label);
      input.setAttribute('aria-invalid', String(props.invalid));
      if (record.kind === 'Select') {
        const old = new Map(
          [...input.options].map((option) => [option.value, option]),
        );
        for (const option of props.options) {
          const node = old.get(option.value) || create('option');
          node.value = option.value;
          node.disabled = option.disabled;
          sameText(node, option.label);
          input.append(node);
          old.delete(option.value);
        }
        for (const option of old.values()) option.remove();
        if (record.draft?.dirty) input.value = record.draft.text;
      }
      sameText(record.description, props.description);
      record.description.hidden = !props.description;
      input.setAttribute('aria-describedby', record.description.id);
      if (!record.draft)
        record.draft = { generation: 0, dirty: false, token: props.valueToken };
      if (!record.draft.dirty && !record.composing) adopt(record);
      else conflict(record);
    } else {
      if (props.label) target.setAttribute('aria-label', props.label);
      else target.removeAttribute('aria-label');
      if (props.description)
        target.setAttribute('aria-description', props.description);
      else target.removeAttribute('aria-description');
    }
    if (record.kind === 'NavItem') {
      if (props.selected) target.setAttribute('aria-current', 'page');
      else target.removeAttribute('aria-current');
    }
    if (record.kind === 'Item' || record.kind === 'TableRow') {
      if (binding(record, 'Activate')) {
        target.tabIndex = 0;
        target.setAttribute('aria-label', props.label || props.text);
      } else target.removeAttribute('tabindex');
    }
  }
  const adapter = {
    capabilities: {
      format: UI_FORMAT,
      target: 'dom',
      kinds: UI_KINDS,
      layout: 'flow-v1',
      input: 'controls-v1',
      accessibility: 'semantic-v1',
      lifecycle: 'explicit-v1',
    },
    mount(node) {
      const target = create(tags[node.kind], 'ink-ui-' + node.kind),
        record = {
          id: node.id,
          kind: node.kind,
          element: target,
          slot: target,
          props: node.props,
          events: [],
          children: [],
          controller: new AbortController(),
          composing: false,
        };
      records.set(node.id, record);
      if (node.kind === 'HeaderCell') target.scope = 'col';
      target.dataset.inkUiId = node.id;
      const listen = (target, type, listener) =>
        target.addEventListener(type, listener, {
          signal: record.controller.signal,
        });
      if (controls.has(node.kind)) {
        record.label = create('span');
        record.input = create(
          node.kind === 'Select'
            ? 'select'
            : node.props.fieldKind === 'Multiline'
              ? 'textarea'
              : 'input',
        );
        record.description = create('span', 'ink-ui-description');
        record.description.id = 'ink-ui-desc-' + globalThis.crypto.randomUUID();
        record.conflict = create('button', 'ink-ui-conflict');
        record.conflict.type = 'button';
        record.conflict.hidden = true;
        sameText(record.conflict, 'Use updated value');
        listen(record.conflict, 'click', () => adopt(record));
        if (record.kind === 'Toggle') record.input.type = 'checkbox';
        else if (record.kind === 'Field' && record.input.tagName === 'INPUT')
          record.input.type = {
            Text: 'text',
            Number: 'text',
            Email: 'email',
            Url: 'url',
            Date: 'date',
          }[node.props.fieldKind];
        if (node.props.fieldKind === 'Number')
          record.input.inputMode = 'decimal';
        target.append(
          record.label,
          record.input,
          record.description,
          record.conflict,
        );
        listen(record.input, 'input', () => {
          draft(record);
          if (!record.composing) emit(record, 'Input');
        });
        listen(record.input, 'change', () => {
          draft(record);
          emit(record, 'Change');
        });
        listen(record.input, 'compositionstart', () => {
          record.composing = true;
        });
        listen(record.input, 'compositionend', () => {
          record.composing = false;
          draft(record);
          emit(record, 'Input');
          for (const parent of records.values()) reconcile(parent);
        });
      } else if (node.kind === 'Table') {
        record.caption = create('caption');
        target.append(record.caption);
      } else if (
        !['TableHead', 'TableBody', 'TableRow', 'Component'].includes(node.kind)
      ) {
        record.text = create('span');
        target.append(record.text);
      }
      if (node.kind === 'Form')
        listen(target, 'submit', (event) => {
          event.preventDefault();
          emit(record, 'Submit');
        });
      listen(target, 'click', (event) => {
        if (event.target === record.conflict) return;
        if (record.kind === 'Item' || record.kind === 'TableRow') {
          if (event.target.closest('button,input,select,textarea,a')) return;
        }
        emit(record, 'Activate');
      });
      if (node.kind === 'Item' || node.kind === 'TableRow')
        listen(target, 'keydown', (event) => {
          if (
            event.target === target &&
            (event.key === 'Enter' || event.key === ' ')
          ) {
            event.preventDefault();
            emit(record, 'Activate');
          }
        });
      update(node.id, node.props, node.events);
      onLifecycle({ type: 'mount', id: node.id, kind: node.kind });
    },
    update,
    children(id, children) {
      const record = records.get(id);
      for (const old of record.children)
        if (parents.get(old) === id) parents.delete(old);
      record.children = [...children];
      for (const child of children) parents.set(child, id);
      reconcile(record);
    },
    root(id) {
      const root = records.get(id)?.element;
      if (!root) throw Error('UI root was not mounted');
      if (element.firstChild !== root || element.childNodes.length !== 1) {
        preserveFocus();
        for (const child of [...element.childNodes])
          if (child !== root) child.remove();
        if (root.parentNode !== element) element.append(root);
        restoreFocus();
      }
      for (const record of records.values()) {
        const state =
            disabled(record.id) ||
            (busy && ['Button', 'NavItem'].includes(record.kind)),
          control = record.input || record.element;
        if ('disabled' in control && control.disabled !== state)
          control.disabled = state;
        if (record.element.getAttribute('aria-disabled') !== String(state))
          record.element.setAttribute('aria-disabled', String(state));
        if (record.kind === 'Button' || record.kind === 'NavItem') {
          let form = false;
          for (
            let current = parents.get(record.id);
            current;
            current = parents.get(current)
          )
            if (records.get(current).kind === 'Form') form = true;
          const type =
            record.kind === 'Button' && form && !binding(record, 'Activate')
              ? 'submit'
              : 'button';
          if (record.element.type !== type) record.element.type = type;
        }
      }
    },
    dispose(id) {
      const record = records.get(id);
      if (!record) return;
      record.controller.abort();
      records.delete(id);
      parents.delete(id);
      record.element.remove();
      onLifecycle({ type: 'dispose', id, kind: record.kind });
    },
  };
  const model = createUiModel(adapter);
  return Object.freeze({
    apply: (frame) => model.apply(frame),
    rebase(frame) {
      const old = new Map(
        [...records].map(([id, record]) => [
          id,
          JSON.stringify([
            record.props.value,
            record.props.checked,
            record.props.fieldKind,
            record.props.options,
          ]),
        ]),
      );
      const result = model.rebase(frame);
      for (const [id, record] of records)
        if (
          record.draft?.dirty &&
          old.get(id) ===
            JSON.stringify([
              record.props.value,
              record.props.checked,
              record.props.fieldKind,
              record.props.options,
            ])
        ) {
          record.draft.token = record.props.valueToken;
          conflict(record);
        }
      return result;
    },
    get revision() {
      return model.revision;
    },
    get tree() {
      return model.tree;
    },
    get records() {
      return records;
    },
    acknowledge(versions, ackFields = {}) {
      for (const version of versions || []) {
        const record = records.get(version.id);
        if (!record?.draft) continue;
        record.ownTokens ||= new Map();
        if (ackFields[version.id])
          record.ownTokens.set(version.expected, ackFields[version.id].token);
        while (record.ownTokens.size > 8)
          record.ownTokens.delete(record.ownTokens.keys().next().value);
        if (record.draft.generation === version.generation) {
          adopt(record);
        } else if (ackFields[version.id]) {
          record.draft.token = ackFields[version.id].token;
          conflict(record);
        }
      }
    },
    setBusy(value) {
      busy = !!value;
      if (model.tree) adapter.root(model.tree.root);
    },
    rebaseExpected(id, expected) {
      const record = records.get(id);
      let current = expected;
      for (let n = 0; n < 8 && record?.ownTokens?.has(current); n++) {
        const next = record.ownTokens.get(current);
        if (next === current) break;
        current = next;
      }
      return current === record?.draft?.token ? current : expected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      model.dispose();
    },
  });
}
