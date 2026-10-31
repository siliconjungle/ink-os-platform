import { isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statfs } from 'node:fs/promises';

const reasons = {
  INK_MANAGED_NATIVE_CONFIG: 'Managed native builds need the desktop’s trusted installer module and private cache directory. Repair or update the desktop installation.',
  INK_TOOLCHAIN_APPLE_SDK: 'Native builds require working Apple Command Line Tools or Xcode, including clang and the macOS SDK. Install Apple developer tools, then retry; JavaScript remains available.',
  INK_TOOLCHAIN_DISK_RESERVE: 'There is not enough free space for the managed Rust toolchain and its configured reserve. Free disk space, then retry the native build.',
  INK_TOOLCHAIN_BUSY: 'Another installer owns the managed Rust cache. Its work was preserved; retry when it finishes.',
  INK_TOOLCHAIN_STALE_LOCK: 'An interrupted installer left a cache lock. Have the desktop owner reconcile the stale lock before retrying; existing tools were preserved.',
  INK_TOOLCHAIN_INTEGRITY: 'Managed Rust integrity verification failed. Repair the native toolchain cache before retrying.',
  INK_TOOLCHAIN_CACHE: 'The managed Rust cache needs a private directory owned by the desktop user. Repair its ownership and permissions before retrying.',
  INK_TOOLCHAIN_DOWNLOAD: 'The pinned Rust distribution could not be downloaded. Check connectivity and retry the native build.',
  INK_TOOLCHAIN_DOWNLOAD_LIMIT: 'The Rust distribution exceeded its download budget. Update the desktop installer before retrying.',
  INK_TOOLCHAIN_ARCHIVE: 'The verified Rust archive format is unsupported by this desktop installer. Update the desktop installer before retrying.',
  INK_TOOLCHAIN_ARCHIVE_LIMIT: 'The Rust distribution exceeded its extraction budget. Update the desktop installer before retrying.',
  INK_TOOLCHAIN_ARCHIVE_CONFLICT: 'The Rust components contain conflicting distribution entries. Update the desktop installer before retrying.',
  INK_TOOLCHAIN_ARCHIVE_IO: 'The private Rust distribution could not be written. Check disk space and cache permissions before retrying.',
  INK_TOOLCHAIN_INSTALL: 'Private Rust installation failed. Check connectivity, disk space and cache permissions, then retry the native build; JavaScript remains available.',
};
const diagnostic = (error, fallback = 'INK_MANAGED_NATIVE_CONFIG') => {
  const code = Object.hasOwn(reasons, error?.code) ? error.code : fallback;
  return { available: false, installable: false, managed: true, code, reason: reasons[code] };
};
const freeSpace = async directory => {
  for (;;) {
    try { const info = await statfs(directory); return info.bavail * info.bsize; }
    catch (error) { const parent = dirname(directory); if (error.code !== 'ENOENT' || parent === directory) throw error; directory = parent; }
  }
};

/** Only the host owner can select this module through process environment. App build inputs
 *  never include module paths, cache directories, download origins or toolchain versions.
 */
export class ManagedNative {
  constructor({ modulePath, directory, load = url => import(url), freeBytes = freeSpace } = {}) {
    Object.assign(this, { modulePath, directory, load, freeBytes });
  }
  async installer() {
    if (!this.loading) this.loading = (async () => {
      if (!isAbsolute(this.modulePath || '') || !isAbsolute(this.directory || '')) throw Object.assign(Error('Invalid managed native host configuration.'), { code: 'INK_MANAGED_NATIVE_CONFIG' });
      const module = await this.load(pathToFileURL(this.modulePath).href);
      if (typeof module.NativeToolchain !== 'function' || typeof module.nativeToolchainPlan !== 'function') throw Error('Invalid native installer exports.');
      const plan = module.nativeToolchainPlan();
      if (!plan.supported) return { plan, service: null };
      if (!/^[a-f0-9]{64}$/.test(plan.identity || '') || !/^\d+\.\d+\.\d+$/.test(plan.version || '') || !/^[a-z0-9_-]+$/.test(plan.target || '')) throw Error('Invalid native installer identity.');
      return { plan, service: new module.NativeToolchain({ directory: this.directory }) };
    })().catch(error => { this.loading = undefined; throw error; });
    return this.loading;
  }
  identity(plan) { return { managed: true, version: plan.version, target: plan.target, identity: plan.identity }; }
  async plan() {
    try {
      const { plan } = await this.installer();
      if (!plan.supported) throw Object.assign(Error(plan.reason || 'Managed native installation is unsupported on this host. JavaScript remains available.'), { status: 503, code: 'INK_TOOLCHAIN_UNSUPPORTED' });
      return this.identity(plan);
    } catch (error) {
      if (error.code === 'INK_TOOLCHAIN_UNSUPPORTED') throw error;
      const value = diagnostic(error); throw Object.assign(Error(value.reason), { status: 503, code: value.code });
    }
  }
  async inspect() {
    try {
      const { plan, service } = await this.installer();
      if (!service) return { available: false, installable: false, managed: true, code: 'INK_TOOLCHAIN_UNSUPPORTED', reason: plan.reason || 'Managed native installation is unsupported on this host. JavaScript remains available.' };
      const status = await service.inspect();
      if (status.available) return { available: true, installable: false, ...this.identity(plan) };
      if (!status.installable) return { ...diagnostic(status), ...this.identity(plan) };
      const free = await this.freeBytes(this.directory), requiredBytes = service.reserveBytes + service.estimatedBytes;
      if (!Number.isFinite(free) || !Number.isFinite(requiredBytes) || free < requiredBytes) return { ...diagnostic({ code: 'INK_TOOLCHAIN_DISK_RESERVE' }), ...this.identity(plan), requiredBytes };
      return { available: false, installable: true, ...this.identity(plan), code: 'INK_TOOLCHAIN_MISSING', reason: 'The pinned Rust toolchain will be installed privately when you explicitly build a native artifact.', requiredBytes };
    } catch (error) { return diagnostic(error); }
  }
  async ensure() {
    try {
      const { service } = await this.installer();
      await this.plan();
      const result = await service.ensure();
      if (!isAbsolute(result.cargo || '') || !isAbsolute(result.rustc || '')) throw Error('Invalid managed compiler paths.');
      return result;
    } catch (error) {
      if (error.code === 'INK_TOOLCHAIN_UNSUPPORTED') throw error;
      const value = diagnostic(error, 'INK_TOOLCHAIN_INSTALL'); throw Object.assign(Error(value.reason), { status: 503, code: value.code });
    }
  }
}

export function managedNativeFromEnvironment(environment = process.env) {
  const modulePath = environment.INK_OS_MANAGED_NATIVE_MODULE, directory = environment.INK_OS_MANAGED_NATIVE_DIRECTORY;
  return modulePath || directory ? new ManagedNative({ modulePath, directory }) : null;
}
