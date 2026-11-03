import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import {
  McpServer, fromJsonSchema, createMcpHandler, requireBearerAuth,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { Approval } from 'runtime/types';
import { JwtVerifier, type AuthConfig } from './auth.js';
import { ApprovalAuthority } from './approval.js';
import type { ActionJournal, ActionRecord } from './journal.js';
import { boundedBody, trustedUrl } from './http.js';
import { MissingScopeError } from './provider-auth.js';

export interface ToolSpec {
  name: string;
  description?: string;
  schema: z.ZodObject;
  scopes: readonly string[];
  write: boolean;
  execute(args: Record<string, unknown>, tenant: string, signal: AbortSignal, binding?: Approval, evidence?: unknown): Promise<unknown>;
  prepare?(args: Record<string, unknown>, tenant: string, signal: AbortSignal): Promise<unknown>;
  lookup?(args: Record<string, unknown>, tenant: string, key: string, signal: AbortSignal, evidence?: unknown): Promise<unknown | undefined>;
}
export interface ServerOptions {
  name: string;
  port?: number;
  resource?: string;
  auth: Omit<AuthConfig, 'resource'>;
  approvalKey: Buffer;
  journal: ActionJournal;
  tools: ToolSpec[];
  webhook?: (raw: Buffer, headers: Headers) => boolean;
}
const safeCodes = new Set([
  'APPROVAL_REQUIRED', 'TOOL_DENIED', 'SCOPE_MISSING', 'IDENTITY_MISMATCH',
  'REPOSITORY_DENIED', 'ACTION_UNKNOWN', 'BINDING_MISMATCH', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED', 'STORE_ERROR',
]);
function safeError(error: unknown) {
  return error instanceof Error && safeCodes.has(error.message) ? error.message : 'TOOL_ERROR';
}

export async function startServer(options: ServerOptions) {
  let serve: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const node = createServer((req, res) => {
    if (!serve) {
      res.writeHead(503).end();
      return;
    }
    void serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  node.requestTimeout = 10000;
  node.headersTimeout = 5000;
  node.setTimeout(15000, socket => socket.destroy());
  node.listen(options.port ?? 9101, '127.0.0.1');
  await once(node, 'listening');
  const address = node.address();
  if (!address || typeof address === 'string') throw Error('LISTEN_FAILED');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const url = options.resource ?? origin + '/mcp';
    const resource = trustedUrl(url);
    if (resource.pathname !== '/mcp' || resource.search) throw Error('RESOURCE_INVALID');
    const verifier = new JwtVerifier({ ...options.auth, resource: url });
    const authority = new ApprovalAuthority(options.approvalKey, url);
    const gate = requireBearerAuth({
      verifier,
      requiredScopes: ['mcp'],
      expectedResource: resource,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    });
    async function reconcile(record: ActionRecord, signal: AbortSignal): Promise<unknown> {
      const belongsToServer = options.tools.some(tool => `${options.name}.${tool.name}` === record.binding.tool);
      if (!belongsToServer) throw Error('ACTION_UNKNOWN');
      if (record.status === 'SUCCEEDED') return record.result;
      const tool = options.tools.find(tool => `${options.name}.${tool.name}` === record.binding.tool);
      if (!tool?.lookup) throw Error('ACTION_UNKNOWN');
      const found = await tool.lookup(
        tool.schema.parse(record.args), record.binding.tenantId,
        record.binding.actionKey, signal, record.evidence,
      );
      if (found === undefined) throw Error('ACTION_UNKNOWN');
      await options.journal.succeed(record.binding, found);
      return found;
    }
    const handler = createMcpHandler(({ authInfo }) => {
      const server = new McpServer({ name: options.name, version: '1.0.0' });
      for (const tool of options.tools) {
        // Zod and SDK disagree on the unused $vocabulary annotation type; the SDK validates the generated schema.
        const inputSchema = fromJsonSchema<Record<string, unknown>>(
          z.toJSONSchema(tool.schema) as unknown as Parameters<typeof fromJsonSchema>[0],
        );
        server.registerTool(tool.name, {
          inputSchema,
          description: `${tool.description ?? ''} Required provider scopes/permissions: ${tool.scopes.join(', ')}`,
          annotations: {
            readOnlyHint: !tool.write, destructiveHint: tool.write, idempotentHint: !tool.write,
          },
          _meta: { requiredScopes: tool.scopes },
        }, async (args, ctx) => {
          try {
            const tenant = authInfo?.extra?.tenantId;
            if (typeof tenant !== 'string') throw Error('TOOL_DENIED');
            const signal = AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(10000)]);
            signal.throwIfAborted();
            let result: unknown;
            if (tool.write) {
              const permit = authority.verifyAuthorization(
                ctx.mcpReq._meta?.['keel/approval'], tenant, `${options.name}.${tool.name}`, args,
              );
              const binding = permit.binding;
              const evidence = await tool.prepare?.(args, tenant, signal);
              const state = await options.journal.reserve(binding, args, evidence ?? null, permit.authorization);
              if (state === 'acquired') {
                result = await tool.execute(args, tenant, signal, binding, evidence);
                await options.journal.succeed(binding, result);
              } else {
                const record = await options.journal.read(tenant, binding.actionKey);
                if (!record) throw Error('ACTION_UNKNOWN');
                result = await reconcile(record, signal);
              }
            } else {
              result = await tool.execute(args, tenant, signal);
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }],
              ...(error instanceof MissingScopeError ? { _meta: { requiredScopes: error.requiredScopes } } : {}),
            };
          }
        });
      }
      return server;
    }, { maxRequestBodySize: 65536 });

    const fetchHandler = async (request: Request): Promise<Response> => {
      const requestUrl = new URL(request.url);
      const trustedHost = request.headers.get('host') === resource.host;
      const trustedOrigin = !request.headers.has('origin') || request.headers.get('origin') === resource.origin;
      if (!trustedHost || !trustedOrigin) return new Response(null, { status: 403 });
      if (requestUrl.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return request.method === 'GET' ? Response.json({
          resource: url,
          authorization_servers: [options.auth.issuer],
          scopes_supported: ['mcp'],
          bearer_methods_supported: ['header'],
        }) : new Response(null, { status: 405 });
      }
      if (requestUrl.pathname === '/webhook' && options.webhook) {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        let raw: Buffer;
        try {
          raw = await boundedBody(request);
        } catch {
          return new Response(null, { status: 413 });
        }
        if (!options.webhook(raw, request.headers)) return new Response(null, { status: 401 });
        // Verified deliveries only acknowledge receipt; they NEVER authorize tool effects.
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const urlVerification = event.type === 'url_verification' && typeof event.challenge === 'string';
          return Response.json(urlVerification ? { challenge: event.challenge } : { accepted: true });
        } catch {
          return new Response(null, { status: 400 });
        }
      }
      if (requestUrl.pathname !== '/mcp' && requestUrl.pathname !== '/actions/lookup') {
        return new Response(null, { status: 404 });
      }
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      if (requestUrl.pathname === '/actions/lookup') {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        try {
          const body = JSON.parse((await boundedBody(request, 8192)).toString()) as { actionKey?: unknown };
          const tenant = auth.extra?.tenantId;
          if (typeof tenant !== 'string' || typeof body.actionKey !== 'string' || !/^[a-f0-9]{64}$/.test(body.actionKey)) {
            return new Response(null, { status: 400 });
          }
          const record = await options.journal.read(tenant, body.actionKey);
          if (!record) return Response.json({ status: 'absent' });
          const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
          await reconcile(record, signal);
          return Response.json({ status: 'done' });
        } catch {
          return Response.json({ status: 'unknown' }, { status: 409 });
        }
      }
      return handler.fetch(request, { authInfo: auth });
    };
    const adapted = toNodeHandler({ fetch: fetchHandler }, { maxRequestBodySize: 65536 });
    serve = (req, res) => adapted(Object.assign(req, {
      method: req.method ?? 'GET', url: req.url ?? '/',
    }), res);
    return {
      origin, url,
      async close() {
        await handler.close();
        node.closeAllConnections();
        await new Promise<void>(resolve => node.close(() => resolve()));
      },
    };
  } catch (error) {
    node.closeAllConnections();
    await new Promise<void>(resolve => node.close(() => resolve()));
    throw error;
  }
}
