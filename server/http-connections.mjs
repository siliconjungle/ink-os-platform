export function httpConnections(server) {
  const active = new Map();
  let closing = false, task;
  server.on('connection', socket => {
    active.set(socket, 0);
    socket.once('close', () => active.delete(socket));
  });
  server.prependListener('upgrade', (_request, socket) => active.delete(socket));
  server.prependListener('request', (request, response) => {
    const socket = request.socket;
    active.set(socket, (active.get(socket) || 0) + 1);
    let finished = false;
    const done = () => {
      if (finished) return; finished = true;
      if (!active.has(socket)) return;
      const remaining = active.get(socket) - 1; active.set(socket, remaining);
      if (closing && remaining === 0) socket.end();
    };
    response.once('finish', done); response.once('close', done);
  });
  return {
    get closing() { return closing; },
    close() {
      if (task) return task;
      closing = true;
      task = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const [socket, requests] of active) if (requests === 0) socket.end();
      return task;
    },
  };
}
