export async function projectRoute(platform, req, res, url, principal, { body, send }) {
  const path = url.pathname.slice('/api/v1'.length);
  if (!/^\/projects(?:\/|$)/.test(path)) return false;
  platform.owner(principal);
  const projects = platform.projects;
  if (path === '/projects' && req.method === 'GET') send(res, 200, projects.list());
  else if (path === '/projects' && req.method === 'POST') send(res, 201, await projects.create(await body(req)));
  else {
    const match = /^\/projects\/([a-f0-9]{32})(?:\/(status|duplicate))?$/.exec(path);
    if (!match) throw Object.assign(Error('Unknown project operation.'), { status: 404 });
    if (req.method === 'GET') send(res, 200, match[2] === 'status' ? await projects.status(match[1]) : projects.get(match[1]));
    else if (req.method === 'PATCH' && !match[2]) send(res, 200, await projects.update(match[1], await body(req)));
    else if (req.method === 'POST' && match[2] === 'duplicate') send(res, 201, await projects.duplicate(match[1], await body(req)));
    else throw Object.assign(Error('Unsupported project operation.'), { status: 405 });
  }
  return true;
}
