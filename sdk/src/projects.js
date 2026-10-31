export function createProjects(request) {
  const base = id => 'projects/' + encodeURIComponent(id);
  return {
    list: () => request('projects'),
    get: id => request(base(id)),
    create: input => request('projects', { method: 'POST', body: input }),
    configure: (id, input) => request(base(id), { method: 'PATCH', body: input }),
    status: id => request(base(id) + '/status'),
    duplicate: (id, input = {}) => request(base(id) + '/duplicate', { method: 'POST', body: input }),
    import: input => request('projects/import', { method: 'POST', body: input }),
    // expectedCommit is optional for older callers; null explicitly requires an unborn project.
    snapshot: (id, input, options = {}) => {
      if (Object.hasOwn(options, 'expectedCommit') && Object.hasOwn(input, 'expectedCommit') && options.expectedCommit !== input.expectedCommit) throw Error('Conflicting expected project commits.');
      return request(base(id) + '/snapshot', { method: 'POST', body: { ...input, ...(Object.hasOwn(options, 'expectedCommit') ? { expectedCommit: options.expectedCommit } : {}) } });
    },
    files: (id, commit) => request(base(id) + '/files' + (commit ? '?commit=' + encodeURIComponent(commit) : '')),
    publication: id => request(base(id) + '/publication'),
    publish: (id, input = {}) => request(base(id) + '/publish', { method: 'POST', body: input }),
    readRemote: (id, input = {}) => request(base(id) + '/read-remote' + (input.expectedRemote ? '?expectedRemote=' + encodeURIComponent(input.expectedRemote) : '')),
    sourcePlan: (id, input = {}) => request(base(id) + '/source-plan' + (input.expectedRemote ? '?expectedRemote=' + encodeURIComponent(input.expectedRemote) : '')),
    pull: (id, input = {}) => request(base(id) + '/pull', { method: 'POST', body: input }),
    credentials: {
      status: id => request(base(id) + '/credentials'),
      set: (id, token) => request(base(id) + '/credentials', { method: 'PUT', body: { token } }),
      remove: id => request(base(id) + '/credentials', { method: 'DELETE' }),
    },
  };
}
