import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
export type EgressRule = { scheme: 'https:' | 'http:'; host: string; port?: number; path: string; /** Explicit trusted fixture exception; omit in production. */ fixtureAddresses?: readonly string[] };
export type Resolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return address !== '168.63.129.16' && !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a >= 224);
  }
  // Only global unicast IPv6; excludes mapped IPv4, local, multicast and metadata.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^(2002:|2001:(0{1,4}:|db8:|0{0,3}1[0-9a-f]:))/i.test(address);
}
export function checkUrl(raw: unknown, rules: readonly EgressRule[]): { url: URL; rule: EgressRule } {
  if (typeof raw !== 'string' || raw.length > 8192) throw Error('EGRESS_DENIED');
  let url: URL;
  try { url = new URL(raw); } catch { throw Error('EGRESS_DENIED'); }
  if (url.username || url.password || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) throw Error('EGRESS_DENIED');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals are forbidden even if a caller adds one to the URL allowlist.
  if (isIP(hostname)) throw Error('EGRESS_DENIED');
  const rule = rules.find(r => r.scheme === url.protocol && r.host === url.hostname && (r.port ?? (r.scheme === 'https:' ? 443 : 80)) === Number(url.port || (url.protocol === 'https:' ? 443 : 80)) && r.path.startsWith('/') && (url.pathname === r.path || url.pathname.startsWith(r.path.endsWith('/') ? r.path : r.path + '/')));
  if (!rule) throw Error('EGRESS_DENIED');
  return { url, rule };
}
/** Resolve every hop, reject mixed public/private DNS, pin the checked address in the socket
 * lookup, and follow redirects only after the full whitelist/DNS check. No ambient proxy. */
export async function guardedFetch(raw: string, rules: readonly EgressRule[], options: { signal?: AbortSignal; resolve?: Resolver; maxBytes?: number } = {}): Promise<{ status: number; body: string }> {
  const resolve = options.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) throw Error('EGRESS_DENIED');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10_000)]);
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const { url, rule } = checkUrl(current, rules);
    signal.throwIfAborted();
    const addresses = await new Promise<Awaited<ReturnType<Resolver>>>((resolveAddresses, reject) => {
      const abort = () => reject(Error('EGRESS_DENIED'));
      signal.addEventListener('abort', abort, { once: true });
      resolve(url.hostname).then(resolveAddresses, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (!addresses.length || addresses.some(a => !isIP(a.address) || a.family !== isIP(a.address) || !(publicAddress(a.address) || (a.address === '127.0.0.1' || a.address === '::1') && rule.fixtureAddresses?.includes(a.address)))) throw Error('EGRESS_DENIED');
    const pinned = addresses[0]!;
    const response = await new Promise<{ status: number; body: string; location?: string }>((resolveResponse, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', signal, agent: false, family: pinned.family,
        lookup: (_hostname, _options, done) => done(null, pinned.address, pinned.family) }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) res.destroy(Error('EGRESS_RESPONSE_LIMIT')); else chunks.push(chunk); });
        res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), ...(res.headers.location ? { location: res.headers.location } : {}) }));
      });
      req.on('error', reject); req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || hop === 3) throw Error('EGRESS_DENIED');
      current = new URL(response.location, url).href; continue;
    }
    return { status: response.status, body: response.body };
  }
  throw Error('EGRESS_DENIED');
}
