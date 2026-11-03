/** Value-level provenance for side-effecting tool arguments (Task 13, phase 6).
 *
 * Session taint blocks every write after any read. This check blocks a write only when one of
 * its argument values is an identifier that the episode has seen solely inside free text of an
 * untrusted tool result (the kind of field indirect injections live in: message bodies, web
 * pages, reviews, file contents) and that the trusted user request does not contain.
 * Identifiers that also occur as a structured value (a short field such as a sender, an id, a
 * hotel name or an IBAN column) are treated as data of record and allowed.
 *
 * Identifiers: e-mail addresses, URLs/domains, IBAN-shaped account numbers, and argument
 * values that are a single token with a digit or one of `_ @ . -` (passwords, ids, handles).
 * Paraphrased or re-encoded values are not caught; that is the documented trade against taint. */
export const FREE_TEXT_WORDS = 8;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,6}(?:\/[^\s"'<>)\]]*)?/gi;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g;

const clean = (value: string) => value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,;:!?)\]]+$/, '').replace(/\/$/, '');
export function identifiers(text: string): string[] {
  const out = new Set<string>();
  const emails = text.match(EMAIL) ?? [];
  for (const e of emails) out.add(clean(e));
  const rest = emails.reduce((t, e) => t.split(e).join(' '), text);
  for (const u of rest.match(URL) ?? []) out.add(clean(u));
  for (const i of text.match(IBAN) ?? []) out.add(i.toLowerCase());
  return [...out];
}
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** A whole argument value that names something: one token with a digit or `_ @ . -`, length >= 4. */
export function tokenLike(value: string): boolean {
  const v = value.trim();
  return v.length >= 4 && v.length <= 128 && !/\s/.test(v) && /[0-9_@.\-]/.test(v);
}

function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out);
  return out;
}

export type ProvenanceState = { freeText: string[]; freeIds: string[]; structured: string[]; structuredIds: string[] };
export const emptyProvenance = (): ProvenanceState => ({ freeText: [], freeIds: [], structured: [], structuredIds: [] });
const LIMIT = 20000;
/** Fold one untrusted tool result (JSON value) into the episode state. Bounded, deterministic. */
export function observeResult(state: ProvenanceState, result: unknown): ProvenanceState {
  const next = { freeText: [...state.freeText], freeIds: new Set(state.freeIds), structured: new Set(state.structured), structuredIds: new Set(state.structuredIds) };
  for (const leaf of leaves(result)) {
    if (words(leaf) >= FREE_TEXT_WORDS) {
      if (next.freeText.length < LIMIT) next.freeText.push(leaf.toLowerCase().slice(0, 20000));
      for (const id of identifiers(leaf)) next.freeIds.add(id);
    } else {
      next.structured.add(clean(leaf.trim()));
      for (const id of identifiers(leaf)) next.structuredIds.add(id);
    }
  }
  const cap = (s: Set<string>) => [...s].sort().slice(0, LIMIT);
  return { freeText: next.freeText, freeIds: cap(next.freeIds), structured: cap(next.structured), structuredIds: cap(next.structuredIds) };
}

/** Untrusted identifiers that flow into this call's arguments (empty = allow). `identifiersOnly`
 * (used for read-only tools, e.g. a fetch of an injected URL, which is an egress too) applies the
 * e-mail / URL / IBAN rule but not the bare-token rule. */
export function untrustedFlows(args: unknown, trustedText: string, state: ProvenanceState, identifiersOnly = false): string[] {
  const trusted = trustedText.toLowerCase(); const trustedIds = new Set(identifiers(trustedText));
  const freeIds = new Set(state.freeIds); const structured = new Set(state.structured); const structuredIds = new Set(state.structuredIds);
  const flagged = new Set<string>();
  for (const leaf of leaves(args)) {
    for (const id of identifiers(leaf)) {
      if (freeIds.has(id) && !structuredIds.has(id) && !structured.has(id) && !trustedIds.has(id) && !trusted.includes(id)) flagged.add(id);
    }
    if (!identifiersOnly && tokenLike(leaf)) {
      const v = clean(leaf.trim());
      if (!structured.has(v) && !trusted.includes(v) && state.freeText.some(text => text.includes(v))) flagged.add(v);
    }
  }
  return [...flagged].sort();
}
