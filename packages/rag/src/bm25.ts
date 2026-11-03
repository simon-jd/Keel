/** Okapi BM25 over an in-memory corpus, with an analysis chain modelled on Lucene's
 * EnglishAnalyzer (the analyzer behind the Pyserini BEIR BM25 baselines): word tokens,
 * possessive removal, lowercase, Lucene's English stop set, Porter stemming. */

// org.apache.lucene.analysis.en.EnglishAnalyzer.ENGLISH_STOP_WORDS_SET
export const ENGLISH_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
  'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with']);

/** Martin Porter's algorithm, translated from the reference C implementation (as Lucene's PorterStemmer). */
export function porterStem(word: string): string {
  const b = word.split(''); let k = b.length - 1; const k0 = 0; let j = 0;
  if (k <= k0 + 1) return word;
  const cons = (i: number): boolean => {
    switch (b[i]) { case 'a': case 'e': case 'i': case 'o': case 'u': return false; case 'y': return i === k0 ? true : !cons(i - 1); default: return true; }
  };
  const m = (): number => {
    let n = 0; let i = k0;
    for (;;) { if (i > j) return n; if (!cons(i)) break; i++; }
    i++;
    for (;;) {
      for (;;) { if (i > j) return n; if (cons(i)) break; i++; }
      i++; n++;
      for (;;) { if (i > j) return n; if (!cons(i)) break; i++; }
      i++;
    }
  };
  const vowelInStem = (): boolean => { for (let i = k0; i <= j; i++) if (!cons(i)) return true; return false; };
  const doublec = (i: number): boolean => i >= k0 + 1 && b[i] === b[i - 1] && cons(i);
  const cvc = (i: number): boolean => {
    if (i < k0 + 2 || !cons(i) || cons(i - 1) || !cons(i - 2)) return false;
    return !['w', 'x', 'y'].includes(b[i]!);
  };
  const ends = (s: string): boolean => {
    const length = s.length;
    if (length > k - k0 + 1) return false;
    for (let i = 0; i < length; i++) if (b[k - length + 1 + i] !== s[i]) return false;
    j = k - length; return true;
  };
  const setto = (s: string) => { for (let i = 0; i < s.length; i++) b[j + 1 + i] = s[i]!; k = j + s.length; b.length = k + 1; };
  const r = (s: string) => { if (m() > 0) setto(s); };
  // step1ab
  if (b[k] === 's') {
    if (ends('sses')) k -= 2; else if (ends('ies')) setto('i'); else if (b[k - 1] !== 's') k--;
    b.length = k + 1;
  }
  if (ends('eed')) { if (m() > 0) { k--; b.length = k + 1; } }
  else if ((ends('ed') || ends('ing')) && vowelInStem()) {
    k = j; b.length = k + 1;
    if (ends('at')) setto('ate'); else if (ends('bl')) setto('ble'); else if (ends('iz')) setto('ize');
    else if (doublec(k)) { k--; const ch = b[k]; if (ch === 'l' || ch === 's' || ch === 'z') k++; b.length = k + 1; }
    else { j = k; if (m() === 1 && cvc(k)) setto('e'); }
  }
  // step1c
  if (ends('y') && vowelInStem()) b[k] = 'i';
  // step2
  if (k > k0) switch (b[k - 1]) {
    case 'a': if (ends('ational')) r('ate'); else if (ends('tional')) r('tion'); break;
    case 'c': if (ends('enci')) r('ence'); else if (ends('anci')) r('ance'); break;
    case 'e': if (ends('izer')) r('ize'); break;
    case 'l': if (ends('bli')) r('ble'); else if (ends('alli')) r('al'); else if (ends('entli')) r('ent'); else if (ends('eli')) r('e'); else if (ends('ousli')) r('ous'); break;
    case 'o': if (ends('ization')) r('ize'); else if (ends('ation')) r('ate'); else if (ends('ator')) r('ate'); break;
    case 's': if (ends('alism')) r('al'); else if (ends('iveness')) r('ive'); else if (ends('fulness')) r('ful'); else if (ends('ousness')) r('ous'); break;
    case 't': if (ends('aliti')) r('al'); else if (ends('iviti')) r('ive'); else if (ends('biliti')) r('ble'); break;
    case 'g': if (ends('logi')) r('log'); break;
  }
  // step3
  switch (b[k]) {
    case 'e': if (ends('icate')) r('ic'); else if (ends('ative')) r(''); else if (ends('alize')) r('al'); break;
    case 'i': if (ends('iciti')) r('ic'); break;
    case 'l': if (ends('ical')) r('ic'); else if (ends('ful')) r(''); break;
    case 's': if (ends('ness')) r(''); break;
  }
  // step4
  step4: if (k > k0) {
    switch (b[k - 1]) {
      case 'a': if (ends('al')) break; break step4;
      case 'c': if (ends('ance') || ends('ence')) break; break step4;
      case 'e': if (ends('er')) break; break step4;
      case 'i': if (ends('ic')) break; break step4;
      case 'l': if (ends('able') || ends('ible')) break; break step4;
      case 'n': if (ends('ant') || ends('ement') || ends('ment') || ends('ent')) break; break step4;
      case 'o': if (ends('ion') && j >= k0 && (b[j] === 's' || b[j] === 't')) break; if (ends('ou')) break; break step4;
      case 's': if (ends('ism')) break; break step4;
      case 't': if (ends('ate') || ends('iti')) break; break step4;
      case 'u': if (ends('ous')) break; break step4;
      case 'v': if (ends('ive')) break; break step4;
      case 'z': if (ends('ize')) break; break step4;
      default: break step4;
    }
    if (m() > 1) { k = j; b.length = k + 1; }
  }
  // step5
  j = k;
  if (b[k] === 'e') { const a = m(); if (a > 1 || (a === 1 && !cvc(k - 1))) { k--; b.length = k + 1; } }
  // As in the reference, j keeps the pre-step5 end here.
  if (b[k] === 'l' && doublec(k) && m() > 1) { k--; b.length = k + 1; }
  return b.slice(0, k + 1).join('');
}

// Word tokens in the spirit of UAX#29 (Lucene StandardTokenizer): letters/digits/underscore,
// kept together across an inner apostrophe or period ("aren't", "u.s.a", "3.14").
const TOKEN = /[\p{L}\p{N}_]+(?:['’.][\p{L}\p{N}_]+)*/gu;
export function analyze(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    let token = match[0].toLowerCase().replace(/’/g, "'");
    if (token.length > 255) continue;
    if (token.endsWith("'s")) token = token.slice(0, -2);
    if (!token || ENGLISH_STOP_WORDS.has(token)) continue;
    out.push(porterStem(token));
  }
  return out;
}

export const BM25_DEFAULTS = Object.freeze({ k1: 0.9, b: 0.4 });
export type Hit = { id: string; score: number };

/** score(q,d) = sum over query tokens t of idf(t) * tf / (tf + k1 * (1 - b + b * |d| / avgdl)),
 * idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5)) (Lucene's BM25Similarity; ranking-equivalent to
 * the classic (k1 + 1) form). Repeated query tokens count repeatedly, as Lucene SHOULD clauses do. */
export function createBm25(docs: { id: string; text: string }[], params: { k1: number; b: number } = BM25_DEFAULTS) {
  const { k1, b } = params;
  if (!(k1 >= 0) || !(b >= 0 && b <= 1) || !docs.length) throw new Error('INVALID_BM25');
  const postings = new Map<string, { doc: number; tf: number }[]>();
  const lengths = new Float64Array(docs.length);
  docs.forEach((doc, index) => {
    const tokens = analyze(doc.text); lengths[index] = tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, tf] of counts) { let list = postings.get(token); if (!list) postings.set(token, list = []); list.push({ doc: index, tf }); }
  });
  const n = docs.length; const avgdl = lengths.reduce((a, x) => a + x, 0) / n || 1;
  const norm = Float64Array.from(lengths, len => k1 * (1 - b + b * len / avgdl));
  return {
    params: { k1, b }, size: n,
    search(query: string, k: number): Hit[] {
      const scores = new Map<number, number>();
      for (const token of analyze(query)) {
        const list = postings.get(token); if (!list) continue;
        const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
        for (const { doc, tf } of list) scores.set(doc, (scores.get(doc) ?? 0) + idf * tf / (tf + norm[doc]!));
      }
      return [...scores].map(([doc, score]) => ({ id: docs[doc]!.id, score }))
        .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).slice(0, k);
    },
  };
}
