import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
async function inputJSON(file,limit=64*1024*1024) {
  if (typeof file !== 'string' || !file) throw Error('Provide an explicit input file');
  const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw Error('Migration input must be a regular file below 64 MiB');
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > limit) throw Error('Migration input changed while reading');
    return JSON.parse(bytes);
  } finally { await handle.close(); }
}
export async function migrationCLI({ sub, action, operation, options, request, print }) {
  if (sub === 'storage-aliases' && action === 'apply') {
    if (options.plan || options.output) throw Error('Use storage-aliases apply --file INPUT');
    return print(await request('migrations/storage-aliases', 'POST', await inputJSON(options.file)));
  }
  if (sub === 'automation' && ['preview-schedule','review-schedule'].includes(action)) {
    const input=await inputJSON(options.file);
    if(action==='review-schedule') { if(options.approve!==true)throw Error('Review the schedule preview and pass --approve; this keeps the schedule disabled'); input.approved=true; }
    return print(await request('migrations/automation/'+(action==='preview-schedule'?'schedule-preview':'schedule-review'),'POST',input));
  }
  if (!['namespaces','automation'].includes(sub) || !['plan', 'apply', 'status'].includes(action)) throw Error('Use migrations namespaces plan|apply --file INPUT [--plan PLAN] [--output FILE], or status OPERATION');
  if (action === 'status') {
    if (!/^[a-f0-9]{32}$/.test(operation || '') || options.file || options.plan) throw Error('Provide the exact namespace migration operation ID');
    return print(await request('migrations/'+sub+'/' + operation));
  }
  const input = await inputJSON(options.file);
  if (Object.hasOwn(input, 'expected')) throw Error('Keep expected out of the input; apply reads the inspected --plan file');
  if (action === 'apply') {
    const plan = await inputJSON(options.plan);
    if (plan?.format !== (sub==='automation'?'ink-os-automation-plan-v1':'ink-os-namespace-plan-v1') || !plan.expected) throw Error('Provide the exact inspected namespace --plan file');
    input.expected = plan.expected;
  } else if (options.plan) throw Error('--plan belongs to an explicit apply operation');
  const result = await request('migrations/'+sub+'/' + action, 'POST', input);
  if (!options.output) return print(result);
  if (typeof options.output !== 'string') throw Error('Provide an explicit output path');
  const path = resolve(options.output);
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return print({ path, format: result.format });
}

export async function maintenanceCLI({sub,id,options,request,print}) {
 if(sub==='status') { if(!/^[a-f0-9]{32}$/.test(id||''))throw Error('Provide the maintenance operation ID'); return print(await request('maintenance/'+id)); }
 if(!['prepare','complete','cancel','seal'].includes(sub))throw Error('Use maintenance prepare --file INPUT, status ID, complete ID --file INPUT or cancel ID --file INPUT');
 if(sub!=='prepare'&&!/^[a-f0-9]{32}$/.test(id||''))throw Error('Provide the maintenance operation ID');
 return print(await request(sub==='prepare'?'maintenance/prepare':'maintenance/'+id+'/'+sub,'POST',await inputJSON(options.file,16384)));
}
