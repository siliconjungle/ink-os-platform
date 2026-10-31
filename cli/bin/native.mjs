export async function nativeCLI({ sub, appId, jobId, options, request, print }) {
  if (sub === 'status' || !sub) return print(await request('native'));
  if (!/^[a-f0-9]{32}$/.test(appId || '')) throw Error('Provide an installed app ID.');
  if (sub === 'jobs') return print(await request('apps/' + appId + '/native'));
  if (sub === 'get') return print(await request('apps/' + appId + '/native/' + jobId));
  if (sub !== 'build') throw Error('Use native status, build APP_ID [--wait], jobs APP_ID, or get APP_ID JOB_ID.');
  let job = await request('apps/' + appId + '/native/build', 'POST', options.release ? { releaseId: options.release } : {});
  if (options.wait) {
    const timeout = Number(options.timeout || 600000);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400000) throw Error('Use a native observation timeout of 1–86400000 ms.');
    const deadline = Date.now() + timeout;
    while (['queued', 'running', 'recovering'].includes(job.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(300, Math.max(1, deadline - Date.now()))));
      job = await request('apps/' + appId + '/native/' + job.id);
    }
    if (['queued', 'running', 'recovering'].includes(job.status)) return print({ ...job, observationTimedOut: true });
  }
  print(job);
  if (['failed', 'interrupted'].includes(job.status)) process.exitCode = 1;
}
