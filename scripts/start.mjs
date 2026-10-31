import { initializeInstance } from '../server/instance.mjs';

const instance = await initializeInstance({
  directory: process.env.INK_OS_DATA_DIR,
  port: Number(process.env.PORT || 4318),
});
process.env.NODE_ENV = 'production';
process.env.INK_OS_DEV = process.argv.includes('--dev') ? '1' : '0';
process.env.INK_OS_DATA_DIR = instance.directory;
process.env.INK_OS_ADMIN_TOKEN ||= instance.adminToken;
process.env.INK_OS_ENV_KEY ||= instance.environmentKey;
process.env.INK_OS_BIND ||= '127.0.0.1';
console.log(`Ink OS credentials: ${instance.clientPath}`);
await import('../server/index.mjs');
