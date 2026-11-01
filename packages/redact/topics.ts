import { findPii } from './redact.ts';

// "Is this message about something private?" Used to keep such messages away from cloud models: detected values (account numbers,
// tax file numbers, emails…) or an explicit private document/topic. Narrow on purpose: a false positive only means a local answer.

const TOPICS: Array<[string, RegExp]> = [
  ['bank-statement', /\b(bank|credit card|card|account) (statement|balance|transactions?)\b/i],
  ['payslip', /\b(pay ?slips?|salary|my (income|wage|earnings))\b/i],
  ['tax', /\b(tax return|tax file number|tfn|ato|group certificate|capital gains)\b/i],
  ['identity', /\b(passport|driver'?s? licen[cs]e|medicare (number|card)|visa (number|grant))\b/i],
  ['health', /\b(diagnos\w+|prescription|medical (record|history|report)|my (doctor|therapist|medication))\b/i],
  ['net-worth', /\b(net worth|my (mortgage|loan|super(annuation)?|savings) (balance|amount)|how much (do|did) (i|we) (owe|have|earn|spend))\b/i],
  ['legal-family', /\b(divorce|custody|will and testament|lawsuit|immigration case)\b/i],
];

export interface PrivacyVerdict { private: boolean; reasons: string[] }

/** Reasons are kinds only (never the matched text). */
export function privacyCheck(text: string): PrivacyVerdict {
  const reasons = [...new Set([...findPii(text).map((h) => h.kind), ...TOPICS.filter(([, re]) => re.test(text)).map(([k]) => k)])];
  return { private: reasons.length > 0, reasons };
}
