import { parentPort, workerData } from 'node:worker_threads';

try {
  const instance = await WebAssembly.instantiate(workerData.module, {}), api = instance.exports;
  const bytes = new TextEncoder().encode(JSON.stringify(workerData.request));
  if (bytes.length > 8 * 1024 * 1024) throw Error('Compiler request exceeds 8 MiB.');
  const pointer = api.ink_env_alloc(bytes.length);
  if (!pointer) throw Error('Compiler request allocation failed.');
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const result = api.ink_env_request(pointer, bytes.length), length = api.ink_env_response_len();
    if (length > 16 * 1024 * 1024) throw Error('Compiler response exceeds 16 MiB.');
    const response = JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer, result, length)));
    if (response.error) throw Error(response.error);
    parentPort.postMessage({ value: response.ok });
  } finally { api.ink_env_free(pointer, bytes.length); }
} catch (error) { parentPort.postMessage({ error: error.message }); }
