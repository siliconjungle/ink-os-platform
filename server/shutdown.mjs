import { waitForQuiescence } from './quiescence.mjs';

export async function drainHost({ server, connections, platform, world, requests, responses, sockets, vite, admission, stopAdmission = () => {} }) {
  if (!admission) throw Error('Host shutdown requires its bound admission and checkpoint adapter.');
  admission.closeAdmission({ poolClosed: platform.provider?.pool?.admissionClosed === true });
  await waitForQuiescence({ adapter: admission, pollMs: 50 });
  await platform.publishTail;
  stopAdmission();
  const closed = connections.close();
  for (const response of responses) if (String(response.getHeader('content-type')).startsWith('text/event-stream')) response.end();
  for (const socket of sockets.clients) socket.close(1001, 'Host is stopping');
  await platform.nativeJobs?.close();
  await platform.provider?.close?.();
  await platform.collaboration.close();
  await world.persist();
  await closed;
  await vite?.close();
  clearInterval(platform.calls?.timer);
}
