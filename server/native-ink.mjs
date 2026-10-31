import { compileInk, compilerInfo, compilerRequest } from './ink-compiler.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { publicResult } from '../shared/ink-values.mjs';

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
struct InkBudgetAllocator;
static INK_ALLOCATED:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
fn ink_reserve(bytes:usize)->bool{INK_ALLOCATED.fetch_update(std::sync::atomic::Ordering::Relaxed,std::sync::atomic::Ordering::Relaxed,|old|old.checked_add(bytes).filter(|next|*next<=268435456)).is_ok()}
unsafe impl std::alloc::GlobalAlloc for InkBudgetAllocator{
 unsafe fn alloc(&self,layout:std::alloc::Layout)->*mut u8{
  if !ink_reserve(layout.size()){return std::ptr::null_mut();}
  let pointer=std::alloc::GlobalAlloc::alloc(&std::alloc::System,layout);
  if pointer.is_null(){INK_ALLOCATED.fetch_sub(layout.size(),std::sync::atomic::Ordering::Relaxed);}pointer
 }
 unsafe fn dealloc(&self,pointer:*mut u8,layout:std::alloc::Layout){std::alloc::GlobalAlloc::dealloc(&std::alloc::System,pointer,layout);INK_ALLOCATED.fetch_sub(layout.size(),std::sync::atomic::Ordering::Relaxed);}
 unsafe fn realloc(&self,pointer:*mut u8,layout:std::alloc::Layout,next:usize)->*mut u8{
  let old=layout.size();if next>old&&!ink_reserve(next-old){return std::ptr::null_mut();}
  let result=std::alloc::GlobalAlloc::realloc(&std::alloc::System,pointer,layout,next);
  if result.is_null(){if next>old{INK_ALLOCATED.fetch_sub(next-old,std::sync::atomic::Ordering::Relaxed);}}
  else if next<old{INK_ALLOCATED.fetch_sub(old-next,std::sync::atomic::Ordering::Relaxed);}result
 }
}
#[global_allocator]static INK_ALLOCATOR:InkBudgetAllocator=InkBudgetAllocator;
fn main(){
 use std::io::Read;
 let result=(||->Result<serde_json::Value,String>{
  let mut input=String::new();std::io::stdin().take(8388609).read_to_string(&mut input).map_err(|e|e.to_string())?;
  if input.len()>8388608{return Err("Request exceeds 8 MiB".into());}
  let request:serde_json::Value=serde_json::from_str(&input).map_err(|e|e.to_string())?;
  let mut state=if let Some(values)=request["snapshot"].as_array(){let bytes=values.iter().map(|v|v.as_u64().and_then(|n|u8::try_from(n).ok()).ok_or("Invalid snapshot byte")).collect::<Result<Vec<u8>,_>>()?;State::restore(&bytes)?}else{State::new()};
  let entry=request["entry"].as_str().ok_or("Missing entry")?;
  let value=if request["kind"]=="function"{state.call_json(entry,&request["args"])?}else{state.invoke_json(entry,&request["args"])?};
  let snapshot=if request["kind"]!="function"&&value["committed"]==true{Some(state.checkpoint()?)}else{None};
  Ok(serde_json::json!({"output":value,"snapshot":snapshot}))
 })();
 match result{Ok(value)=>println!("{}",value),Err(error)=>{println!("{}",serde_json::json!({"error":error}));std::process::exit(1);}}
}
`;

export class NativeInk {
  constructor(directory, { cargo = 'cargo', rustc = 'rustc', offline = false } = {}) {
    Object.assign(this, { directory, cargo, rustc, offline });
    this.tail = Promise.resolve();
    this.compilations = new Map();
  }
  async availability() {
    if (this.toolchain && this.toolchain.until > Date.now()) return this.toolchain.value;
    try {
      const [rust, cargo] = await Promise.all([execute(this.rustc, ['-vV'], { timeout: 5000 }), execute(this.cargo, ['--version'], { timeout: 5000 })]);
      const value = { available: true, rust: rust.stdout.trim(), cargo: cargo.stdout.trim() };
      this.toolchain = { until: Date.now() + 10000, value }; return value;
    } catch { return { available: false, reason: 'Native Rust toolchain is unavailable on this host.' }; }
  }
  async compile(source) {
    if (!this.compilations.has(source)) {
      const task = compileInk(source); this.compilations.set(source, task);
      task.catch(() => this.compilations.delete(source));
      if (this.compilations.size > 16) this.compilations.delete(this.compilations.keys().next().value);
    }
    return this.compilations.get(source);
  }
  async compatibility(source, namespace, compiled) {
    const artifact = compiled || await this.compile(source);
    if (!artifact.rust) throw Object.assign(Error(artifact.rust_reason || 'Native target is unsupported for this program.'), { status: 422 });
    const info = await compilerInfo(), lock = await readFile(new URL('./native-runtime.lock', import.meta.url));
    const host = { platform: process.platform, arch: process.arch };
    const compatibilityKey = createHash('sha256').update(JSON.stringify({ source, namespace, compiler: info.sha256, manifest: cargoManifest, lock: lock.toString(), driver, host })).digest('hex');
    return { compatibilityKey, artifact, info, lock, host };
  }
  async plan(source, namespace, compiled) {
    const context = await this.compatibility(source, namespace, compiled), toolchain = await this.availability();
    if (!toolchain.available) throw Object.assign(Error(toolchain.reason), { status: 503 });
    const id = createHash('sha256').update(JSON.stringify({ key: context.compatibilityKey, toolchain })).digest('hex');
    return { ...context, id, toolchain };
  }
  build(source, { namespace = 'preview', onProcess } = {}) {
    const task = this.tail.then(() => this.buildSource(source, namespace, onProcess));
    this.tail = task.catch(() => {}); return task;
  }
  async buildSource(source, namespace, onProcess) {
    const { id, toolchain, artifact, info, lock, compatibilityKey, host } = await this.plan(source, namespace);
    const directory = join(this.directory, id), executable = join(directory, process.platform === 'win32' ? 'program.exe' : 'program');
    try { await this.record(id, namespace); return { id, target: 'native', sourceIdentity: artifact.manifest.core_sha256, cached: true }; } catch (error) { if (!['ENOENT', 'INK_NATIVE_INTEGRITY'].includes(error.code)) throw error; }
    await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'Cargo.toml'), cargoManifest);
    await writeFile(join(directory, 'Cargo.lock'), lock);
    await writeFile(join(directory, 'src/main.rs'), artifact.rust + driver);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|SYSTEMROOT|SystemRoot|COMSPEC|CARGO_HOME|RUSTUP_HOME|RUSTUP_TOOLCHAIN|CC|CXX|AR|SDKROOT|DEVELOPER_DIR|CARGO_TARGET_[A-Z0-9_]+_LINKER)$/.test(name)));
    Object.assign(env, { RUSTC: this.rustc, CARGO_TARGET_DIR: join(this.directory, 'target'), CARGO_INCREMENTAL: '0', CARGO_PROFILE_RELEASE_DEBUG: '0', CARGO_ENCODED_RUSTFLAGS: [`--remap-path-prefix=${homedir()}=/build`, `--remap-path-prefix=${directory}=/ink/native`].join('\x1f') });
    const args = ['build', '--locked', '--release', '--manifest-path', join(directory, 'Cargo.toml')];
    if (this.offline) args.push('--offline');
    const task = execute(this.cargo, args, { env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    task.catch(() => {});
    let notificationError;
    try { if (task.child.pid) await onProcess?.({ pid: task.child.pid, artifactId: id }); } catch (error) { notificationError = error; }
    await task;
    if (notificationError) throw notificationError;
    await copyFile(join(env.CARGO_TARGET_DIR, 'release', process.platform === 'win32' ? 'ink-native-app.exe' : 'ink-native-app'), executable);
    await chmod(executable, 0o700);
    const executableSHA256 = createHash('sha256').update(await readFile(executable)).digest('hex');
    await writeFile(join(directory, 'artifact.json'), JSON.stringify({ id, namespace, source, compiler: info.sha256, toolchain, host, compatibilityKey, executableSHA256, sourceIdentity: artifact.manifest.core_sha256 }), { mode: 0o600 });
    return { id, target: 'native', sourceIdentity: artifact.manifest.core_sha256, cached: false };
  }
  async record(id, namespace) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw Error('Invalid native artifact ID.');
    const directory = join(this.directory, id), record = JSON.parse(await readFile(join(directory, 'artifact.json'), 'utf8'));
    if (record.namespace !== namespace) throw Object.assign(Error('Native artifact belongs to another app.'), { status: 403 });
    if (record.host?.platform !== process.platform || record.host?.arch !== process.arch) throw Object.assign(Error('Rebuild this native artifact for the current host.'), { status: 409 });
    const executable = await readFile(join(directory, process.platform === 'win32' ? 'program.exe' : 'program'));
    if (createHash('sha256').update(executable).digest('hex') !== record.executableSHA256) throw Object.assign(Error('Native executable integrity check failed. Rebuild the native target to repair its cache.'), { status: 500, code: 'INK_NATIVE_INTEGRITY' });
    return record;
  }
  async run(id, { namespace = 'preview', entry, args = [], input: raw, snapshot } = {}) {
    const record = await this.record(id, namespace), directory = join(this.directory, id);
    const artifact = await this.compile(record.source);
    const prepared = await compilerRequest({ op: 'prepare', core: artifact.core, identity: artifact.manifest.core_sha256, entry, input: raw ?? stringifyExactJSON(args) });
    const action = artifact.manifest.state?.actions.find(action => action.name === entry);
    const kind = action ? action.change ? 'change' : 'query' : 'function';
    const input = '{"entry":' + JSON.stringify(entry) + ',"kind":' + JSON.stringify(kind) + ',"args":' + prepared.input + (snapshot ? ',"snapshot":' + JSON.stringify([...Buffer.from(snapshot, 'base64')]) : '') + '}';
    return new Promise((resolve, reject) => {
      const child = spawn(join(directory, process.platform === 'win32' ? 'program.exe' : 'program'), [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errorOutput = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(Error('Native execution exceeded 30 seconds.')); }, 30000);
      child.on('error', finish);
      child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 8 * 1024 * 1024) { child.kill(); finish(Error('Native output exceeds 8 MiB.')); } });
      child.stderr.on('data', bytes => { errorOutput = (errorOutput + bytes).slice(-8192); });
      child.on('close', code => {
        try {
          if (!output.trim()) throw Error('Native execution failed: ' + (errorOutput || 'process exited without a result.'));
          const result = parseExactJSON(output);
          if (code || result.error) throw Error(result.error || 'Native execution failed: ' + errorOutput);
          const selected = action ? { ...action, action: true } : artifact.manifest.functions.find(fn => fn.name === entry);
          const visible = publicResult(result.output, selected, artifact.manifest);
          finish(null, { ...visible, snapshot: result.snapshot ? Buffer.from(result.snapshot.map(Number)).toString('base64') : undefined, committed: !!action?.change && result.output.committed === true, backend: 'native', sourceIdentity: record.sourceIdentity });
        } catch (error) { finish(error); }
      });
      child.stdin.on('error', error => finish(error)); child.stdin.end(input);
    });
  }
}
