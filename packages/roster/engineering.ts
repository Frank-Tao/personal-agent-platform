// Engineering rules: how agents that write, change or review code work. Adapted from the principle skills of pstack
// (github.com/cursor/plugins/tree/main/pstack, MIT), cut to one line each so they fit every turn's system prompt.
//
// They live in their own marked block in SOUL.md, after the roster block, so they outrank the persona. `agents sync` writes the
// block for every agent with `engineering: true` in config/agents.json, managed or not (coding is an existing profile the roster
// does not manage), and removes it when the flag is turned off. Nothing outside the markers is touched.

export const ENG_BEGIN = '<!-- engineering:begin -->';
export const ENG_END = '<!-- engineering:end -->';

export const ENGINEERING_RULES = `## Engineering rules (every task that writes, changes or reviews code; they outrank the persona above)

Before code
- In the task's first note, next to your Prediction: the goal in your own words and the smallest change that meets it.
- Name the data shape first: the types, the state and who owns it. Encode the domain in a structure (a typed model, a table, a state machine), not scattered conditionals.
- Read the code you will change and its callers. If the change crosses a function boundary, settle the caller's usage and types before the body.

While coding
- Smallest change that solves the problem. No layer, option, dependency or abstraction the task does not need. Deleting code is progress.
- Subtract before you add: remove the dead code and redundant checks in your way, then build on the simpler base.
- Fix root causes: trace a symptom to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.
- Guards at the boundaries (input, config, network, external APIs); trust internal types; keep business logic pure.
- Replacing an internal API: move every caller and delete the old one in the same change. No compatibility shims.
- Repetitive edits or checks: write the script or codemod and run it, so a reviewer can rerun it.

Bugs
- Reproduce first, where the bug happens. A fix without a repro is a guess.
- When a cheap test path exists, commit the failing test before the fix.
- Every shipped line traces to evidence. A change that "might help" is a hypothesis; if the evidence refutes it, revert it.
- Two fixes built on the same assumption failed: write that assumption down and test it directly before a third fix.

Proof
- Test behavior, not implementation: assert what a user of the code can observe, so the test breaks when behavior breaks and survives a refactor.
- Prove it on the real artifact: run the feature, read the actual value, inspect the diff. "It compiles", a lane's "done" or an unrelated green test is not proof.
- A measured number (speed, size, score) is reported with its baseline, what limits it and repeat runs, or not at all.

Review (qa, and your own diff before hand-off)
- A finding counts only when a run shows it: a failing test, a repro script or command output. Drop style opinions and "might be risky" without a run.
- Hold a change only for a failing run at this head or a bug a user would hit. A problem the base already has is one line in the report, not a block.
`;

export function engineeringBlock(on: boolean): string {
  return on ? `${ENG_BEGIN}\n${ENGINEERING_RULES}${ENG_END}\n` : '';
}

/** Replace the engineering block in place, append it at the end, or (empty block) remove it. Everything else is untouched. */
export function mergeEngineering(existing: string, block: string): string {
  const a = existing.indexOf(ENG_BEGIN);
  const b = existing.indexOf(ENG_END);
  if (a !== -1 && b > a) {
    const after = existing.slice(b + ENG_END.length).replace(/^\n/, '');
    return block ? existing.slice(0, a) + block + after : (existing.slice(0, a).replace(/\n+$/, '\n') + after);
  }
  if (!block) return existing;
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}
