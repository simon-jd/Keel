import { z } from 'zod';
import type { OAuthService } from 'oauth';
import type { ToolSpec } from 'mcp-common/server';
import { providerJson, trustedUrl } from 'mcp-common/http';
import { providerAuthorization, type ConsentHandler } from 'mcp-common/provider-auth';
import { assertAllowedSoql } from './soql.js';
export const querySchema = z.object({
    soql: z.string().min(1).max(5000)
}).strict();
export const updateCaseStatusSchema = z.object({
    case_id: z.string().regex(/^500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/), status: z.string().min(1).max(80)
}).strict();
export const salesforceTenantSchema = z.object({
    instanceUrl: z.string(), objects: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).min(1), caseStatuses: z.array(z.string().min(1).max(80)).min(1)
}).strict();
export interface SalesforceOptions {
    tenants: Record<string, z.infer<typeof salesforceTenantSchema>>;
    apiVersion?: string;
    timeoutMs?: number;
    onConsentRequired?: ConsentHandler;
}
export function salesforceTools(oauth: OAuthService, options: SalesforceOptions): ToolSpec[] {
    const tenants = z.record(z.string(), salesforceTenantSchema).parse(options.tenants);
    const version = z.string().regex(/^v[0-9]{2,3}\.0$/).parse(options.apiVersion ?? 'v66.0');
    for (const tenant of Object.values(tenants)) {
        const url = trustedUrl(tenant.instanceUrl);
        if (url.pathname !== '/' || url.search || (url.protocol === 'https:' && !url.hostname.endsWith('.my.salesforce.com')))
            throw Error('CONFIG_INVALID');
        tenant.instanceUrl = url.origin;
    }
    const authorized = providerAuthorization(oauth, 'salesforce', 'salesforce-user', options.onConsentRequired);
    function config(tenant: string) {
        const found = tenants[tenant];
        if (!found)
            throw Error('TOOL_DENIED');
        return found;
    }
    const writerSchema = z.object({
        user_id: z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/), organization_id: z.string().regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/)
    });
    const identityCaps = [['api', 'full'], ['id', 'full']];
    async function request(instance: string, path: string, token: string, signal: AbortSignal, body?: unknown) {
        const response = await providerJson(instance + path, {
            method: body === undefined ? 'GET' : 'PATCH', headers: {
                Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {
                    'Content-Type': 'application/json'
                })
            }, ...(body === undefined ? {} : {
                body: JSON.stringify(body)
            })
        }, signal, options.timeoutMs);
        if (body !== undefined && response.status >= 200 && response.status < 300 && response.status !== 204)
            throw Error('PROVIDER_REJECTED');
        return response;
    }
    async function who(tenant: string, signal: AbortSignal) {
        return writerSchema.parse(await authorized(tenant, identityCaps, signal, token => request(config(tenant).instanceUrl, '/services/oauth2/userinfo', token, signal)));
    }
    async function call(tenant: string, path: string, signal: AbortSignal, body?: unknown, writer?: z.infer<typeof writerSchema>) {
        const settings = config(tenant);
        return authorized(tenant, writer ? identityCaps : [['api', 'full']], signal, async (token) => {
            if (writer) {
                const profile = await request(settings.instanceUrl, '/services/oauth2/userinfo', token, signal);
                if (profile.status === 401)
                    return profile;
                if (profile.status !== 200)
                    throw Error('PROVIDER_REJECTED');
                const current = writerSchema.parse(profile.data);
                if (current.user_id !== writer.user_id || current.organization_id !== writer.organization_id)
                    throw Error('IDENTITY_MISMATCH');
            }
            return request(settings.instanceUrl, path, token, signal, body);
        });
    }
    const root = `/services/data/${version}`;
    function writable(raw: Record<string, unknown>, tenant: string) {
        const args = updateCaseStatusSchema.parse(raw);
        const settings = config(tenant);
        if (!settings.caseStatuses.includes(args.status))
            throw Error('TOOL_DENIED');
        return {
            args, settings
        };
    }
    const evidenceSchema = z.object({
        version: z.literal(1), instance: z.string(), apiVersion: z.string(), writer: writerSchema, caseId: z.string(), status: z.string()
    }).strict();
    return [
        {
            name: 'query', schema: querySchema, scopes: ['api'], write: false, description: 'Read-only SOQL: simple fields on one allowlisted object, scalar WHERE comparisons with AND/OR, ORDER BY and LIMIT. Relationships, functions, subqueries and all other grammar are rejected. Maximum ten pages.', execute: async (raw, tenant, signal) => {
                const args = querySchema.parse(raw);
                assertAllowedSoql(args.soql, config(tenant).objects);
                let path = `${root}/query?${new URLSearchParams({
                    q: args.soql
                })}`;
                const seen = new Set<string>();
                const records: unknown[] = [];
                for (let page = 0; page < 10; page++) {
                    const result = z.object({
                        done: z.boolean(), records: z.array(z.record(z.string(), z.unknown())), nextRecordsUrl: z.string().optional()
                    }).parse(await call(tenant, path, signal));
                    records.push(...result.records);
                    if (result.done)
                        return {
                            records, truncated: false
                        };
                    const next = result.nextRecordsUrl;
                    if (!next || !next.startsWith(root + '/query/') || !/^[A-Za-z0-9_-]+$/.test(next.slice((root + '/query/').length)) || seen.has(next))
                        throw Error('PROVIDER_REJECTED');
                    seen.add(next);
                    path = next;
                }
                return {
                    records, truncated: true
                };
            }
        },
        {
            name: 'update_case_status', schema: updateCaseStatusSchema, scopes: ['api', 'id'], write: true, description: 'Updates only Case.Status to a configured allowed value. Any uncertain dispatch remains UNKNOWN for operator reconciliation; matching current status is not proof of this action.',
            prepare: async (raw, tenant, signal) => {
                const { args, settings } = writable(raw, tenant);
                return {
                    version: 1, instance: settings.instanceUrl, apiVersion: version, writer: await who(tenant, signal), caseId: args.case_id, status: args.status
                };
            },
            execute: async (raw, tenant, signal, binding, evidence) => {
                if (!binding)
                    throw Error('APPROVAL_REQUIRED');
                const { args, settings } = writable(raw, tenant);
                const saved = evidenceSchema.parse(evidence);
                if (saved.instance !== settings.instanceUrl || saved.apiVersion !== version || saved.caseId !== args.case_id || saved.status !== args.status)
                    throw Error('IDENTITY_MISMATCH');
                const result = await call(tenant, `${root}/sobjects/Case/${args.case_id}`, signal, {
                    Status: args.status
                }, saved.writer);
                if (result !== null)
                    throw Error('PROVIDER_REJECTED');
                return {
                    case_id: args.case_id, status: args.status
                };
            },
            // No provider audit correlation exists. Neither current Status nor new deployment credentials prove this action.
            lookup: async () => undefined,
        },
    ];
}
