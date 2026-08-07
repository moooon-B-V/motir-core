import { describe, expect, it } from 'vitest';
import {
  assembleDispatchPrompt,
  branchSlug,
  NO_INJECTIONS,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';

// PURE unit suite for the dispatch-prompt GRAMMAR (Story 7.9 · MOTIR-1802). No
// DB — the assembler reads nothing, which is the property that makes the prompt
// byte-identical across calls (the contract MOTIR-881 tests against). The
// service-level, real-Postgres half lives in `tests/dispatch/dispatchPrompt.test.ts`.

/** A complete `code` source; each test overrides only what it is about. */
function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Add the ready-set filter bar',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    priority: 'high',
    storyPoints: 5,
    estimateMinutes: 90,
    descriptionMd: [
      'Build the filter bar above the ready list.',
      '',
      '## Acceptance criteria',
      '',
      '- The bar filters by kind and priority.',
      '- An empty result renders the empty state.',
      '',
      '## Context refs',
      '',
      '- `lib/dto/ready.ts` — the DTO',
      '- `app/(authed)/ready/page.tsx`',
    ].join('\n'),
    blockerKeys: ['PROD-3', 'PROD-5'],
    parent: { key: 'PROD-2', title: 'Ready surface' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    ...over,
  };
}

/** The four canonical section headings, in the order the grammar emits them.
 *  Matched as a line PREFIX — `ACCEPTANCE CRITERIA` carries a suffix. */
const SECTIONS = [
  'CONTEXT',
  'WHAT TO DO',
  'ACCEPTANCE CRITERIA',
  'GIT WORKFLOW',
  'REPORTING THE OUTCOME',
];

/** Everything from the outcome heading to the end — the section under test in
 *  the MOTIR-2406 block, sliced so an assertion about it cannot be satisfied by
 *  text somewhere else in the prompt. */
function outcomeSection(prompt: string): string {
  const at = prompt.indexOf('REPORTING THE OUTCOME');
  expect(at, 'the prompt carries a REPORTING THE OUTCOME section').toBeGreaterThan(-1);
  return prompt.slice(at);
}

describe('splitPlanBody — the plan-body section parser', () => {
  it('partitions narrative / acceptance criteria / context refs', () => {
    const parsed = splitPlanBody(source().descriptionMd);
    expect(parsed.body).toBe('Build the filter bar above the ready list.');
    expect(parsed.acceptanceCriteria).toEqual([
      '- The bar filters by kind and priority.',
      '- An empty result renders the empty state.',
    ]);
    expect(parsed.contextRefs).toEqual(['lib/dto/ready.ts', 'app/(authed)/ready/page.tsx']);
  });

  it('returns empty parts for an empty body, and the whole body when it follows no convention', () => {
    expect(splitPlanBody(null)).toEqual({ body: '', acceptanceCriteria: [], contextRefs: [] });
    expect(splitPlanBody('')).toEqual({ body: '', acceptanceCriteria: [], contextRefs: [] });
    const plain = splitPlanBody('# Title\n\nJust prose.\n\n## Notes\n\n- a note');
    expect(plain.body).toBe('# Title\n\nJust prose.\n\n## Notes\n\n- a note');
    expect(plain.acceptanceCriteria).toEqual([]);
    expect(plain.contextRefs).toEqual([]);
  });

  it('is case- and level-insensitive on the headings and keeps nested criteria indentation', () => {
    const parsed = splitPlanBody(
      [
        '### ACCEPTANCE CRITERIA',
        '',
        '- top',
        '  - nested',
        '',
        '### Context Ref',
        '- `a.ts`',
      ].join('\n'),
    );
    expect(parsed.acceptanceCriteria).toEqual(['- top', '  - nested']);
    expect(parsed.contextRefs).toEqual(['a.ts']);
  });

  it('keeps `extractContextRefs` behaviour identical (it now delegates here)', () => {
    const md = '## Context refs\n\n- `path/one.ts` — the DTO\n- plain ref two - trailing\n';
    expect(extractContextRefs(md)).toEqual(['path/one.ts', 'plain ref two']);
    expect(extractContextRefs(null)).toEqual([]);
    expect(extractContextRefs('No refs here.')).toEqual([]);
  });
});

describe('assembleDispatchPrompt — the four-section grammar', () => {
  it('emits all four sections in order, with the card interpolated', () => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(source());

    // Sections, in order.
    const positions = SECTIONS.map((s) => prompt.indexOf(`\n${s}`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // The card's own content, not a template placeholder.
    expect(prompt).toContain('You are working on the Motir project.');
    expect(prompt).toContain('You are executing Subtask PROD-7: Add the ready-set filter bar.');
    expect(prompt).toContain('- Project: Motir (PROD)');
    expect(prompt).toContain('- Sizing: 5 story points · ~90 min');
    expect(prompt).toContain('- Repo: motir-core');
    expect(prompt).toContain('- Parent: PROD-2 — Ready surface');
    expect(prompt).toContain('- Depends on (already landed): PROD-3, PROD-5');
    expect(prompt).toContain('    - lib/dto/ready.ts');
    expect(prompt).toContain('Build the filter bar above the ready list.');
    expect(prompt).toContain('- The bar filters by kind and priority.');

    // The narrative body must NOT re-print the two sections that got their own.
    expect(prompt).not.toContain('## Acceptance criteria');
    expect(prompt).not.toContain('## Context refs');

    expect(workflowMode).toBe('per_item_pr');
    expect(sessionBranch).toBeNull();
    expect(prompt.endsWith('\n')).toBe(true);
  });

  it('is a PURE function — two calls for the same input are byte-identical', () => {
    const src = source();
    expect(assembleDispatchPrompt(src).prompt).toBe(assembleDispatchPrompt(source()).prompt);
    // …and the default injection set is the same as passing it explicitly.
    expect(assembleDispatchPrompt({ ...src, injections: NO_INJECTIONS }).prompt).toBe(
      assembleDispatchPrompt(src).prompt,
    );
  });

  it('states the honest fallbacks when the card names nothing', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        descriptionMd: null,
        blockerKeys: [],
        parent: null,
        targetRepo: null,
        storyPoints: null,
        estimateMinutes: null,
      }),
    );
    expect(prompt).toContain('(The card carries no description body.)');
    expect(prompt).toContain('The card names no explicit acceptance criteria.');
    expect(prompt).toContain('- Context refs: none named on the card.');
    expect(prompt).toContain('- Parent: none (top-level item)');
    expect(prompt).toContain('- Depends on: nothing');
    expect(prompt).toContain('- Repo: not pinned.');
    expect(prompt).not.toContain('- Sizing:');
  });

  it('renders one sizing fact when only one of points / estimate is set', () => {
    expect(assembleDispatchPrompt(source({ estimateMinutes: null })).prompt).toContain(
      '- Sizing: 5 story points\n',
    );
    expect(assembleDispatchPrompt(source({ storyPoints: null })).prompt).toContain(
      '- Sizing: ~90 min\n',
    );
  });
});

describe('assembleDispatchPrompt — the per-type WHAT TO DO variant', () => {
  // Every type gets its OWN steps; a marker phrase per type proves the variant
  // actually swapped rather than falling through to a shared default.
  const MARKERS: Record<WorkItemTypeDto, string> = {
    code: 'Ship the TESTS that cover the change',
    design: 'Draw the ACCESS PATH',
    test: 'Make each test fail for the right reason first',
    content: 'match the terms the app',
    research: 'A research card ships a document',
    review: 'A finding without a scenario is an opinion',
    decision: 'ships a decision, not a survey',
    deploy: 'how it is rolled back',
    manual: 'Never paste a secret into the work item.',
    chore: 'keep the diff to that change alone',
  };

  it.each(Object.entries(MARKERS))('type %s yields its own steps', (type, marker) => {
    const { prompt } = assembleDispatchPrompt(
      source({ type: type as WorkItemTypeDto, executor: 'coding_agent' }),
    );
    expect(prompt).toContain(marker);
  });

  it('every type produces a DISTINCT WHAT TO DO block', () => {
    const blocks = (Object.keys(MARKERS) as WorkItemTypeDto[]).map((type) => {
      const { prompt } = assembleDispatchPrompt(source({ type, executor: 'coding_agent' }));
      return prompt.slice(prompt.indexOf('WHAT TO DO'), prompt.indexOf('ACCEPTANCE CRITERIA'));
    });
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it('an UNTYPED item gets the generic form and says so', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: null, executor: null }));
    expect(prompt).toContain('this work item has no `type` set');
    expect(prompt).toContain('type unset · executor unset');
    // It is still an agent prompt — the git workflow is present.
    expect(prompt).toContain('\nGIT WORKFLOW\n');
  });
});

describe('assembleDispatchPrompt — the MANUAL / human form', () => {
  it.each([
    ['type manual', { type: 'manual' as const, executor: 'coding_agent' as const }],
    ['executor human', { type: 'code' as const, executor: 'human' as const }],
  ])('%s yields the human-instruction form with NO git workflow', (_label, over) => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(source(over));
    expect(prompt).toContain('This is a MANUAL work item');
    expect(prompt).toContain('Never paste a secret into the work item.');
    expect(prompt).not.toContain('\nGIT WORKFLOW\n');
    expect(prompt).not.toContain('git worktree add');
    expect(prompt).toContain('There is no git workflow for this work item');
    expect(workflowMode).toBe('per_item_pr');
    expect(sessionBranch).toBeNull();
  });

  it('a manual item on an inherited lineage still reports no branch', () => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(
      source({ type: 'manual', sessionBranch: 'session/PROD-2-run' }),
    );
    expect(sessionBranch).toBeNull();
    expect(workflowMode).toBe('per_item_pr');
    expect(prompt).not.toContain('session/PROD-2-run');
  });

  it('still carries CONTEXT and ACCEPTANCE CRITERIA', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual' }));
    expect(prompt).toContain('\nCONTEXT\n');
    expect(prompt).toContain('- The bar filters by kind and priority.');
  });
});

describe('assembleDispatchPrompt — the GIT WORKFLOW variants', () => {
  it('no session branch → the per-item-PR variant', () => {
    const { prompt, workflowMode } = assembleDispatchPrompt(source());
    expect(workflowMode).toBe('per_item_pr');
    expect(prompt).toContain('ships as ONE pull request of its own');
    expect(prompt).toContain(
      'git worktree add ../motir-core-prod-7 -b subtask/PROD-7-add-the-ready-set-filter-bar origin/main',
    );
    expect(prompt).toContain('TITLE carries');
    expect(prompt).toContain('STOP at the open pull request');
    expect(prompt).not.toContain('mark_integrated');
  });

  it('an inherited session branch → the session-lineage variant', () => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(
      source({ sessionBranch: 'session/PROD-2-run' }),
    );
    expect(workflowMode).toBe('session_lineage');
    expect(sessionBranch).toBe('session/PROD-2-run');
    expect(prompt).toContain('inherits the session branch session/PROD-2-run');
    expect(prompt).toContain('origin/session/PROD-2-run');
    expect(prompt).toContain('mark_integrated');
    expect(prompt).toContain('Do NOT open a pull request for this item.');
  });

  it('the branch PREFIX follows the diff content, not the card kind', () => {
    const branchOf = (type: WorkItemTypeDto) =>
      assembleDispatchPrompt(source({ type })).prompt.match(/-b (\S+) origin\/main/)?.[1];
    expect(branchOf('code')).toMatch(/^subtask\//);
    expect(branchOf('chore')).toMatch(/^subtask\//);
    expect(branchOf('design')).toMatch(/^design\//);
    expect(branchOf('decision')).toMatch(/^docs\//);
    expect(branchOf('research')).toMatch(/^docs\//);
  });

  it('names a generic worktree directory when the repo is unknown', () => {
    const { prompt } = assembleDispatchPrompt(source({ targetRepo: null }));
    expect(prompt).toContain('git worktree add ../<repo>-prod-7');
  });
});

describe('branchSlug', () => {
  it('lower-cases, collapses punctuation, and caps the length', () => {
    expect(branchSlug('Add the ready-set filter bar')).toBe('add-the-ready-set-filter-bar');
    expect(branchSlug('  Fix: `targetRepo` (MOTIR-1804)!  ')).toBe('fix-targetrepo-motir-1804');
    expect(branchSlug('x'.repeat(60))).toHaveLength(40);
  });

  it('never yields an empty or dangling-dash slug', () => {
    expect(branchSlug('———')).toBe('work');
    expect(branchSlug('')).toBe('work');
    // A title whose 40-char cut lands mid-separator must not end in a dash.
    expect(branchSlug(`${'a'.repeat(39)} tail`).endsWith('-')).toBe(false);
  });
});

describe('assembleDispatchPrompt — the Epic-9 injection extension point', () => {
  it('renders nothing when the slots are empty (the motir-core default)', () => {
    const withEmpty = assembleDispatchPrompt(source({ injections: NO_INJECTIONS })).prompt;
    expect(withEmpty).toBe(assembleDispatchPrompt(source()).prompt);
  });

  it('appends filled slots to CONTEXT, conventions before lessons', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        injections: { conventions: ['CONVENTION BLOCK'], lessons: ['LESSON BLOCK'] },
      }),
    );
    const context = prompt.slice(prompt.indexOf('CONTEXT'), prompt.indexOf('WHAT TO DO'));
    expect(context).toContain('CONVENTION BLOCK');
    expect(context).toContain('LESSON BLOCK');
    expect(context.indexOf('CONVENTION BLOCK')).toBeLessThan(context.indexOf('LESSON BLOCK'));
  });
});

// The PROSE-vs-GRAPH advisory block (MOTIR-2079) — items the card's ACCEPTANCE
// CRITERIA name while it carries no `blocked_by` edge to them, rendered into
// CONTEXT so EVERY harness inherits the instruction. The CLI never assembles
// prompt text, so a warning that lived only there would reach one harness; this
// is the half that reaches all of them.
describe('assembleDispatchPrompt — the prose-vs-graph advisory block (MOTIR-2079)', () => {
  const advisory = (referenced: string, referencedStatus: string) => ({
    item: 'PROD-7',
    referenced,
    referencedStatus,
    severity: 'likely-missing-edge' as const,
  });

  it('renders each reference with its status, inside CONTEXT', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ advisories: [advisory('PROD-5', 'in_review')] }),
    );
    const context = prompt.slice(prompt.indexOf('CONTEXT'), prompt.indexOf('WHAT TO DO'));
    expect(context).toContain('PROD-5 (in_review)');
    expect(context).toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('instructs the agent to VERIFY against origin/main and to STOP rather than rebuild', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ advisories: [advisory('PROD-5', 'in_review')] }),
    );
    expect(prompt).toContain('origin/main');
    expect(prompt).toContain('blocked_by');
    // The specific failure it exists to prevent, named so the agent cannot read
    // this as "go ahead and build the other half too".
    expect(prompt).toContain('Do not rebuild the other half');
  });

  it('lists EVERY advisory, not just the first', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ advisories: [advisory('PROD-5', 'in_review'), advisory('PROD-9', 'todo')] }),
    );
    expect(prompt).toContain('PROD-5 (in_review)');
    expect(prompt).toContain('PROD-9 (todo)');
  });

  it('renders NOTHING for an empty list — no heading, byte-identical to omitting it', () => {
    const empty = assembleDispatchPrompt(source({ advisories: [] })).prompt;
    expect(empty).toBe(assembleDispatchPrompt(source()).prompt);
    expect(empty).not.toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('changes NOTHING but the CONTEXT text — same workflow mode, same branch, same sections', () => {
    // The load-bearing invariant: an advisory is told, never acted on. If a
    // future change lets one steer the GIT WORKFLOW variant, it has become a
    // gate — which would falsely stop the three legitimate shapes MOTIR-1969
    // enumerates (boundary-contract cards, contrast references, will-be-done-first).
    const without = assembleDispatchPrompt(source());
    const with_ = assembleDispatchPrompt(source({ advisories: [advisory('PROD-5', 'todo')] }));
    expect(with_.workflowMode).toBe(without.workflowMode);
    expect(with_.sessionBranch).toBe(without.sessionBranch);
    for (const heading of SECTIONS) expect(with_.prompt).toContain(heading);
    // …and the sections AFTER context are untouched, character for character.
    const tail = (p: string) => p.slice(p.indexOf('WHAT TO DO'));
    expect(tail(with_.prompt)).toBe(tail(without.prompt));
  });
});

// THE OUTCOME PROTOCOL (MOTIR-2406).
//
// `motir auto` runs `claude --dangerously-skip-permissions` in a sandbox against
// the user's own key: no wrapper, no policy layer, no second channel. The prompt
// is the entire contract with the agent, so every assertion here is about text
// that either reaches it or does not exist.
describe('assembleDispatchPrompt — REPORTING THE OUTCOME', () => {
  // ⚠️ BOTH VARIANTS, asserted separately. A section added to one branch of a
  // two-branch assembler is the classic half-shipped prompt change, and it would
  // read as working right up until the first item of a run — which is exactly
  // the one with no lineage.
  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'session/PROD-2-run'],
  ])('is present in the %s variant', (mode, sessionBranch) => {
    const { prompt, workflowMode } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(workflowMode).toBe(mode);
    expect(outcomeSection(prompt)).toContain('Two outcomes end this work');
  });

  it('the FINISHED signal names in_review and says it is REQUIRED', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('status in_review');
    expect(outcome).toContain('REQUIRED, not a courtesy');
    // The reason, not just the rule: an agent told only "do this" treats it as
    // ceremony, and the loop's whole ability to tell success from a quiet death
    // rests on it.
    expect(outcome).toContain('died quietly');
  });

  it('the defect signal names Planning and NEVER offers `blocked`', () => {
    // The intuitive word for "this card cannot proceed" is `blocked`, and an
    // agent offered both will reach for it — where it would change a label and
    // nothing else, leaving the card ready and pickable (MOTIR-2425).
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('status planning');
    expect(outcome).toContain('in-progress');
    expect(outcome.toLowerCase()).not.toContain('blocked');
  });

  it('REVERT FIRST comes before every other defect step', () => {
    // Ordering is the assertion, not presence. An agent that reads "record the
    // finding" before "commit nothing" has already had four steps in which to
    // commit a half-change.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    const revert = outcome.indexOf('REVERT FIRST');
    expect(revert).toBeGreaterThan(-1);
    for (const later of ['Do not improvise', 'Comment the finding', 'Move PROD-7 to Planning']) {
      expect(outcome.indexOf(later), `${later} comes after REVERT FIRST`).toBeGreaterThan(revert);
    }
  });

  it('names the exact `motir plan` invocation, key substituted', () => {
    // Verbatim, because an agent told to "submit your findings for re-planning"
    // will invent an invocation — and the likely invention is an unanchored
    // thread, which produces a project-wide plan about one card's defect.
    const outcome = outcomeSection(assembleDispatchPrompt(source({ key: 'PROD-99' })).prompt);
    expect(outcome).toContain('motir plan --detach PROD-99 "<what you found>"');
    expect(outcome).toContain('anchors the thread to this card');
    expect(outcome).toContain('`--detach`');
  });

  it('states that a plan is PROPOSALS and the agent must not write cards', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('do not create or edit work items yourself');
    expect(outcome).toContain('PROPOSALS');
  });

  it('gives the no-retry rule its REASON, not a bare prohibition', () => {
    // A rule with no reason is a rule an agent reasons its way around — "the
    // timeout means it did not land, so retrying is safe" is exactly the
    // inference that spends the credits twice.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('Never retry it');
    expect(outcome).toContain('credits');
  });

  it('comes LAST — after the git workflow, not before it', () => {
    // Placement is emphasis: the last thing in the prompt is what the agent is
    // holding when it starts acting. With the protocol earlier, the git workflow
    // is the final word and "move the card to In Review" is the step that gets
    // forgotten.
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt.indexOf('REPORTING THE OUTCOME')).toBeGreaterThan(prompt.indexOf('GIT WORKFLOW'));
    expect(prompt.trimEnd().endsWith('Do not pick up other work.')).toBe(true);
  });

  it('a MANUAL item gets NEITHER — it has no branch, no commit and no session', () => {
    // `motir auto` skips human work, and a person is not going to call
    // `transition_status`. The manual closing note already says how to report
    // completion.
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual' }));
    expect(prompt).not.toContain('REPORTING THE OUTCOME');
    expect(prompt).not.toContain('YOUR COMMIT');
    expect(prompt).toContain('There is no git workflow for this work item');
  });
});

describe('assembleDispatchPrompt — ONE CARD, ONE COMMIT (MOTIR-2406)', () => {
  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'session/PROD-2-run'],
  ])('the commit contract rides the %s git workflow', (_mode, sessionBranch) => {
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(prompt).toContain('ONE commit for PROD-7');
  });

  it('says the message BECOMES the pull request, and what that asks of it', () => {
    // The reason the instruction is here rather than in a reviewer's
    // expectations: nobody reading the pull request opens the card, so this
    // message is the only per-card narrative that reaches them.
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('THE MESSAGE BECOMES THE PULL REQUEST');
    expect(prompt).toContain('REVIEWER WHO WAS NOT');
    expect(prompt).toContain('will not open the card');
    // Subject AND body, because a one-liner leaves the pull request with a
    // heading and no reasoning under it.
    expect(prompt).toContain('Subject: what changed');
    expect(prompt).toContain('one-liner');
  });
});
