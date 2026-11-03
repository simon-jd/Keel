import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { hash } from 'runtime/actions';
import { startServer, type ToolSpec } from 'mcp-common/server';
import { ActionJournal } from 'mcp-common/journal';
import { ApprovalAuthority } from 'mcp-common/approval';
import { githubTools } from '../src/index.js';
import { authConfig, client, database, fixture, jwt } from '../../common/test/helpers.js';

let db: Awaited<ReturnType<typeof database>>;
let provider: Awaited<ReturnType<typeof fixture>>;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let journal: ActionJournal;
const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const approvalKey = randomBytes(32);
const args = { repo: 'fixture/repo', title: 'Original action', body: 'Original body' };
const binding = {
  tenantId: 'tenant-a',
  runId: '10000000-0000-4000-8000-000000000001',
  tool: 'github.create_issue',
  actionKey: 'b'.repeat(64),
  argsHash: hash(args),
};
let writes = 0;
let issues: Record<string, unknown>[] = [];

function tools(appId: string): ToolSpec[] {
  return githubTools({
    appId,
    privateKey: appKeys.privateKey,
    tenants: { 'tenant-a': { installationId: 123, repositories: ['fixture/repo'] } },
    apiBase: provider.origin,
    timeoutMs: 300,
  });
}
async function restart(appId: string, specs = tools(appId)) {
  await server?.close();
  journal = new ActionJournal(db.pool, db.cipher);
  server = await startServer({
    name: 'github', port: 0, auth: authConfig, approvalKey, journal, tools: specs,
  });
}
async function dispatch() {
  const current = server!;
  const authority = new ApprovalAuthority(approvalKey, current.url);
  const proof = await authority.issue(binding, args, [binding], async () => 'allow');
  const sdk = await client(current.url);
  try {
    return await sdk.callTool({ name: 'create_issue', arguments: args, _meta: { 'keel/approval': proof } });
  } finally {
    await sdk.close();
  }
}
function lookup() {
  return fetch(server!.origin + '/actions/lookup', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt(server!.url)}` },
    body: JSON.stringify({ actionKey: binding.actionKey }),
  });
}
beforeAll(async () => {
  db = await database();
  provider = await fixture((req, res, raw) => {
    if (req.url === '/app/installations/123/access_tokens') {
      const [header, payload, signature] = req.headers.authorization!.slice(7).split('.');
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), appKeys.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { iss: string };
      expect(['42', '99']).toContain(claims.iss);
      res.statusCode = 201;
      res.end(JSON.stringify({
        token: `installation-app-${claims.iss}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { issues: 'write' },
        repositories: [{ full_name: args.repo }],
      }));
      return;
    }
    expect(req.url).toMatch(/^\/repos\/fixture\/repo\/issues/);
    expect(req.headers.authorization).toMatch(/^Bearer installation-app-(42|99)$/);
    if (req.method === 'POST') {
      writes++;
      const body = JSON.parse(raw.toString()) as Record<string, unknown>;
      issues.push({
        number: 12, title: body.title, body: body.body,
        user: { type: 'Bot' }, performed_via_github_app: { id: 42 },
      });
      req.socket.destroy(); // Effect happened; no HTTP reply reached the SDK server.
      return;
    }
    res.end(JSON.stringify(issues));
  });
});
beforeEach(async () => {
  writes = 0;
  issues = [];
  await db.pool.query('DELETE FROM mcp_actions');
  await restart('42');
});
afterAll(async () => {
  await server?.close();
  await provider?.close();
  await db?.close();
  expect(provider?.failures).toEqual([]);
});

test('UNKNOWN survives replacement App even when both original and copied issue markers exist', async () => {
  expect((await dispatch()).isError).toBe(true);
  expect(writes).toBe(1);
  expect((await journal.read(binding.tenantId, binding.actionKey))?.status).toBe('UNKNOWN');
  issues.push({ ...issues[0], number: 13, performed_via_github_app: { id: 99 } });

  await restart('99');
  expect((await lookup()).status).toBe(409);
  const unknown = await journal.read(binding.tenantId, binding.actionKey);
  expect(unknown?.status).toBe('UNKNOWN');
  expect(unknown?.evidence).toEqual({ appId: '42', installationId: 123, apiBase: provider.origin });

  await restart('42');
  expect(await (await lookup()).json()).toEqual({ status: 'done' });
  expect((await journal.read(binding.tenantId, binding.actionKey))?.result).toEqual({ number: 12 });
  expect(issues.map(issue => issue.number)).toEqual([12, 13]);
  expect(writes).toBe(1);
});

test('a journal reservation without original writer evidence remains UNKNOWN', async () => {
  await journal.reserve(binding, args, null);
  issues = [{
    number: 12, title: args.title, body: `${args.body}\n<!-- keel-action:${binding.actionKey} -->`,
    user: { type: 'Bot' }, performed_via_github_app: { id: 42 },
  }];
  expect((await lookup()).status).toBe(409);
  expect((await journal.read(binding.tenantId, binding.actionKey))?.status).toBe('UNKNOWN');
  expect(writes).toBe(0);
});

test('prepare and execute App identity mismatch cannot dispatch a provider write', async () => {
  const specs = tools('42');
  const create = specs.find(spec => spec.name === 'create_issue')!;
  // Simulates a host wiring error between preparation and execution, not model-supplied evidence.
  create.prepare = async () => ({ appId: '99', installationId: 123, apiBase: provider.origin });
  await restart('42', specs);
  expect((await dispatch()).isError).toBe(true);
  expect(writes).toBe(0);
  expect((await journal.read(binding.tenantId, binding.actionKey))?.status).toBe('UNKNOWN');
});
