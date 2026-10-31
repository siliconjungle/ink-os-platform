const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const entryName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{0,100}$/.test(value);

export function inkSpec(input, paths) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide an Ink application contract.');
  if (input.version !== undefined && input.version !== 1) fail('Unsupported Ink application contract version.');
  if (typeof input.source !== 'string' || !/^server\/[A-Za-z0-9_./-]+\.ink$/.test(input.source) || input.source.split('/').some(part => part === '..' || part === '.' || !part) || paths && !paths.has(input.source)) fail('Ink source must be a private server/*.ink release file.');
  if (input.view !== undefined && input.view !== null && !entryName(input.view)) fail('Choose a valid Ink view entry.');
  if (!Array.isArray(input.exports) || input.exports.length > 63 || input.exports.some(name => !entryName(name)) || new Set(input.exports).size !== input.exports.length) fail('Declare up to 63 unique Ink exports.');
  return { version: 1, source: input.source, view: input.view || null, exports: [...input.exports] };
}

export function inkEntries(manifest) {
  return [
    ...manifest.functions.filter(fn => !fn.internal && !fn.name.startsWith('__')).map(fn => ({ ...fn, action: false, change: false })),
    ...(manifest.state?.actions || []).filter(fn => !fn.name.startsWith('__')).map(fn => ({ ...fn, action: true })),
  ];
}

export function inkCommands(spec, entries) {
  if (spec.view) {
    const view = entries.find(entry => entry.name === spec.view);
    if (!view || view.change || view.params.length) fail('The Ink view must be an exported function or query without arguments.');
  }
  const ids = new Set();
  return spec.exports.map(name => {
    const entry = entries.find(entry => entry.name === name);
    if (!entry || entry.params.length > 16) fail('Ink command is missing or has more than 16 arguments: ' + name);
    const id = 'ink.' + name.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 59);
    if (ids.has(id)) fail('Ink exports have conflicting command names.');
    ids.add(id);
    return {
      id, title: name.replace(/_/g, ' '),
      description: 'Run ' + name + '.', keywords: ['ink'],
      inputs: entry.params.map((param, index) => ({ name: 'arg' + index, label: param.name, type: 'json', required: true })),
      handler: { type: 'ink', entry: name, arguments: entry.params.map((_param, index) => 'arg' + index) },
      effect: entry.change ? 'write' : 'read', idempotent: !entry.change,
      outputs: [{ label: 'Value', path: 'value', type: 'json' }, { label: 'Exact JSON', path: 'valueWire', type: 'json' }],
    };
  });
}
