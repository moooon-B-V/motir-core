import { describe, expect, it } from 'vitest';
import {
  classifyInput,
  describeProposal,
  loopCommands,
  nextStepHint,
  onboardingUrl,
  parsePlanArgs,
  renderPlan,
  renderProposalTree,
  renderThread,
  renderTurn,
  scopeLabel,
  watchVerdict,
  PROPOSALS_NOT_WORK_ITEMS,
} from '../src/plan.js';
import type { PlanOutcome, PlanProposal, PlanSession, PlanTurn } from '../src/client.js';

// The PURE layer behind `motir plan` (Subtask 7.9.9 · MOTIR-887): argument
// shaping, the loop's input grammar, the watch decision, and the renderers.
// Driven directly here — no MCP, no terminal — so the conversation's behaviour
// is pinned independently of the orchestration that consumes it
// (`planCommand.test.ts`).

function turn(over: Partial<PlanTurn> = {}): PlanTurn {
  return {
    id: 't1',
    seq: 0,
    role: 'user',
    body: 'add auth to the billing epic',
    jobId: null,
    authorId: 'u1',
    createdAt: '2026-07-29T10:00:00.000Z',
    ...over,
  };
}

function session(over: Partial<PlanSession> = {}): PlanSession {
  return {
    id: 's1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    turns: [],
    ...over,
  };
}

function outcome(over: Partial<PlanOutcome> = {}): PlanOutcome {
  return {
    planId: 'plan_1',
    status: 'generating',
    origin: 'user',
    jobId: 'job_1',
    itemCount: 0,
    job: null,
    ...over,
  };
}

function add(id: string, over: Partial<PlanProposal> = {}): PlanProposal {
  return {
    id,
    op: 'add',
    workItemKey: null,
    proposedFields: { title: `Item ${id}`, kind: 'story' },
    patch: null,
    parentRef: null,
    blockedByRefs: [],
    ...over,
  };
}

describe('parsePlanArgs', () => {
  it('reads no arguments as the project-wide conversation', () => {
    expect(parsePlanArgs([])).toEqual({ targetKeys: [], text: null });
  });

  it('takes LEADING key-shaped arguments as the anchor set, uppercased and deduped', () => {
    expect(parsePlanArgs(['motir-42', 'MOTIR-9', 'MOTIR-42'])).toEqual({
      targetKeys: ['MOTIR-42', 'MOTIR-9'],
      text: null,
    });
  });

  it('joins everything from the first non-key onward into one turn body', () => {
    expect(parsePlanArgs(['split', 'the', 'billing', 'epic'])).toEqual({
      targetKeys: [],
      text: 'split the billing epic',
    });
  });

  it('accepts an anchor set AND a one-shot turn together', () => {
    expect(parsePlanArgs(['MOTIR-42', 'size', 'these'])).toEqual({
      targetKeys: ['MOTIR-42'],
      text: 'size these',
    });
  });

  it('stops anchoring at the first non-key, so a later key stays inside the text', () => {
    expect(parsePlanArgs(['make', 'MOTIR-42', 'smaller'])).toEqual({
      targetKeys: [],
      text: 'make MOTIR-42 smaller',
    });
  });

  it('treats whitespace-only text as no text at all', () => {
    expect(parsePlanArgs(['MOTIR-42', '   '])).toEqual({ targetKeys: ['MOTIR-42'], text: null });
  });
});

describe('classifyInput', () => {
  it('reads end of input (Ctrl-D) as leaving, never as submitting', () => {
    expect(classifyInput(null)).toEqual({ kind: 'exit' });
  });

  it('ignores an empty line', () => {
    expect(classifyInput('   ')).toEqual({ kind: 'none' });
  });

  it('recognises the submit / exit / help commands and their aliases', () => {
    expect(classifyInput('/submit')).toEqual({ kind: 'submit' });
    expect(classifyInput(' /SEND ')).toEqual({ kind: 'submit' });
    expect(classifyInput('/exit')).toEqual({ kind: 'exit' });
    expect(classifyInput('/quit')).toEqual({ kind: 'exit' });
    expect(classifyInput('/help')).toEqual({ kind: 'help' });
    expect(classifyInput('/?')).toEqual({ kind: 'help' });
  });

  it('REFUSES an unknown slash word instead of appending it as a planning turn', () => {
    expect(classifyInput('/sumbit')).toEqual({ kind: 'unknown', input: '/sumbit' });
  });

  it('takes ordinary text as a turn, trimmed', () => {
    expect(classifyInput('  split the epic  ')).toEqual({ kind: 'turn', body: 'split the epic' });
  });

  it('lists the in-loop commands, including the accumulate contract', () => {
    expect(loopCommands()).toContain('/submit');
    expect(loopCommands()).toContain('/exit');
    expect(loopCommands()).toMatch(/ACCUMULATE/);
  });
});

describe('scope + URLs', () => {
  it('labels the project-wide and the anchored thread', () => {
    expect(scopeLabel([])).toBe('project-wide');
    expect(scopeLabel(['MOTIR-1', 'MOTIR-2'])).toBe('anchored at MOTIR-1, MOTIR-2');
  });

  it('builds the onboarding URL from the linked server, with no hardcoded host', () => {
    expect(onboardingUrl('https://app.motir.co/')).toBe('https://app.motir.co/onboarding');
  });
});

describe('renderThread', () => {
  it('says OPENED and states that nothing has been submitted on a fresh thread', () => {
    const text = renderThread(session());
    expect(text).toContain('Opened the planning conversation (project-wide) — 0 turns.');
    expect(text).toContain('Never submitted');
  });

  it('RESUMES visibly: the turn count, the last submission, and every turn', () => {
    const text = renderThread(
      session({
        targetKeys: ['MOTIR-42'],
        turnCount: 2,
        lastJobId: 'job_7',
        lastSubmittedAt: '2026-07-29T11:00:00.000Z',
        turns: [
          turn({ body: 'add auth' }),
          turn({ id: 't2', seq: 1, role: 'system', body: 'Submitted.', jobId: 'job_7' }),
        ],
      }),
    );
    expect(text).toContain('Resumed the planning conversation (anchored at MOTIR-42) — 2 turns.');
    expect(text).toContain('Last submitted 2026-07-29T11:00:00.000Z as job job_7.');
    expect(text).toContain('[you] add auth');
    expect(text).toContain('[submitted → job job_7] Submitted.');
  });

  it('singularises a one-turn thread', () => {
    expect(renderThread(session({ turnCount: 1 }))).toContain('— 1 turn.');
  });

  it('renders a submission marker with no job id without inventing one', () => {
    expect(renderTurn(turn({ role: 'system', jobId: null }), 1)).toContain('[submitted → job ?]');
  });

  it('prints a multi-line turn IN FULL, aligned under its own ordinal', () => {
    const text = renderTurn(turn({ body: 'first line\nsecond line' }), 3);
    const [head, second] = text.split('\n');
    expect(head).toContain('3. [you] first line');
    expect(second).toMatch(/^ +second line$/);
    // The user's own intent is never excerpted — a resumed thread that shows a
    // truncation reads as if something was lost.
    expect(second?.trim()).toBe('second line');
  });
});

describe('watchVerdict', () => {
  it('is READY the moment the plan leaves generating', () => {
    expect(watchVerdict(outcome({ status: 'planned' }))).toEqual({ kind: 'ready' });
  });

  it('keeps polling while the job is queued or running', () => {
    expect(watchVerdict(outcome())).toEqual({ kind: 'pending' });
    expect(
      watchVerdict(outcome({ job: { status: 'running', reachable: true, failure: null } })),
    ).toEqual({ kind: 'pending' });
  });

  it('is FAILED on a dead job — a failed job leaves its plan generating forever', () => {
    expect(
      watchVerdict(
        outcome({
          job: { status: 'failed', reachable: true, failure: { code: 'AI_502', message: 'boom' } },
        }),
      ),
    ).toEqual({ kind: 'failed', reachable: true, code: 'AI_502', message: 'boom' });
  });

  it('reports a canceled job, defaulting the code when the server sent no failure', () => {
    expect(
      watchVerdict(outcome({ job: { status: 'canceled', reachable: true, failure: null } })),
    ).toMatchObject({ kind: 'failed', code: 'JOB_CANCELED' });
  });

  it('distinguishes "we could not ask motir-ai" from "your job died"', () => {
    expect(
      watchVerdict(
        outcome({
          job: {
            status: null,
            reachable: false,
            failure: { code: 'AI_DOWN', message: 'no route' },
          },
        }),
      ),
    ).toEqual({ kind: 'failed', reachable: false, code: 'AI_DOWN', message: 'no route' });
  });

  it('defaults the unreachable code + message when the server sent none', () => {
    expect(
      watchVerdict(outcome({ job: { status: null, reachable: false, failure: null } })),
    ).toMatchObject({ kind: 'failed', reachable: false, code: 'AI_UNREACHABLE' });
  });
});

describe('describeProposal', () => {
  it('renders an add with its kind/type, sizing and dependency refs', () => {
    expect(
      describeProposal(
        add('a', {
          proposedFields: {
            title: 'Ship the picker',
            kind: 'subtask',
            type: 'code',
            storyPoints: 3,
            estimateMinutes: 40,
          },
          blockedByRefs: ['planItem:b', 'wi_9'],
        }),
      ),
    ).toBe('+ [subtask/code] Ship the picker (3 pts · 40m) · blocked_by: planItem:b, wi_9');
  });

  it('falls back to task / (untitled) and omits sizing a proposal does not carry', () => {
    expect(describeProposal(add('a', { proposedFields: null }))).toBe('+ [task] (untitled)');
  });

  it('renders points-only and minutes-only sizing', () => {
    expect(
      describeProposal(add('a', { proposedFields: { title: 'T', storyPoints: 5 } })),
    ).toContain('(5 pts)');
    expect(
      describeProposal(add('a', { proposedFields: { title: 'T', estimateMinutes: 20 } })),
    ).toContain('(20m)');
  });

  it('renders a modify as its changed field names', () => {
    expect(
      describeProposal(
        add('m', {
          op: 'modify',
          workItemKey: 'PROD-7',
          patch: { title: 'New', storyPoints: 2, priority: undefined },
        }),
      ),
    ).toBe('~ modify PROD-7 — title, storyPoints');
  });

  it('renders a modify with an empty patch and a remove', () => {
    expect(describeProposal(add('m', { op: 'modify', workItemKey: 'PROD-7', patch: {} }))).toBe(
      '~ modify PROD-7',
    );
    expect(describeProposal(add('r', { op: 'remove', workItemKey: 'PROD-8' }))).toBe(
      '- remove PROD-8',
    );
    expect(describeProposal(add('r', { op: 'remove' }))).toBe('- remove (no target)');
  });
});

describe('renderProposalTree', () => {
  it('nests a child under its intra-plan parent temp-ref', () => {
    expect(renderProposalTree([add('root'), add('child', { parentRef: 'planItem:root' })])).toEqual(
      ['  + [story] Item root', '    + [story] Item child'],
    );
  });

  it('keeps a proposal parented at a REAL work item at the top level', () => {
    // Its parent exists OUTSIDE this plan, so it reads as a new branch hanging
    // off the live tree — the same rule the server's renderer applies.
    expect(renderProposalTree([add('a', { parentRef: 'wi_existing' })])).toEqual([
      '  + [story] Item a',
    ]);
  });

  it('keeps a proposal whose temp-ref parent is not in this plan at the top level', () => {
    expect(renderProposalTree([add('a', { parentRef: 'planItem:missing' })])).toEqual([
      '  + [story] Item a',
    ]);
  });

  it('still prints every proposal when a temp-ref CYCLE leaves none at the root', () => {
    const lines = renderProposalTree([
      add('x', { parentRef: 'planItem:y' }),
      add('y', { parentRef: 'planItem:x' }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('Item x');
    expect(lines.join('\n')).toContain('Item y');
  });
});

describe('renderPlan', () => {
  const base = {
    id: 'plan_1',
    projectId: 'p1',
    title: null,
    summary: null,
    sourceJobId: 'job_1',
    origin: 'user',
  };

  it('prints the proposal tree AND the proposals-are-not-work-items statement', () => {
    const text = renderPlan({
      ...base,
      status: 'planned',
      itemCount: 1,
      items: [add('a')],
    });
    expect(text).toContain('Plan plan_1 — planned, 1 proposal.');
    expect(text).toContain('+ [story] Item a');
    expect(text).toContain(PROPOSALS_NOT_WORK_ITEMS);
    // The failure this guards against: a client reporting work it never created.
    expect(text).not.toMatch(/creat(ed|ing) \d+ (work )?item/i);
  });

  it('prints an optional title and summary, and pluralises the count', () => {
    const text = renderPlan({
      ...base,
      title: 'Billing split',
      summary: 'Three stories.',
      status: 'planned',
      itemCount: 2,
      items: [add('a'), add('b')],
    });
    expect(text).toContain('Title: Billing split');
    expect(text).toContain('Summary: Three stories.');
    expect(text).toContain('2 proposals.');
  });

  it('says the planner is still working when a generating plan has no items yet', () => {
    expect(renderPlan({ ...base, status: 'generating', itemCount: 0, items: [] })).toContain(
      'still generating',
    );
  });

  it('says a settled plan simply bundles nothing', () => {
    expect(renderPlan({ ...base, status: 'planned', itemCount: 0, items: [] })).toContain(
      'bundles no proposals',
    );
  });
});

describe('nextStepHint', () => {
  it('offers refine-or-approve, resuming the same project-wide thread', () => {
    const text = nextStepHint('https://motir.test/plans/plan_1', []);
    expect(text).toContain('`motir plan` adds another turn');
    expect(text).toContain('https://motir.test/plans/plan_1');
  });

  it('resumes the ANCHORED thread when the conversation was anchored', () => {
    expect(nextStepHint(null, ['MOTIR-1', 'MOTIR-2'])).toContain('`motir plan MOTIR-1 MOTIR-2`');
  });

  it('degrades to a prose pointer when the review URL could not be built', () => {
    expect(nextStepHint(null, [])).toContain('open the plan in Motir');
  });
});
