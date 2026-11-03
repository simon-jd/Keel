import { z } from 'zod';
const safeHeader = z.string().max(900).refine(value => !/[\r\n\x00-\x1f\x7f]/.test(value));
const mailbox = z.string().email().max(254).refine(value => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(value));
export const emailSchema = mailbox;
export const draftEvidenceSchema = z.object({
    version: z.literal(1), base: z.string(), identityUrl: z.string(), subjectId: z.string().min(1).max(255), writer: mailbox,
    thread: z.string(), to: mailbox, subject: safeHeader,
    references: safeHeader, inReplyTo: safeHeader, body: z.string(),
}).strict();
export type DraftEvidence = z.infer<typeof draftEvidenceSchema>;
/** Restricted single mailbox syntax: reject ambiguous lists, groups and control characters. */
function address(value: string): string {
    safeHeader.parse(value);
    const match = value.match(/^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)>?$/);
    return mailbox.parse(match?.[1]);
}
export function replyHeaders(headers: {
    name: string;
    value: string;
}[]) {
    function get(name: string, optional = false) {
        const values = headers.filter(h => h.name.toLowerCase() === name);
        if (values.length !== 1 && !(optional && values.length === 0))
            throw Error('PROVIDER_REJECTED');
        return safeHeader.parse(values[0]?.value ?? '');
    }
    const replyTo = get('reply-to', true);
    const inReplyTo = get('message-id');
    if (!/^<[^<>\s]+@[^<>\s]+>$/.test(inReplyTo))
        throw Error('PROVIDER_REJECTED');
    const references = get('references', true);
    if (references && !/^(?:<[^<>\s]+@[^<>\s]+>\s*)+$/.test(references))
        throw Error('PROVIDER_REJECTED');
    return {
        to: address(replyTo || get('from')), subject: get('subject'), inReplyTo, references: safeHeader.parse(`${references ? references + ' ' : ''}${inReplyTo}`)
    };
}
export function rawReply(evidence: DraftEvidence, key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key))
        throw Error('BINDING_MISMATCH');
    const e = draftEvidenceSchema.parse(evidence);
    // Encoded words keep Unicode subject values out of the wire header syntax; fold at safe boundaries.
    const subject = Array.from(e.subject).reduce<string[]>((chunks, char) => {
        if (!chunks.length || Buffer.byteLength(chunks[chunks.length - 1]! + char) > 30)
            chunks.push(char);
        else
            chunks[chunks.length - 1] += char;
        return chunks;
    }, []).map(s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
    const body = Buffer.from(e.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
    return Buffer.from([
        `From: ${e.writer}`, `To: ${e.to}`, `Subject: ${subject}`,
        `Message-ID: <keel-${key}@keel.invalid>`, `In-Reply-To: ${e.inReplyTo}`, `References: ${e.references}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
    ].join('\r\n')).toString('base64url');
}
