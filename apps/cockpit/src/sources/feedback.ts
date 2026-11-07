import { listProposals } from '../../../../packages/work/decide.ts';
import type { Source } from '../types.ts';

/** One Needs-you entry per pending feedback proposal (design §7.1). */
export const feedbackSource = (dir: string): Source => async () => ({
  cards: [], errors: [],
  needs: listProposals({ dir }).filter((p) => p.status === 'pending').map((p) => ({
    portfolioId: 'atlas', kind: 'approval' as const, severity: 'info' as const,
    title: `Feedback proposal to decide: ${p.title} (${p.count} ${p.count === 1 ? 'note' : 'notes'})`,
  })),
});
