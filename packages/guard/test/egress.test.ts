import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkUrl, guardedFetch, type EgressRule } from '../src/egress.js';
test('egress validates credentials literal addresses exact host port scheme and path', () => {
  const rules: EgressRule[] = [{ scheme: 'https:', host: 'safe.example', path: '/api' }];
  expect(checkUrl('https://safe.example/api/item', rules).url.pathname).toBe('/api/item');
  for (const url of ['http://safe.example/api', 'https://safe.example:444/api', 'https://safe.example.evil/api', 'https://u:p@safe.example/api', 'https://127.0.0.1/api', 'https://[::1]/api', 'https://169.254.169.254/api', 'https://safe.example/apix', 'https://safe.example/api/%2fsecret']) expect(() => checkUrl(url, rules)).toThrow('EGRESS_DENIED');
});
test('actual socket path pins DNS and denies redirects rebinding and private addresses before access', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url!); if (req.url === '/allowed/redirect') res.writeHead(302, { location: '/denied' }).end(); else if (req.url === '/allowed/rebind') res.writeHead(302, { location: '/allowed/final' }).end(); else res.end('fixture'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error();
  const origin = `http://fixture.test:${address.port}`;
  const rules: EgressRule[] = [{ scheme: 'http:', host: 'fixture.test', port: address.port, path: '/allowed', fixtureAddresses: ['127.0.0.1'] }];
  const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
  try {
    expect(await guardedFetch(origin + '/allowed/ok', rules, { resolve })).toEqual({ status: 200, body: 'fixture' });
    await expect(guardedFetch(origin + '/allowed/redirect', rules, { resolve })).rejects.toThrow('EGRESS_DENIED');
    expect(hits).toEqual(['/allowed/ok', '/allowed/redirect']);
    let calls = 0;
    await expect(guardedFetch(origin + '/allowed/rebind', rules, { resolve: async () => ++calls === 1 ? resolve() : [{ address: '169.254.169.254', family: 4 }] })).rejects.toThrow('EGRESS_DENIED');
    expect(hits).toEqual(['/allowed/ok', '/allowed/redirect', '/allowed/rebind']);
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '168.63.129.16', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) await expect(guardedFetch(origin + '/allowed/private', [{ ...rules[0]!, fixtureAddresses: [] }], { resolve: async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }] })).rejects.toThrow('EGRESS_DENIED');
    await expect(guardedFetch(origin + '/allowed/metadata', [{ ...rules[0]!, fixtureAddresses: ['169.254.169.254'] }], { resolve: async () => [{ address: '169.254.169.254', family: 4 }] })).rejects.toThrow('EGRESS_DENIED');
    expect(hits).toHaveLength(3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
