import { setTimeout as wait } from 'node:timers/promises';
import { quiescentHostActivity, quiescentRuntimePool } from './maintenance.mjs';

/** The caller owns closed external admission. Preserve accepted work while
 * shared store queues and the runtime pool reach verified quiescence. */
export async function waitForQuiescence({ adapter, signal, pollMs = 500, checkOwnership = () => {}, onPoolAdmission = () => {} }) {
  let poolClosed = false;
  for (;;) {
    signal?.throwIfAborted(); checkOwnership();
    if (quiescentHostActivity(await adapter.activity())) {
      let pool;
      try { pool = await adapter.quiesceSnapshot(); }
      catch (error) {
        // A concurrent inspection owns its own transaction. Observe again
        // after it settles; never seize its gate or repeat a provider action.
        if (error.status !== 409) throw error;
        await wait(pollMs, undefined, { signal }); continue;
      }
      poolClosed = pool?.admissionClosed === true; onPoolAdmission(poolClosed);
      if (quiescentRuntimePool(pool)) {
        try {
          await adapter.flush(); signal?.throwIfAborted(); checkOwnership();
          if (quiescentHostActivity(await adapter.activity())) return;
        } catch (error) { if (error?.code !== 'MAINTENANCE_ACTIVITY_CHANGED') throw error; }
      }
      adapter.continueDraining(); poolClosed = false; onPoolAdmission(false);
    } else if (poolClosed) {
      adapter.continueDraining(); poolClosed = false; onPoolAdmission(false);
    }
    await wait(pollMs, undefined, { signal });
  }
}
