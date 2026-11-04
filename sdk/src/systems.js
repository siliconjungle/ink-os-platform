/** Build and deploy bounded, source-checked application systems as an owner. */
export function createSystems(request) {
  return Object.freeze({
    build: (input) =>
      request('ink/systems/build', { method: 'POST', body: { input } }),
    deploy: (input) =>
      request('ink/systems/deploy', { method: 'POST', body: { input } }),
  });
}
