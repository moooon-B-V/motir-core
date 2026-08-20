import type { WorkItemClaim } from '../../src/client.js';

// THE SERVER'S CLAIM RULE, as the CLI's own fakes must model it (MOTIR-3048).
//
// `POST /work-items/{key}/claim` (MOTIR-2961) is the one call every dispatch
// path now makes, and the CLI's whole job is to act on WHICH of the four
// answers it got. A fake that always says `claimed` therefore tests nothing
// this card added — so the three command suites drive their fakes through this
// one function rather than each writing a rule that could drift from the
// server's, and from each other's.
//
// It is the same decision `workItemsService.claimWorkItem` makes, minus the
// lock (a single-process fake has nothing to lock against) and minus the
// statuses no fake defines: the to-do CATEGORY is claimable, `in_progress` is
// mine or theirs, and everything else is refused.

/** The to-do CATEGORY of the default workflow — never a status key list a
 *  project could extend past. Both members are claimable, which is why
 *  `motir run --force` on a `blocked` card still takes it. */
const TODO_CATEGORY = new Set(['todo', 'blocked']);

/** How the row looks to the fake before the claim is attempted. */
export interface FakeClaimRow {
  key: string;
  title?: string | null;
  status: string;
  assigneeId: string | null;
}

/** Who is asking, and what the answer says about them. */
export interface FakeClaimCaller {
  id: string;
  name: string;
}

/**
 * Resolve a claim exactly as the server does, and report BOTH halves: the
 * result the CLI sees, and the row mutation the fake should apply.
 *
 * The mutation is returned rather than applied so the caller keeps ownership of
 * its own item store — the three fakes model rows differently and only one of
 * them is a class.
 */
export function resolveFakeClaim(
  row: FakeClaimRow,
  caller: FakeClaimCaller,
  holderName: (id: string) => string = (id) => id,
): { claim: WorkItemClaim; apply: { status: string; assigneeId: string } | null } {
  const base = {
    key: row.key,
    title: row.title ?? `Item ${row.key}`,
    transitionedAt: '2026-08-19T12:00:00.000Z',
  };

  if (TODO_CATEGORY.has(row.status)) {
    // CLAIMED — assigned and flipped, both under the one lock the real endpoint
    // holds. The previous assignee is overwritten on purpose: a to-do card
    // belonging to somebody else is still claimable, and taking it over is what
    // the CLI's surviving `pickWarning` warns a person about.
    return {
      claim: {
        ...base,
        outcome: 'claimed',
        claimed: true,
        status: { key: 'in_progress', category: 'in_progress' },
        assignee: { id: caller.id, name: caller.name },
        transitionedBy: { id: caller.id, name: caller.name },
      },
      apply: { status: 'in_progress', assigneeId: caller.id },
    };
  }

  if (row.status === 'in_progress' && row.assigneeId === caller.id) {
    // MINE — the documented recovery for a card this owner's failed agent left
    // behind. Nothing is written; the card is already where a claim would put it.
    return {
      claim: {
        ...base,
        outcome: 'mine',
        claimed: false,
        status: { key: 'in_progress', category: 'in_progress' },
        assignee: { id: caller.id, name: caller.name },
        transitionedBy: { id: caller.id, name: caller.name },
      },
      apply: null,
    };
  }

  if (row.status === 'in_progress') {
    // TAKEN — somebody else is on it, and the loser is told WHO. `assignee` is
    // null in the MOTIR-2958 shape (a sibling that moved the status without
    // ever assigning), which is exactly why `transitionedBy` is carried too.
    const holder = row.assigneeId;
    return {
      claim: {
        ...base,
        outcome: 'taken',
        claimed: false,
        status: { key: 'in_progress', category: 'in_progress' },
        assignee: holder ? { id: holder, name: holderName(holder) } : null,
        transitionedBy: holder ? { id: holder, name: holderName(holder) } : null,
      },
      apply: null,
    };
  }

  // NOT CLAIMABLE — `implemented`, `in_review`, `planning`, `done`, `cancelled`,
  // and any status the workflow does not define. Finished work is not "taken".
  return {
    claim: {
      ...base,
      outcome: 'not_claimable',
      claimed: false,
      status: { key: row.status, category: categoryOf(row.status) },
      assignee: row.assigneeId ? { id: row.assigneeId, name: holderName(row.assigneeId) } : null,
      transitionedBy: null,
    },
    apply: null,
  };
}

/** The default workflow's categories, for the statuses a fake can produce. */
function categoryOf(status: string): string | null {
  if (TODO_CATEGORY.has(status)) return 'todo';
  if (['in_progress', 'implemented', 'planning', 'in_review'].includes(status))
    return 'in_progress';
  if (['done', 'cancelled'].includes(status)) return 'done';
  return null;
}
