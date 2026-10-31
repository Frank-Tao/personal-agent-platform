// Deterministic PII filter. Second pass after the local LLM, and a gate on everything the
// dashboard/brief reads from the private summaries folder. Fails closed: a false positive
// (e.g. an unformatted 8+ digit number) is acceptable, a leak is not.

export interface PiiHit {
  kind: string;
  match: string;
}

const PATTERNS: Array<[string, RegExp]> = [
  ['ssn', /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g],
  ['card', /\b(?:\d{4}[ -]){3}\d{4}\b/g],
  ['account-number', /\b\d{8,17}\b/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['phone', /(?:\+?\d{1,2}[ .-])?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g],
  [
    'street-address',
    /\b\d{1,6}\s+(?:[A-Za-z0-9.]+\s){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place)\b\.?/gi,
  ],
];

export function findPii(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ kind, match: m[0] });
  }
  return hits;
}

export function redact(text: string): string {
  let out = text;
  for (const [kind, re] of PATTERNS) out = out.replace(re, `[REDACTED:${kind}]`);
  return out;
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      yield k;
      yield* strings(v);
    }
}

/** Throws if any string (key or value) inside `value` looks like PII. */
export function assertNoPii(value: unknown, label = 'value'): void {
  for (const s of strings(value)) {
    const hits = findPii(s);
    if (hits.length) {
      throw new Error(`PII check failed for ${label}: ${hits.map((h) => h.kind).join(', ')}`);
    }
  }
}
