import { join, delimiter } from 'node:path';

export function gitRuntime(environment = process.env) {
  const root = environment.INK_OS_GIT_ROOT;
  if (!root) return { executable: 'git', environment: {} };
  const windows = process.platform === 'win32';
  const prefix = windows ? join(root, process.arch === 'arm64' ? 'clangarm64' : 'mingw64') : root;
  return {
    executable: join(root, windows ? 'cmd' : 'bin', windows ? 'git.exe' : 'git'),
    environment: {
      GIT_EXEC_PATH: join(prefix, 'libexec', 'git-core'),
      GIT_TEMPLATE_DIR: join(prefix, 'share', 'git-core', 'templates'),
      ...(windows ? { PATH: [join(prefix, 'bin'), join(root, 'usr', 'bin'), environment.PATH || ''].join(delimiter) } : {}),
      ...(process.platform === 'linux' ? { PREFIX: root, GIT_SSL_CAINFO: join(root, 'ssl', 'cacert.pem') } : {}),
    },
  };
}
