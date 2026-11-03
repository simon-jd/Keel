import { z } from 'zod';
import type { OAuthService, AuthorizationSnapshot } from 'oauth';
import type { ToolSpec } from 'mcp-common/server';
import { providerJson, trustedUrl } from 'mcp-common/http';
export { verifySlackWebhook } from './webhook.js';

export const postMessageSchema = z.object({
  channel: z.string().regex(/^[CGD][A-Z0-9]{2,63}$/),
  text: z.string().min(1).max(39000)
}).strict();
export const searchMessagesSchema = z.object({
  query: z.string().min(1).max(1000)
}).strict();
const object = z.record(z.string(), z.unknown());
const writerSchema = z.object({
  user_id: z.string().min(1), team_id: z.string().min(1)
});
const matchSchema = z.object({
  text: z.string(),
  ts: z.string(),
  channel: z.object({ id: z.string() }),
  user: z.string().optional()
});
const searchSchema = z.object({
  messages: z.object({
    matches: z.array(matchSchema),
    paging: z.object({ pages: z.number().int().nonnegative() })
  })
});
const marker = (key: string) => `[keel-action:${key}]`;
/** OAuthService supplies the token and actual grants atomically; no provider token is accepted from MCP arguments. */
export function slackTools(oauth: OAuthService, options: {
  apiBase?: string;
  timeoutMs?: number;
} = {}): ToolSpec[] {
  const base = trustedUrl(options.apiBase ?? 'https://slack.com/api').href.replace(/\/$/, '');

  async function call(
    tenant: string, method: string, scope: string, params: Record<string, unknown>,
    signal: AbortSignal, post = false, expectedWriter?: unknown,
  ): Promise<Record<string, unknown>> {
    let snapshot: AuthorizationSnapshot = await oauth.getAuthorizationSnapshot(tenant, 'slack');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (snapshot.identity !== 'slack-user')
        throw Error('IDENTITY_MISMATCH');
      if (!snapshot.scopes.includes(scope))
        throw Error('SCOPE_MISSING');
      if (expectedWriter) {
        const who = await request('auth.test', {}, snapshot.accessToken, signal, false);
        if (who.status === 401 || ['invalid_auth', 'token_expired', 'token_revoked'].includes(String(who.data.error))) {
          if (attempt === 1)
            throw Error('PROVIDER_REJECTED');
          snapshot = await oauth.getAuthorizationSnapshot(tenant, 'slack', snapshot.accessToken);
          continue;
        }
        const expected = writerSchema.parse(expectedWriter);
        const sameWriter = who.data.user_id === expected.user_id && who.data.team_id === expected.team_id;
        if (who.status !== 200 || who.data.ok !== true || !sameWriter) {
          throw Error('IDENTITY_MISMATCH');
        }
      }
      const response = await request(method, params, snapshot.accessToken, signal, post);
      if (response.status === 401 || ['invalid_auth', 'token_expired', 'token_revoked'].includes(String(response.data.error))) {
        if (attempt === 1)
          throw Error('PROVIDER_REJECTED');
        snapshot = await oauth.getAuthorizationSnapshot(tenant, 'slack', snapshot.accessToken);
        continue;
      }
      if (response.status !== 200 || response.data.ok !== true)
        throw Error('PROVIDER_REJECTED');
      return response.data;
    }
    throw Error('PROVIDER_REJECTED');
  }
  async function request(method: string, params: Record<string, unknown>, token: string, signal: AbortSignal, post: boolean) {
    post = post || method === 'auth.test';
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const response = await providerJson(`${base}/${method}${post ? '' : '?' + query}`, {
      method: post ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(post ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(post ? { body: JSON.stringify(params) } : {}),
    }, signal, options.timeoutMs);
    return {
      status: response.status, data: object.parse(response.data)
    };
  }
  async function search(tenant: string, query: string, signal: AbortSignal) {
    const messages: z.infer<typeof matchSchema>[] = [];
    let pages = 1;
    for (let page = 1; page <= Math.min(pages, 10); page++) {
      const result = searchSchema.parse(await call(tenant, 'search.messages', 'search:read', {
        query, count: 100, page, highlight: false
      }, signal));
      messages.push(...result.messages.matches);
      pages = result.messages.paging.pages;
    }
    return {
      messages, truncated: pages > 10
    };
  }
  return [
    {
      name: 'post_message',
      description: 'Posts text with an appended [keel-action:<hash>] correlation line. Recovery also requires search:read.',
      schema: postMessageSchema,
      scopes: ['chat:write'],
      write: true,
      prepare: async (_args, tenant, signal) => writerSchema.parse(await call(tenant, 'auth.test', 'chat:write', {}, signal)),
      execute: async (raw, tenant, signal, binding, evidence) => {
        const args = postMessageSchema.parse(raw);
        if (!binding)
          throw Error('APPROVAL_REQUIRED');
        const result = await call(tenant, 'chat.postMessage', 'chat:write', {
          channel: args.channel, text: `${args.text}\n${marker(binding.actionKey)}`
        }, signal, true, evidence);
        return z.object({
          channel: z.string(), ts: z.string()
        }).parse(result);
      },
      lookup: async (raw, tenant, key, signal, evidence) => {
        const args = postMessageSchema.parse(raw);
        const writer = writerSchema.parse(evidence);
        const current = writerSchema.parse(await call(tenant, 'auth.test', 'search:read', {}, signal));
        if (current.user_id !== writer.user_id || current.team_id !== writer.team_id)
          throw Error('IDENTITY_MISMATCH');
        const result = await search(tenant, `"${marker(key)}"`, signal);
        const expectedText = `${args.text}\n${marker(key)}`;
        const found = result.messages.filter(message =>
          message.channel.id === args.channel && message.user === writer.user_id && message.text === expectedText,
        );
        return found.length === 1 && !result.truncated ? {
          channel: args.channel, ts: found[0]!.ts
        } : undefined;
      },
    },
    {
      name: 'search_messages',
      schema: searchMessagesSchema,
      scopes: ['search:read'],
      write: false,
      execute: async (raw, tenant, signal) => search(tenant, searchMessagesSchema.parse(raw).query, signal)
    },
  ];
}
