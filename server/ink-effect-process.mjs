import { runEffectProcess, effectFailure } from './ink-effect-io.mjs';
const controller = new AbortController();
// Parent IPC disconnection is also a resource-lifetime boundary after SIGKILL.
process.once('disconnect', () => controller.abort());
const timer = setTimeout(() => controller.abort(), 30000);
let started = false;
process.on('message', async (message) => {
  if (message.cancel) {
    controller.abort(
      effectFailure(
        message.code || 'Cancelled',
        'Process interrupted',
        'unknown',
      ),
    );
    return;
  }
  if (started) return;
  started = true;
  const send = (message) => {
    if (process.connected) process.send(message, () => {});
  };
  try {
    const value = await runEffectProcess(
      message.profile,
      message.request,
      controller.signal,
      message.directory,
      () => send({ dispatched: true }),
    );
    send({ result: { value } });
  } catch (error) {
    send({
      result: {
        error: {
          code: error.effectCode || 'Process',
          message: error.effectCode
            ? error.message
            : 'Process supervisor failed',
          certainty: error.certainty || 'unknown',
        },
      },
    });
  } finally {
    clearTimeout(timer);
    if (process.connected) process.disconnect();
  }
});
