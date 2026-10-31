const root = document.querySelector('#app'), status = document.querySelector('#status');
const fields = new Map();
const hostRevisions=new Map();
let ink, metadata, sequence = 0, timer, busy = false, hidden = false;
const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const report = (message = '', error = false) => { status.textContent = message; status.dataset.error = String(error); };
const node = (tag, label) => { const element = document.createElement(tag); if (label !== undefined) element.textContent = label; return element; };
async function run(entry, input = '[]') {
  const result=await ink.request('http', { path: '/code/run', method: 'POST', body: { entry, input } });if(result.hostRecord&&(result.hostRecord.effect==='write'||!hostRevisions.has(result.hostRecord.key)||![...fields.values()].some(field=>field.dirty)))hostRevisions.set(result.hostRecord.key,result.hostRecord.revision);return result;
}
function argumentsFor(input) {
  if (typeof input !== 'string' || !input.trim()) return '[]';
  // Field tokens retain JSON number text, including integers larger than Number.
  return input.replace(/\{"\$revision"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"\}/g,(_match,name)=>{const binding=metadata.ink.host?.bindings.find(binding=>binding.entry===name);if(!binding||!hostRevisions.has(binding.key))throw Error('Read this host record before editing it.');return String(hostRevisions.get(binding.key));}).replace(/\{"\$field"\s*:\s*"([A-Za-z0-9_-]+)"\}/g, (_match, name) => {
    const field = fields.get(name);
    if (!field) throw Error('Missing field: ' + name);
    return field.format === 'json' ? field.value : JSON.stringify(field.value);
  });
}
async function invoke(entry, input, button) {
  if (busy) return;
  busy = true; if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  try { report(); const result = await run(entry, argumentsFor(input)); if (!metadata.ink.view) report(result.valueWire+(result.hostRecord?' · record revision '+result.hostRecord.revision:'')); await refresh(); }
  catch (error) { report(error.message, true); }
  finally { busy = false; if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } }
}
function render(value, budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 5000 || depth > 64) throw Error('The view exceeds its node or depth limit.');
  if (value === null || typeof value !== 'object') return node('p', text(value));
  if (Array.isArray(value)) { const list = node('div'); list.className = 'ink-column'; for (const child of value) list.append(render(child, budget, depth + 1)); return list; }
  const kind = value.kind || 'json'; let element;
  if (['column', 'row', 'panel'].includes(kind)) { element = node('div'); element.className = 'ink-' + kind + (kind === 'panel' ? ' ink-column' : ''); }
  else if (kind === 'heading' || kind === 'text') element = node(kind === 'heading' ? 'h1' : 'p', text(value.text ?? ''));
  else if (kind === 'value') { element = node('div'); element.className = 'ink-value'; element.append(node('strong', text(value.value ?? '')), node('span', value.text || '')); }
  else if (kind === 'button') { element = node('button', value.text || value.entry || 'Run'); element.type = 'button'; element.disabled = !metadata.ink.exports.includes(value.entry); element.onclick = () => void invoke(value.entry, value.args, element); }
  else if (kind === 'field') {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(value.name || '')) throw Error('Fields require a unique name.');
    element = node('label'); element.className = 'ink-field';
    const input = node(value.multiline ? 'textarea' : 'input');
    if (!value.multiline) input.type = ['text', 'number', 'color', 'date', 'email', 'url', 'range'].includes(value.type) ? value.type : 'text';
    const stored = fields.get(value.name) || { value: String(value.value ?? ''), format: value.format === 'json' ? 'json' : 'text' };
    fields.set(value.name, stored); stored.element = input; input.dataset.field = value.name; input.value = stored.value; input.placeholder = value.placeholder || '';
    input.oninput = () => { stored.value = input.value; stored.dirty = true; };
    element.append(node('span', value.text || value.name), input);
  } else element = node('pre', text(value.value ?? value));
  if (['column', 'row', 'panel'].includes(kind)) for (const child of value.children || []) element.append(render(child, budget, depth + 1));
  return element;
}
async function refresh() {
  if (!metadata.ink.view) return;
  const version = ++sequence;
  try {
    const result = await run(metadata.ink.view);
    if (version !== sequence) return;
    const active = document.activeElement, focusedName = active?.dataset.field;
    const selection = focusedName && [active.selectionStart, active.selectionEnd];
    const view = render(result.value);
    // Keep edits and focus in place while remote state updates the surrounding UI.
    root.replaceChildren(view);
    if (focusedName) { const input = fields.get(focusedName)?.element; input?.focus(); if (selection?.every(Number.isInteger) && ['text', 'email', 'url'].includes(input?.type)) input.setSelectionRange(...selection); }
    root.setAttribute('aria-busy', 'false');
  } catch (error) { if (version === sequence) report(error.message, true); }
}
function commandView() {
  const view = node('div'); view.className = 'ink-column'; view.append(node('h1', metadata.title));
  for (const name of metadata.ink.exports) {
    const entry = metadata.entries.find(entry => entry.name === name), form = node('form'); form.className = 'ink-panel ink-column'; form.append(node('h2', name));
    const inputs = entry.params.map(param => { const label = node('label'), input = node('textarea'); label.className = 'ink-field'; input.rows = 2; input.value = param.type.kind === 'string' ? '""' : param.type.kind === 'bool' ? 'false' : param.type.kind === 'list' ? '[]' : '0'; label.append(node('span', param.name), input); form.append(label); return input; });
    const button = node('button', 'Run'); button.type = 'submit'; form.append(button); form.onsubmit = event => { event.preventDefault(); void invoke(name, '[' + inputs.map(input => input.value).join(',') + ']', button); }; view.append(form);
  }
  root.replaceChildren(view); root.setAttribute('aria-busy', 'false');
}
try {
  const response = await fetch('/app.json'); if (!response.ok) throw Error('App metadata is unavailable.'); metadata = await response.json(); document.title = metadata.title;
  ink = await window.Ink.connect(); ink.ready();
  ink.on('ink.state', () => { if (!hidden) { clearTimeout(timer); timer = setTimeout(() => void refresh(), 80); } });
  ink.on('visibility', value => { hidden = value.hidden; if (!hidden) void refresh(); });
  ink.on('context', context => { if (context.theme) document.documentElement.dataset.theme = context.theme; });
  if (metadata.ink.view) await refresh(); else commandView();
} catch (error) { root.setAttribute('aria-busy', 'false'); report(error.message, true); }
