export async function drainHost({ server, platform, world, requests, responses, sockets, vite, stopAdmission = () => {} }) {
  platform.schedules.close(); platform.workflows.close();
  while (requests.size || platform.workflows.active.size || platform.workflows.pumping || platform.schedules.ticking || platform.workflows.runs.some(run => run.status === 'queued') || platform.schedules.active.size) {
    await platform.workflows.pump();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await platform.publishTail;
  stopAdmission();
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const response of responses) if (String(response.getHeader('content-type')).startsWith('text/event-stream')) response.end();
  for (const socket of sockets.clients) socket.close(1001, 'Host is stopping');
  await platform.nativeJobs.close();
  await platform.provider?.close?.();
  await platform.collaboration.close();
  await world.persist();
  await closed;
  await vite?.close();
  clearInterval(platform.calls.timer);
}
