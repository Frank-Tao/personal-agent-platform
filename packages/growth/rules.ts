import { aboutState, type AboutEntry } from './model.ts';

// Always-apply rules: the About-you entries Frank marked "always apply" (and said himself) are written into each agent's SOUL.md, at the
// very top and outside the roster persona block, so they are in the system prompt of every turn. They do not depend on an agent
// remembering to ask for a growth packet, and they reach the Personal Privacy agent too. `agents sync` leaves this block alone.

export const RULES_BEGIN = '<!-- owner-rules:begin -->';
export const RULES_END = '<!-- owner-rules:end -->';

/** The rules that apply to one agent: active, marked always, from "every agent" or from that agent. */
export function alwaysRules(entries: AboutEntry[], agent: string, today: string): AboutEntry[] {
  return entries.filter((e) => e.always === true && e.source === 'user-said' && (e.scope === '*' || e.scope === agent) && aboutState(e, today) === 'active');
}

export function rulesBlock(rules: AboutEntry[]): string {
  if (!rules.length) return '';
  const lines = rules.map((r) => `- ${r.text}`).join('\n');
  return `${RULES_BEGIN}\n## Rules from Frank (always apply; they win over the persona below and over any skill)\n${lines}\n${RULES_END}\n`;
}

/** Put the rules block at the top of a SOUL.md, replacing the previous one; no rules removes the block. Everything else is untouched. */
export function mergeRules(existing: string, block: string): string {
  const a = existing.indexOf(RULES_BEGIN), b = existing.indexOf(RULES_END);
  const rest = a !== -1 && b > a ? (existing.slice(0, a) + existing.slice(b + RULES_END.length)).replace(/^\n+/, '') : existing;
  if (!block) return rest;
  return rest.trim() ? `${block}\n${rest}` : block;
}
