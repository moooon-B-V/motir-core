import { describe, expect, it } from 'vitest';
import {
  SCOPE_SPRINT,
  childrenBelowClaimBar,
  classifyScopeTarget,
  dispositionOf,
  epicRefusal,
  parseScopeArgument,
  renderClaimedScope,
  openChildrenHoldReason,
  renderEmptyScope,
  renderOpenChildrenHold,
  renderScopeRefusal,
  unexpandedRefusal,
} from '../src/scopedRun.js';
import type { DispatchItem, ScopeClaim } from '../src/client.js';

// The PURE half of the scoped run (Story MOTIR-3001 · MOTIR-3198) against plain
// objects — the split `autoLoop.ts` / `batchPlan.ts` already keep from their
// command files.
//
// The card's interesting behaviour is a six-way branch over a typed server
// result, and every branch has a DIFFERENT thing for the reader to do. Rendering
// them as one "claim failed" line throws away exactly what the endpoint was
// built to carry, so what is asserted below is that each refusal names what the
// SERVER named: the offending card and its holder, the container child and its
// depth, the blocking pairs.

function claim(over: Partial<ScopeClaim> = {}): ScopeClaim {
  return {
    scope: { kind: 'work_item', key: 'PROD-1', sprintId: null, name: 'The story' },
    outcome: 'claimed',
    claimed: true,
    members: [],
    offender: null,
    shape: null,
    blockers: [],
    ...over,
  };
}

function member(key: string, title = `Item ${key}`) {
  return { key, title, status: { key: 'in_progress', category: 'in_progress' } };
}

function readyRow(key: string, title = `Item ${key}`): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title,
    assigneeId: null,
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
  };
}

describe('parseScopeArgument', () => {
  it('reads the reserved word `sprint`, case-insensitively', () => {
    expect(parseScopeArgument(SCOPE_SPRINT)).toEqual({ kind: 'sprint' });
    expect(parseScopeArgument('  Sprint ')).toEqual({ kind: 'sprint' });
  });

  it('reads anything else as a work-item key, normalised', () => {
    expect(parseScopeArgument('prod-42')).toEqual({ kind: 'work_item', key: 'PROD-42' });
  });

  it('does not confuse a project literally keyed SPRINT with the reserved word', () => {
    // The disambiguation is literal equality, not a heuristic: such a project
    // still addresses its cards as `SPRINT-7`, which is not `sprint`.
    expect(parseScopeArgument('SPRINT-7')).toEqual({ kind: 'work_item', key: 'SPRINT-7' });
  });
});

describe('classifyScopeTarget — the SHAPE decides, not the kind', () => {
  it('a childless subtask / task / bug is a LEAF: today’s single-card dispatch', () => {
    for (const kind of ['subtask', 'task', 'bug']) {
      expect(classifyScopeTarget({ kind, childCount: 0 })).toEqual({ kind: 'leaf' });
    }
  });

  it('a CONTAINER of any kind is a scope — including a task and a bug', () => {
    // `lib/issues/parentRules.ts` permits `story → task → subtask` and
    // `task → bug`, so a rule keyed on KIND would run a container bug as one
    // card. This is the assertion that fails against such a rule.
    for (const kind of ['story', 'task', 'bug']) {
      expect(classifyScopeTarget({ kind, childCount: 3 })).toEqual({ kind: 'scope' });
    }
  });

  it('an EPIC is refused by kind, even when it holds only leaves', () => {
    expect(classifyScopeTarget({ kind: 'epic', childCount: 4 })).toEqual({ kind: 'refuse_epic' });
    expect(classifyScopeTarget({ kind: 'epic', childCount: 0 })).toEqual({ kind: 'refuse_epic' });
  });

  it('a CHILDLESS story is a planning item, not a leaf', () => {
    // The one genuine behaviour removal in the ADR: `motir run <childless
    // story>` used to dispatch an agent at a card with no work under it.
    expect(classifyScopeTarget({ kind: 'story', childCount: 0 })).toEqual({
      kind: 'refuse_unexpanded',
    });
  });
});

describe('the refusal copy', () => {
  it('an epic names what to run instead', () => {
    const { message, hint } = epicRefusal('PROD-9');
    expect(message).toBe('PROD-9 is an epic — an epic is never a run target.');
    expect(hint).toContain('motir show PROD-9');
  });

  it('a childless container names both ways out', () => {
    const { message, hint } = unexpandedRefusal('PROD-3');
    expect(message).toContain('it is a planning item, not work');
    expect(hint).toContain('motir plan PROD-3');
    expect(hint).toContain('--include-planning');
  });
});

describe('dispositionOf', () => {
  it('`mine` PROCEEDS — it is a resume of the caller’s own run, not a refusal', () => {
    expect(dispositionOf('claimed')).toBe('proceed');
    expect(dispositionOf('mine')).toBe('proceed');
  });

  it('`wrong_shape` is the only outcome that submits a plan', () => {
    expect(dispositionOf('wrong_shape')).toBe('replan');
    // ⚠️ `not_finishable` stops WITHOUT a re-plan: out-of-scope work gating
    // in-scope work is a fact about the rest of the tree, and re-planning the
    // container would be re-planning the wrong thing.
    expect(dispositionOf('not_finishable')).toBe('stop');
    expect(dispositionOf('taken')).toBe('stop');
    expect(dispositionOf('not_claimable')).toBe('stop');
  });
});

describe('renderScopeRefusal', () => {
  it('`taken` names the offending card, its status AND its holder', () => {
    const out = renderScopeRefusal(
      claim({
        outcome: 'taken',
        claimed: false,
        offender: {
          key: 'PROD-4',
          title: 'Held elsewhere',
          status: { key: 'in_progress', category: 'in_progress' },
          assignee: { id: 'u2', name: 'Rival Runner' },
          transitionedBy: null,
          transitionedAt: null,
        },
      }),
    );

    expect(out).toContain('already held by Rival Runner');
    expect(out).toContain('PROD-4 — Held elsewhere (at in_progress)');
    expect(out).toContain('Nothing was locked.');
  });

  it('`taken` still names a holder when nothing was ASSIGNED, only transitioned', () => {
    // The MOTIR-2958 shape: a sibling flipped the status without assigning, so
    // `assignee` is null and `transitionedBy` is the only witness. A refusal
    // that said "by somebody else" here would be silence wearing a sentence.
    const out = renderScopeRefusal(
      claim({
        outcome: 'taken',
        claimed: false,
        offender: {
          key: 'PROD-4',
          title: 'Held elsewhere',
          status: { key: 'in_progress', category: 'in_progress' },
          assignee: null,
          transitionedBy: { id: 'u3', name: 'Another Session' },
          transitionedAt: '2026-08-20T10:00:00.000Z',
        },
      }),
    );

    expect(out).toContain('already held by Another Session');
  });

  it('`wrong_shape` names the container child and how deep the work sits', () => {
    const out = renderScopeRefusal(
      claim({
        outcome: 'wrong_shape',
        claimed: false,
        shape: { child: 'PROD-7', childTitle: 'A task of its own', depth: 2 },
      }),
    );

    expect(out).toContain('PROD-7 — A task of its own is itself a container');
    expect(out).toContain('2 levels from the story');
    expect(out).toContain('Nothing was locked.');
  });

  it('`not_finishable` prints the blocking PAIRS the validator named', () => {
    const out = renderScopeRefusal(
      claim({
        outcome: 'not_finishable',
        claimed: false,
        blockers: [
          {
            item: 'PROD-5',
            blockedBy: 'PROD-99',
            blockerStatus: 'todo',
            blockerSprintId: null,
          },
        ],
      }),
    );

    expect(out).toContain('PROD-5 is blocked by PROD-99 (todo), which is OUTSIDE the scope');
    expect(out).toContain('cannot be finished from inside itself');
  });

  it('`not_claimable` explains the TO-DO-category rule rather than restating the status', () => {
    const out = renderScopeRefusal(
      claim({
        outcome: 'not_claimable',
        claimed: false,
        offender: {
          key: 'PROD-6',
          title: 'Already reviewed',
          status: { key: 'in_review', category: 'in_progress' },
          assignee: null,
          transitionedBy: null,
          transitionedAt: null,
        },
      }),
    );

    expect(out).toContain('PROD-6 — Already reviewed (at in_review)');
    expect(out).toContain('claims from the TO-DO category only');
  });

  it('`mine` reads as a RESUME even through the refusal renderer', () => {
    // Unreachable from the command — `mine` dispositions to `proceed` — and
    // answered anyway, so the function is total over the vocabulary rather than
    // over today's callers. A `default:` that swallowed it would turn a future
    // caller's resume into the word "claimed".
    expect(renderScopeRefusal(claim({ outcome: 'mine', claimed: false }))).toBe(
      'PROD-1 "The story": already yours — resuming.',
    );
  });

  it('`not_finishable` says so even when the validator named no PAIR', () => {
    // The verdict is the server's; the blocker list is its evidence. An empty
    // list must not render as a bare heading with nothing under it, which reads
    // as a truncated message rather than as a scope nobody can finish.
    const out = renderScopeRefusal(
      claim({ outcome: 'not_finishable', claimed: false, blockers: [] }),
    );
    expect(out).toContain('cannot be finished from inside itself');
    expect(out).toContain('(the validator named no specific pair)');
  });

  it('an unknown outcome falls through to `claimed` rather than throwing', () => {
    // A CLI meets servers older and newer than itself; a vocabulary this build
    // does not know must degrade, not crash.
    expect(renderScopeRefusal(claim({ outcome: 'claimed' }))).toBe('PROD-1 "The story": claimed.');
  });

  it('labels a SPRINT scope by its name, not by a null key', () => {
    const out = renderScopeRefusal(
      claim({
        scope: { kind: 'sprint', key: null, sprintId: 's1', name: 'Sprint 44' },
        outcome: 'taken',
        claimed: false,
      }),
    );

    expect(out).toContain('The active sprint "Sprint 44"');
    expect(out).not.toContain('null');
  });
});

describe('renderClaimedScope', () => {
  it('lists the ready leaves in rank, excludes the container, and names the In-Progress cost', () => {
    const out = renderClaimedScope(
      claim({
        members: [member('PROD-1', 'The story'), member('PROD-2'), member('PROD-3')],
      }),
      [readyRow('PROD-2'), readyRow('PROD-3')],
    );

    expect(out).toContain('Claimed PROD-1 "The story" — 2 work items, all of them, or none.');
    expect(out).toContain('PROD-2');
    expect(out).toContain('PROD-3');
    // ⚠️ The container is a SCOPE, not work. It is claimed and it is not run.
    expect(out).not.toMatch(/^\s*PROD-1\s+/m);
    // The one consequence of this design a person has to be TOLD rather than
    // discover from a board full of in-progress cards.
    expect(out).toContain('Every work item above now reads In Progress');
    expect(out).toContain('THIS RUN OWNS IT');
  });

  it('says so plainly when the claim holds cards but NONE of them can start', () => {
    // Reachable on a resume: the run already owns the scope (`mine`) and every
    // leaf is mid-flight. An empty table would read as a rendering bug.
    const out = renderClaimedScope(
      claim({ members: [member('PROD-1', 'The story'), member('PROD-2')] }),
      [],
    );
    expect(out).toContain('Nothing in it is ready to start.');
    expect(out).toContain('Also claimed, not startable yet (1)');
  });

  it('names the claimed-but-not-startable cards separately, so the footprint is visible', () => {
    // These are the cards whose blockers are inside the same scope. Printing
    // only the ready set would hide exactly the rows an operator will see go
    // In Progress with nothing happening to them.
    const out = renderClaimedScope(
      claim({ members: [member('PROD-1', 'The story'), member('PROD-2'), member('PROD-4')] }),
      [readyRow('PROD-2')],
    );

    expect(out).toContain('Also claimed, not startable yet (1)');
    expect(out).toContain('PROD-4');
  });
});

describe('the DEFENSIVE arms — a server that answers with an outcome and no detail', () => {
  // A CLI meets servers older and newer than itself, and every `?.` in the
  // renderers is a shape the generated types admit. What matters is that the
  // refusal still READS — a message that degraded to "undefined — undefined" is
  // worse than no message, because the reader cannot tell it is degraded.
  it('`taken` with NO offender still names the scope and says nothing was locked', () => {
    const out = renderScopeRefusal(claim({ outcome: 'taken', claimed: false, offender: null }));
    expect(out).toContain('a member');
    expect(out).toContain('an unknown status');
    expect(out).not.toContain('undefined');
  });

  it('`wrong_shape` with NO shape detail still says the shape is not runnable', () => {
    const out = renderScopeRefusal(claim({ outcome: 'wrong_shape', claimed: false, shape: null }));
    expect(out).toContain('a child');
    expect(out).toContain('2 levels from the story');
    expect(out).not.toContain('undefined');
  });

  it('renders a SPRINT scope’s claimed table, whose container key is null', () => {
    // The container of a sprint scope is the sprint, which has no work-item key
    // — so the "exclude the container" filter has nothing to match, and every
    // member is a card the run works.
    const out = renderClaimedScope(
      claim({
        scope: { kind: 'sprint', key: null, sprintId: 's1', name: 'Sprint 44' },
        members: [member('PROD-2'), member('PROD-3')],
      }),
      [readyRow('PROD-2'), readyRow('PROD-3')],
    );
    expect(out).toContain('Claimed The active sprint "Sprint 44" — 2 work items');
    expect(out).not.toContain('null');
  });
});

describe('renderEmptyScope', () => {
  it('reads as a plan state, not as a failure', () => {
    const out = renderEmptyScope('PROD-1');
    expect(out).toContain('nothing is ready to start');
    expect(out).toContain('Nothing was claimed and nothing was changed.');
    // Distinguishable from a refusal: it never says NOT claimed, which is the
    // phrase every refusal above leads with.
    expect(out).not.toContain('NOT claimed');
  });
});

// ── the CLOSE-OUT gate (Bug MOTIR-3268) ─────────────────────────────────────

describe('childrenBelowClaimBar', () => {
  const child = (identifier: string, status: string) => ({
    identifier,
    kind: 'subtask',
    title: `Item ${identifier}`,
    status,
  });

  it('clears `implemented`-or-better and names everything below it', () => {
    expect(
      childrenBelowClaimBar([
        child('A', 'implemented'),
        child('B', 'in_review'),
        child('C', 'done'),
        child('D', 'cancelled'),
        child('E', 'todo'),
        child('F', 'in_progress'),
        child('G', 'blocked'),
        child('H', 'planning'),
      ]),
    ).toEqual(['E', 'F', 'G', 'H']);
  });

  it('an UNKNOWN status ranks below the bar — the conservative direction', () => {
    // ⚠️ A status nobody can classify is not evidence that anything is finished,
    // and this side ranks by KEY because the child rows v1 publishes carry no
    // category. The error it can make is to HOLD a pull request the server would
    // have allowed; it cannot open one the server would refuse.
    expect(childrenBelowClaimBar([child('A', 'shipped-ish')])).toEqual(['A']);
  });

  it('is case-insensitive, and a container with no children holds nothing', () => {
    expect(childrenBelowClaimBar([child('A', 'IMPLEMENTED')])).toEqual([]);
    expect(childrenBelowClaimBar([])).toEqual([]);
  });
});

describe('openChildrenHoldReason', () => {
  it("mirrors the server's sentence — count, grammar and the named children", () => {
    expect(openChildrenHoldReason('PROD-1', ['PROD-9'])).toBe(
      'PROD-1 cannot claim to be implemented while 1 of its children has not been: PROD-9.',
    );
    expect(openChildrenHoldReason('PROD-1', ['PROD-9', 'PROD-10'])).toContain(
      '2 of its children have not been: PROD-9, PROD-10.',
    );
  });

  it('names five and COUNTS the rest, exactly as the server error does', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const out = openChildrenHoldReason('PROD-1', many);
    expect(out).toContain('A, B, C, D, E (+2 more)');
    expect(out).not.toContain('F');
  });
});

describe('renderOpenChildrenHold', () => {
  it('names every open child and all three dispositions', () => {
    const out = renderOpenChildrenHold('PROD-1', ['PROD-9', 'PROD-10']);
    expect(out).toContain('NO pull request was opened');
    expect(out).toContain('PROD-9 — not implemented');
    expect(out).toContain('PROD-10 — not implemented');
    // ⚠️ THE RUN PICKS NONE OF THEM. Each is a decision about SCOPE — is this
    // card part of the story or not — which an unattended run has no standing to
    // answer, so naming all three is what makes this a stop rather than a
    // failure the operator has to diagnose.
    expect(out).toContain('LAND them — `motir run PROD-9`');
    expect(out).toContain('RE-PARENT them out of PROD-1');
    expect(out).toContain('move PROD-1 to Done');
    // It says out loud that nothing was lost — the branch is pushed.
    expect(out).toContain('work IS pushed');
  });

  it('never prints `undefined` when the open list is somehow empty', () => {
    // Not reachable through the command, which only renders this with a
    // non-empty list — answered anyway so the function is total over its own
    // signature rather than over today's one caller.
    expect(renderOpenChildrenHold('PROD-1', [])).toContain('`motir run <key>`');
  });
});
