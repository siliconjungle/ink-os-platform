import http from 'node:http';

// Probes virtual hosts over a fixed loopback connection without DNS or fetch's
// Host-header rewriting. This verifies HTTP routing, not browser cookie policy.
export function proofHTTP(address, path, { host, headers = {}, method = 'GET', body } = {}) {
  const url = new URL(path, address);
  if (url.origin !== new URL(address).origin || url.protocol !== 'http:') throw Error('Use a local HTTP proof path.');
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { ...headers, Host: host } }, response => {
      const chunks = []; let size = 0;
      response.on('data', bytes => { size += bytes.length; if (size > 8 * 1024 * 1024) response.destroy(Error('Proof response exceeded its limit.')); else chunks.push(bytes); });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
        resolve(new Response([204, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.setTimeout(10000, () => request.destroy(Error('HTTP proof timed out.')));
    request.on('error', reject); request.end(body);
  });
}
