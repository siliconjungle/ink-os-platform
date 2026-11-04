import { Code } from '../../server/code.mjs';
const code = new Code('.', process.argv[2]),
  batch = code.storage.batch;
code.storage.batch = async (...args) => {
  const result = await batch(...args);
  if (args[3].some((item) => item.value?.format === 'ink-os-app-journal-v2')) {
    process.send('durable');
    await new Promise(() => {});
  }
  return result;
};
await code.run({
  source:
    'module count; state Total:u32=0; change add(n:u32)->u32 reads(Total) writes(Total){Total=Total+n;return Total;} query total()->u32 reads(Total){return Total;}',
  entry: 'add',
  args: [7],
  instance: 'one',
  requestId: 'crash',
});
