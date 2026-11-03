import { z } from 'zod';
import { sign, type KeyObject } from 'node:crypto';
import type { ToolSpec } from 'mcp-common/server';
import { providerJson, trustedUrl } from 'mcp-common/http';
export { verifyGithubWebhook } from './webhook.js';

export interface GithubConfig {
  appId: string;
  privateKey: KeyObject;
  tenants: Readonly<Record<string, { installationId: number; repositories: readonly string[] }>>;
  apiBase?: string;
  timeoutMs?: number;
}
export const repoSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => !['.', '..'].includes(value.split('/')[1]!));
export const listChecksSchema = z.object({ repo: repoSchema }).strict();
export const createIssueSchema = z.object({
  repo: repoSchema,
  title: z.string().min(1).max(256),
  body: z.string().max(60000),
}).strict();
const grantSchema = z.object({
  token: z.string().min(1).max(8192),
  expires_at: z.string(),
  permissions: z.record(z.string(), z.string()),
  repositories: z.array(z.object({ full_name: z.string() })),
});
const checkSchema = z.object({
  id: z.number().int(), name: z.string(), status: z.string(),
  conclusion: z.string().nullable(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
});
const writerSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  installationId: z.number().int().positive(),
  apiBase: z.string(),
}).strict();
const marker = (key: string) => `<!-- keel-action:${key} -->`;

/** Installation identity only. This factory deliberately has no OAuthService/user-token fallback. */
export function githubTools(config: GithubConfig): ToolSpec[] {
  if (!/^\d+$/.test(config.appId) || config.privateKey.type !== 'private' ||
      config.privateKey.asymmetricKeyType !== 'rsa' ||
      (config.privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw Error('GITHUB_CONFIG_INVALID');
  }
  const base = trustedUrl(config.apiBase ?? 'https://api.github.com').href.replace(/\/$/, '');
  // Capture trusted deployment identity once; later caller mutations cannot change an in-flight writer.
  const { appId, privateKey, timeoutMs } = config;
  const tenants = structuredClone(config.tenants);
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'Content-Type': 'application/json',
  });

  function installation(tenant: string, repo: string) {
    const install = Object.hasOwn(tenants, tenant) ? tenants[tenant] : undefined;
    const permitted = install?.repositories.some(value => value.toLowerCase() === repo.toLowerCase());
    if (!install || !Number.isSafeInteger(install.installationId) || install.installationId <= 0 || !permitted) {
      throw Error('REPOSITORY_DENIED');
    }
    return install;
  }
  function writer(tenant: string, repo: string) {
    return { appId, installationId: installation(tenant, repo).installationId, apiBase: base };
  }
  function verifiedWriter(tenant: string, repo: string, evidence: unknown) {
    const saved = writerSchema.safeParse(evidence);
    const current = writer(tenant, repo);
    if (!saved.success || saved.data.appId !== current.appId ||
        saved.data.installationId !== current.installationId || saved.data.apiBase !== current.apiBase) {
      throw Error('IDENTITY_MISMATCH');
    }
    return saved.data;
  }

  async function connection(
    tenant: string, repo: string, permission: 'checks' | 'issues',
    level: 'read' | 'write', signal: AbortSignal,
  ) {
    const install = installation(tenant, repo);
    async function exchange() {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 540 })).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      const jwt = `${header}.${payload}.${signature}`;
      const response = await providerJson(`${base}/app/installations/${install.installationId}/access_tokens`, {
        method: 'POST', headers: headers(jwt),
        body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: { [permission]: level } }),
      }, signal, timeoutMs);
      if (response.status !== 201) throw Error('PROVIDER_REJECTED');
      const grant = grantSchema.parse(response.data);
      if (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) {
        throw Error('PROVIDER_REJECTED');
      }
      if (!grant.repositories.some(value => value.full_name.toLowerCase() === repo.toLowerCase())) {
        throw Error('REPOSITORY_DENIED');
      }
      const actualPermission = grant.permissions[permission];
      if (actualPermission !== level && !(level === 'read' && actualPermission === 'write')) {
        throw Error('SCOPE_MISSING');
      }
      return grant.token;
    }
    let token = await exchange();
    let refreshed = false;
    return async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
      for (;;) {
        const response = await providerJson(`${base}${path}`, {
          method, headers: headers(token),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, signal, timeoutMs);
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          token = await exchange();
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw Error('PROVIDER_REJECTED');
        return response.data;
      }
    };
  }
  return [
    {
      name: 'list_failing_checks', schema: listChecksSchema, scopes: ['checks:read'], write: false,
      execute: async (raw, tenant, signal) => {
        const { repo } = listChecksSchema.parse(raw);
        const request = await connection(tenant, repo, 'checks', 'read', signal);
        const metadata = z.object({ full_name: z.string(), default_branch: z.string().min(1) })
          .parse(await request(`/repos/${repo}`));
        if (metadata.full_name.toLowerCase() !== repo.toLowerCase()) throw Error('REPOSITORY_DENIED');
        const checks: z.infer<typeof checkSchema>[] = [];
        let total = 0;
        let ref = metadata.default_branch;
        let headSha: string | undefined;
        for (let page = 1; page <= 10; page++) {
          const data = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(checkSchema) })
            .parse(await request(`/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}&filter=latest`));
          if (data.check_runs.length) {
            headSha ??= data.check_runs[0]!.head_sha;
            if (data.check_runs.some(check => check.head_sha !== headSha)) throw Error('PROVIDER_REJECTED');
            ref = headSha;
          }
          checks.push(...data.check_runs);
          total = data.total_count;
          if (checks.length >= total) break;
          if (!data.check_runs.length) throw Error('PROVIDER_REJECTED');
        }
        const failing = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
        return {
          branch: metadata.default_branch,
          checks: checks.filter(check => check.status === 'completed' && check.conclusion !== null && failing.has(check.conclusion)),
          truncated: checks.length < total,
        };
      },
    },
    {
      name: 'create_issue',
      description: 'Creates an issue with an appended HTML comment containing the action hash.',
      schema: createIssueSchema, scopes: ['issues:write'], write: true,
      // The journal encrypts this identity before dispatch. Missing legacy evidence cannot be reconstructed safely.
      prepare: async (raw, tenant) => writer(tenant, createIssueSchema.parse(raw).repo),
      execute: async (raw, tenant, signal, binding, evidence) => {
        const args = createIssueSchema.parse(raw);
        if (!binding) throw Error('APPROVAL_REQUIRED');
        verifiedWriter(tenant, args.repo, evidence);
        const request = await connection(tenant, args.repo, 'issues', 'write', signal);
        return z.object({ number: z.number().int().positive() }).parse(
          await request(`/repos/${args.repo}/issues`, 'POST', {
            title: args.title, body: `${args.body}\n${marker(binding.actionKey)}`,
          }),
        );
      },
      lookup: async (raw, tenant, key, signal, evidence) => {
        const args = createIssueSchema.parse(raw);
        const originalWriter = verifiedWriter(tenant, args.repo, evidence);
        const request = await connection(tenant, args.repo, 'issues', 'read', signal);
        const matches: { number: number }[] = [];
        const expectedBody = `${args.body}\n${marker(key)}`;
        const issue = z.object({
          number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
          user: z.object({ type: z.string() }),
          performed_via_github_app: z.object({ id: z.number() }).nullable(),
          pull_request: z.unknown().optional(),
        });
        for (let page = 1; page <= 10; page++) {
          const list = z.array(issue).parse(
            await request(`/repos/${args.repo}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`),
          );
          for (const item of list) {
            const originalApp = String(item.performed_via_github_app?.id) === originalWriter.appId;
            if (item.pull_request === undefined && item.title === args.title &&
                item.body === expectedBody && item.user.type === 'Bot' && originalApp) {
              matches.push({ number: item.number });
            }
          }
          if (list.length < 100) return matches.length === 1 ? matches[0] : undefined;
        }
        return undefined;
      },
    },
  ];
}
