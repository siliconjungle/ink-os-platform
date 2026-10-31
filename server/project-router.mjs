export async function projectRoute(platform, req, res, url, principal, { body, send }) {
  const path = url.pathname.slice('/api/v1'.length);
  if (!/^\/projects(?:\/|$)/.test(path)) return false;
  platform.owner(principal);
  const projects = platform.projects;
  if (path === '/projects' && req.method === 'GET') send(res, 200, projects.list());
  else if (path === '/projects' && req.method === 'POST') send(res, 201, await projects.create(await body(req)));
  else if (path === '/projects/import' && req.method === 'POST') send(res, 201, await projects.snapshot(await body(req, 34 * 1024 * 1024)));
  else {
    const match = /^\/projects\/([a-f0-9]{32})(?:\/(status|duplicate|snapshot|files))?$/.exec(path);
    if (!match) throw Object.assign(Error('Unknown project operation.'), { status: 404 });
    if (req.method === 'GET' && !['duplicate', 'snapshot'].includes(match[2])) send(res, 200, match[2] === 'status' ? await projects.status(match[1]) : match[2] === 'files' ? await projects.files(match[1], url.searchParams.get('commit') || undefined) : projects.get(match[1]));
    else if (req.method === 'PATCH' && !match[2]) send(res, 200, await projects.update(match[1], await body(req)));
    else if (req.method === 'POST' && match[2] === 'duplicate') send(res, 201, await projects.duplicate(match[1], await body(req)));
    else if (req.method === 'POST' && match[2] === 'snapshot') send(res, 200, await projects.snapshot(await body(req, 34 * 1024 * 1024), match[1]));
    else throw Object.assign(Error('Unsupported project operation.'), { status: 405 });
  }
  return true;
}
