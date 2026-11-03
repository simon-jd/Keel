/** These wrappers are host values, never model-supplied authorization metadata. */
export type Source = { kind: 'tool' | 'retrieval' | 'web'; id: string };
export type Content = { readonly text: string; readonly sources: readonly Source[]; readonly tainted: boolean };
const labels = new WeakMap<object, { sources: readonly Source[]; tainted: boolean }>();
function content(text: string, sources: readonly Source[], tainted: boolean): Content {
  const value = Object.freeze({ text, sources: Object.freeze(sources.map(s => Object.freeze({ ...s }))), tainted });
  labels.set(value, { sources: value.sources, tainted });
  return value;
}
export function trusted(text: string): Content { return content(text, [], false); }
export function fromTool(text: string, source: Source): Content { return content(text, [source], true); }
export function provenance(value: unknown): { sources: readonly Source[]; tainted: boolean } {
  if (typeof value !== 'object' || value === null) return { sources: [], tainted: false };
  const own = labels.get(value);
  if (own) return own;
  // Unknown JSON is data. A tainted:false property cannot override a host label.
  const parts = Object.values(value).map(provenance);
  return { sources: parts.flatMap(p => p.sources), tainted: parts.some(p => p.tainted) };
}
export function concat(...xs: Content[]): Content {
  const parts = xs.map(x => labels.get(x) ?? { sources: [], tainted: true });
  return content(xs.map(x => x.text).join(''), parts.flatMap(p => p.sources), parts.some(p => p.tainted));
}
export function template(strings: TemplateStringsArray, ...xs: Content[]): Content {
  return concat(...strings.flatMap((text, i) => [trusted(text), ...(xs[i] ? [xs[i]!] : [])]));
}
export function jsonStringify(value: unknown): Content {
  const label = provenance(value);
  return content(JSON.stringify(value), label.sources, label.tainted);
}
/** Keep the envelope through parsing; callers consume value, never discard the label. */
export function jsonParse(value: Content): { value: unknown; sources: readonly Source[]; tainted: boolean } {
  const label = labels.get(value) ?? { sources: [], tainted: true };
  const result = Object.freeze({ value: JSON.parse(value.text) as unknown, ...label });
  labels.set(result, label);
  return result;
}
