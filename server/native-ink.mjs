import { compileInk, compilerInfo, compilerRequest } from './ink-compiler.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execute = promisify(execFile);
const cargoManifest = `[package]
name="ink-native-app"
version="0.1.0"
edition="2021"
[dependencies]
num-bigint="=0.4.8"
serde_json={version="=1.0.154",features=["float_roundtrip"]}
sha2="=0.10.9"
[workspace]
[profile.release]
debug=0
incremental=false
`;
const driver = `
fn main(){
 use std::io::Read;
 let result=(||->Result<serde_json::Value,String>{
  let mut input=String::new();std::io::stdin().take(1048577).read_to_string(&mut input).map_err(|e|e.to_string())?;
  if input.len()>1048576{return Err("Request exceeds 1 MiB".into());}
  let request:serde_json::Value=serde_json::from_str(&input).map_err(|e|e.to_string())?;
  let mut state=if let Some(values)=request["snapshot"].as_array(){let bytes=values.iter().map(|v|v.as_u64().and_then(|n|u8::try_from(n).ok()).ok_or("Invalid snapshot byte")).collect::<Result<Vec<u8>,_>>()?;State::restore(&bytes)?}else{State::new()};
  let entry=request["entry"].as_str().ok_or("Missing entry")?;
  let value=if request["kind"]=="function"{state.call_json(entry,&request["args"])?}else{state.invoke_json(entry,&request["args"])?};
  Ok(serde_json::json!({"output":value,"snapshot":state.checkpoint()?}))
 })();
 match result{Ok(value)=>println!("{}",value),Err(error)=>{println!("{}",serde_json::json!({"error":error}));std::process::exit(1);}}
}
`;

export class NativeInk {
  constructor(directory, { cargo = 'cargo', rustc = 'rustc', offline = false } = {}) {
    Object.assign(this, { directory, cargo, rustc, offline });
    this.tail = Promise.resolve();
  }
  async availability() {
    try {
      const [rust, cargo] = await Promise.all([execute(this.rustc, ['-vV']), execute(this.cargo, ['--version'])]);
      return { available: true, rust: rust.stdout.trim(), cargo: cargo.stdout.trim() };
    } catch { return { available: false, reason: 'Install the managed native toolchain pack to enable native compilation.' }; }
  }
  build(source, { namespace = 'preview' } = {}) {
    const task = this.tail.then(() => this.buildSource(source, namespace));
    this.tail = task.catch(() => {}); return task;
  }
  async buildSource(source, namespace) {
    const toolchain = await this.availability();
    if (!toolchain.available) throw Object.assign(Error(toolchain.reason), { status: 503 });
    const artifact = await compileInk(source);
    if (!artifact.rust) throw Object.assign(Error(artifact.rust_reason || 'Native target is unsupported for this program.'), { status: 422 });
    const info = await compilerInfo();
    const id = createHash('sha256').update(JSON.stringify({ source, namespace, compiler: info.sha256, toolchain, manifest: cargoManifest, driver })).digest('hex');
    const directory = join(this.directory, id), executable = join(directory, process.platform === 'win32' ? 'program.exe' : 'program');
    try { await access(executable); return { id, target: 'native', sourceIdentity: artifact.manifest.core_sha256, cached: true }; } catch {}
    await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'Cargo.toml'), cargoManifest);
    await writeFile(join(directory, 'src/main.rs'), artifact.rust + driver);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME)/.test(name)));
    Object.assign(env, { CARGO_TARGET_DIR: join(this.directory, 'target'), CARGO_INCREMENTAL: '0', CARGO_PROFILE_RELEASE_DEBUG: '0', RUSTFLAGS: `--remap-path-prefix=${homedir()}=/build` });
    const args = ['build', '--release', '--manifest-path', join(directory, 'Cargo.toml')];
    if (this.offline) args.push('--offline');
    await execute(this.cargo, args, { env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    await copyFile(join(env.CARGO_TARGET_DIR, 'release', process.platform === 'win32' ? 'ink-native-app.exe' : 'ink-native-app'), executable);
    await chmod(executable, 0o700);
    await writeFile(join(directory, 'artifact.json'), JSON.stringify({ id, namespace, source, compiler: info.sha256, toolchain, sourceIdentity: artifact.manifest.core_sha256 }), { mode: 0o600 });
    return { id, target: 'native', sourceIdentity: artifact.manifest.core_sha256, cached: false };
  }
  async run(id, { namespace = 'preview', entry, args = [], snapshot } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw Error('Invalid native artifact ID.');
    const directory = join(this.directory, id), record = JSON.parse(await readFile(join(directory, 'artifact.json'), 'utf8'));
    if (record.namespace !== namespace) throw Object.assign(Error('Native artifact belongs to another app.'), { status: 403 });
    const artifact = await compileInk(record.source);
    const prepared = await compilerRequest({ op: 'prepare', core: artifact.core, identity: artifact.manifest.core_sha256, entry, input: JSON.stringify(args) });
    const action = artifact.manifest.state?.actions.find(action => action.name === entry);
    const kind = action ? action.change ? 'change' : 'query' : 'function';
    const input = '{"entry":' + JSON.stringify(entry) + ',"kind":' + JSON.stringify(kind) + ',"args":' + prepared.input + (snapshot ? ',"snapshot":' + JSON.stringify([...Buffer.from(snapshot, 'base64')]) : '') + '}';
    return new Promise((resolve, reject) => {
      const child = spawn(join(directory, process.platform === 'win32' ? 'program.exe' : 'program'), [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(Error('Native execution exceeded 30 seconds.')); }, 30000);
      child.on('error', finish);
      child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 8 * 1024 * 1024) { child.kill(); finish(Error('Native output exceeds 8 MiB.')); } });
      child.on('exit', code => {
        try {
          const result = JSON.parse(output, (_key, value, context) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source || '') ? context.source : value);
          if (code || result.error) throw Error(result.error || 'Native execution failed.');
          finish(null, { output: result.output, snapshot: Buffer.from(result.snapshot).toString('base64'), backend: 'native', sourceIdentity: record.sourceIdentity });
        } catch (error) { finish(error); }
      });
      child.stdin.on('error', error => finish(error)); child.stdin.end(input);
    });
  }
}
