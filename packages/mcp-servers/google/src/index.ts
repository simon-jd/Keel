import { z } from 'zod';
import type { OAuthService } from 'oauth';
import type { ToolSpec } from 'mcp-common/server';
import { providerJson, trustedUrl } from 'mcp-common/http';
import { providerAuthorization, type Capabilities, type ConsentHandler } from 'mcp-common/provider-auth';
import { draftEvidenceSchema, emailSchema, rawReply, replyHeaders, type DraftEvidence } from './mime.js';
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const broad = [scope('gmail.modify'), 'https://mail.google.com/'];
const read = [scope('gmail.readonly'), ...broad];
const headers = [scope('gmail.metadata'), ...read];
const compose = [scope('gmail.compose'), ...broad];
const draftCapabilities = [['openid'], ['email', scope('userinfo.email')], headers, compose];
const subjectSchema = z.object({
    sub: z.string().min(1).max(255)
});
const freebusy = [scope('calendar.freebusy'), scope('calendar.events.freebusy'), scope('calendar.readonly'), scope('calendar')];
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const searchSchema = z.object({
    query: z.string().min(1).max(1000)
}).strict();
export const draftReplySchema = z.object({
    thread_id: id, body: z.string().min(1).max(24000)
}).strict();
export const findSlotsSchema = z.object({
    attendees: z.array(emailSchema).min(1).max(50),
    duration: z.number().int().min(1).max(1440).describe('Minimum slot duration in minutes'),
    window: z.object({
        start: z.iso.datetime({
            offset: true
        }), end: z.iso.datetime({
            offset: true
        })
    }).strict(),
}).strict();
const messageRef = z.object({
    id, threadId: id
});
const pageSchema = z.object({
    messages: z.array(messageRef).default([]), nextPageToken: z.string().min(1).max(2048).optional()
});
const draftList = z.object({
    drafts: z.array(z.object({
        id
    })).default([]), nextPageToken: z.string().min(1).max(2048).optional()
});
const resultSchema = z.object({
    id, message: messageRef
});
export interface GoogleOptions {
    gmailBase?: string;
    identityUrl?: string;
    calendarBase?: string;
    timeoutMs?: number;
    onConsentRequired?: ConsentHandler;
}
export function googleTools(oauth: OAuthService, options: GoogleOptions = {}): ToolSpec[] {
    const gmailBase = trustedUrl(options.gmailBase ?? 'https://gmail.googleapis.com/gmail/v1').href.replace(/\/$/, '');
    const calendarBase = trustedUrl(options.calendarBase ?? 'https://www.googleapis.com/calendar/v3').href.replace(/\/$/, '');
    const identityUrl = trustedUrl(options.identityUrl ?? 'https://openidconnect.googleapis.com/v1/userinfo').href;
    const authorized = providerAuthorization(oauth, 'google', 'google-user', options.onConsentRequired);
    function request(url: string, token: string, signal: AbortSignal, body?: unknown) {
        return providerJson(url, {
            method: body === undefined ? 'GET' : 'POST', headers: {
                Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {
                    'Content-Type': 'application/json'
                })
            }, ...(body === undefined ? {} : {
                body: JSON.stringify(body)
            })
        }, signal, options.timeoutMs);
    }
    async function call(tenant: string, path: string, capabilities: Capabilities, signal: AbortSignal, body?: unknown, writer?: {
        subjectId: string;
        writer?: string;
    }, calendar = false) {
        return authorized(tenant, capabilities, signal, async (token) => {
            if (writer) {
                const identity = await request(identityUrl, token, signal);
                if (identity.status === 401)
                    return identity;
                if (identity.status !== 200)
                    throw Error('PROVIDER_REJECTED');
                if (subjectSchema.parse(identity.data).sub !== writer.subjectId)
                    throw Error('IDENTITY_MISMATCH');
                if (writer.writer) {
                    const profile = await request(`${gmailBase}/users/me/profile`, token, signal);
                    if (profile.status === 401)
                        return profile;
                    if (profile.status !== 200)
                        throw Error('PROVIDER_REJECTED');
                    if (z.object({
                        emailAddress: emailSchema
                    }).parse(profile.data).emailAddress !== writer.writer)
                        throw Error('IDENTITY_MISMATCH');
                }
            }
            return request(`${calendar ? calendarBase : gmailBase}${path}`, token, signal, body);
        });
    }
    async function prepare(raw: Record<string, unknown>, tenant: string, signal: AbortSignal): Promise<DraftEvidence> {
        const args = draftReplySchema.parse(raw);
        const identity = subjectSchema.parse(await authorized(tenant, draftCapabilities, signal, token => request(identityUrl, token, signal)));
        const profile = z.object({
            emailAddress: emailSchema
        }).parse(await call(tenant, '/users/me/profile', draftCapabilities, signal, undefined, {
            subjectId: identity.sub
        }));
        const thread = z.object({
            id, messages: z.array(z.object({
                id, payload: z.object({
                    headers: z.array(z.object({
                        name: z.string(), value: z.string()
                    }))
                })
            })).min(1)
        }).parse(await call(tenant, `/users/me/threads/${args.thread_id}?format=metadata`, draftCapabilities, signal, undefined, {
            subjectId: identity.sub, writer: profile.emailAddress
        }));
        if (thread.id !== args.thread_id)
            throw Error('PROVIDER_REJECTED');
        return draftEvidenceSchema.parse({
            version: 1, base: gmailBase, identityUrl, subjectId: identity.sub, writer: profile.emailAddress, thread: args.thread_id, body: args.body, ...replyHeaders(thread.messages.at(-1)!.payload.headers)
        });
    }
    function evidence(raw: Record<string, unknown>, value: unknown) {
        const args = draftReplySchema.parse(raw), saved = draftEvidenceSchema.parse(value);
        if (saved.base !== gmailBase || saved.identityUrl !== identityUrl || saved.thread !== args.thread_id || saved.body !== args.body)
            throw Error('IDENTITY_MISMATCH');
        return saved;
    }
    return [
        {
            name: 'search', schema: searchSchema, scopes: [read[0]!], write: false, description: 'Searches Gmail and returns message references (id/threadId), not bodies. Maximum ten pages.', execute: async (raw, tenant, signal) => {
                const { query } = searchSchema.parse(raw);
                const messages: z.infer<typeof messageRef>[] = [];
                const seen = new Set<string>();
                let pageToken: string | undefined;
                for (let page = 0; page < 10; page++) {
                    const params = new URLSearchParams({
                        q: query, maxResults: '100', ...(pageToken ? {
                            pageToken
                        } : {})
                    });
                    const result = pageSchema.parse(await call(tenant, `/users/me/messages?${params}`, [read], signal));
                    messages.push(...result.messages);
                    if (!result.nextPageToken)
                        return {
                            messageReferences: messages, truncated: false
                        };
                    if (seen.has(result.nextPageToken))
                        throw Error('PROVIDER_REJECTED');
                    seen.add(result.nextPageToken);
                    pageToken = result.nextPageToken;
                }
                return {
                    messageReferences: messages, truncated: true
                };
            }
        },
        {
            name: 'draft_reply', schema: draftReplySchema, scopes: [compose[0]!, headers[0]!, 'openid', 'email'], write: true, description: 'Creates a draft only, replying to the latest message headers. Approval includes a stable Message-ID. Recovery requires the original mailbox and exact saved MIME.', prepare,
            execute: async (raw, tenant, signal, binding, value) => {
                if (!binding)
                    throw Error('APPROVAL_REQUIRED');
                const saved = evidence(raw, value);
                const result = resultSchema.parse(await call(tenant, '/users/me/drafts', draftCapabilities, signal, {
                    message: {
                        threadId: saved.thread, raw: rawReply(saved, binding.actionKey)
                    }
                }, saved));
                if (result.message.threadId !== saved.thread)
                    throw Error('PROVIDER_REJECTED');
                return result;
            },
            lookup: async (raw, tenant, key, signal, value) => {
                const saved = evidence(raw, value);
                const expected = rawReply(saved, key);
                let pageToken: string | undefined;
                const seen = new Set<string>();
                const matches: {
                    id: string;
                    message: {
                        id: string;
                        threadId: string;
                    };
                }[] = [];
                for (let page = 0; page < 10; page++) {
                    const params = new URLSearchParams({
                        maxResults: '100', ...(pageToken ? {
                            pageToken
                        } : {})
                    });
                    const result = draftList.parse(await call(tenant, `/users/me/drafts?${params}`, draftCapabilities, signal, undefined, saved));
                    for (const ref of result.drafts) {
                        const draft = z.object({
                            id, message: z.object({
                                id: id.optional(), threadId: id, raw: z.string()
                            })
                        }).parse(await call(tenant, `/users/me/drafts/${ref.id}?format=raw`, draftCapabilities, signal, undefined, saved));
                        if (draft.id === ref.id && draft.message.threadId === saved.thread && draft.message.raw === expected && draft.message.id)
                            matches.push({
                                id: draft.id, message: {
                                    id: draft.message.id, threadId: saved.thread
                                }
                            });
                    }
                    if (!result.nextPageToken)
                        return matches.length === 1 ? matches[0] : undefined;
                    if (seen.has(result.nextPageToken))
                        return undefined;
                    seen.add(result.nextPageToken);
                    pageToken = result.nextPageToken;
                }
                return undefined;
            },
        },
        {
            name: 'find_slots', schema: findSlotsSchema, scopes: [freebusy[0]!], write: false, description: 'Finds maximal common free intervals within the requested window. Duration is minutes. Does not create events.', execute: async (raw, tenant, signal) => {
                const args = findSlotsSchema.parse(raw);
                const start = Date.parse(args.window.start), end = Date.parse(args.window.end);
                if (start >= end || end - start > 31 * 86400000 || new Set(args.attendees).size !== args.attendees.length)
                    throw Error('PROVIDER_REJECTED');
                const response = z.object({
                    calendars: z.record(z.string(), z.object({
                        busy: z.array(z.object({
                            start: z.iso.datetime({
                                offset: true
                            }), end: z.iso.datetime({
                                offset: true
                            })
                        })).optional(), errors: z.array(z.unknown()).optional()
                    }))
                }).parse(await call(tenant, '/freeBusy', [freebusy], signal, {
                    timeMin: args.window.start, timeMax: args.window.end, items: args.attendees.map(id => ({
                        id
                    }))
                }, undefined, true));
                const busy: [
                    number,
                    number
                ][] = [];
                for (const attendee of args.attendees) {
                    const calendar = response.calendars[attendee];
                    if (!calendar?.busy || calendar.errors?.length)
                        throw Error('PROVIDER_REJECTED');
                    for (const interval of calendar.busy) {
                        const s = Date.parse(interval.start), e = Date.parse(interval.end);
                        if (s >= e)
                            throw Error('PROVIDER_REJECTED');
                        if (e > start && s < end)
                            busy.push([Math.max(start, s), Math.min(end, e)]);
                    }
                }
                busy.sort((a, b) => a[0] - b[0]);
                let cursor = start;
                const slots: {
                    start: string;
                    end: string;
                }[] = [];
                const add = (s: number, e: number) => {
                    if (e - s >= args.duration * 60000)
                        slots.push({
                            start: new Date(s).toISOString(), end: new Date(e).toISOString()
                        });
                };
                for (const [s, e] of busy) {
                    add(cursor, s);
                    cursor = Math.max(cursor, e);
                }
                add(cursor, end);
                return {
                    slots
                };
            }
        },
    ];
}
