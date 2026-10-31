export const CONTINUATION_HEADER = 'x-ink-continuation';

/** A transient compute credential supplements an account key; it never replaces
 * account authentication or permissions. It belongs to one exact host origin.
 */
export function continuationContext(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || value.url.length > 2048 || /[\s\\?#]/.test(value.url) || typeof value.token !== 'string' || !/^ink3\.[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(value.token)) throw Error('Provide an exact host origin and a compute lease continuation credential.');
  let url; try { url = new URL(value.url); } catch { throw Error('Invalid continuation host origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.origin === 'null') throw Error('Invalid continuation host origin.');
  return Object.freeze({ url: url.origin, token: value.token });
}

export function continuationFromEnvironment(environment) {
  const url = environment.INK_OS_CONTINUATION_URL, token = environment.INK_OS_CONTINUATION_TOKEN;
  return url === undefined && token === undefined ? null : continuationContext({ url, token });
}

export function continuationHeaders(target, value) {
  const context = continuationContext(value);
  return context && new URL(target).origin === context.url ? { [CONTINUATION_HEADER]: context.token } : {};
}

export function redactConnectionSecrets(message, values) {
  let result = String(message);
  for (const value of values) if (typeof value === 'string' && value) result = result.replaceAll(value, '[redacted]');
  return result;
}
