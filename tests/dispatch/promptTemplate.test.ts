import { describe, expect, it } from 'vitest';
import {
  assembleDispatchPrompt,
  branchSlug,
  FINDINGS_POLICY_TOKENS,
  LINKING_RATIONALE,
  NO_INJECTIONS,
  parseFindingsPolicy,
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

/**
 * The outcome section UP TO the third branch (MOTIR-3020).
 *
 * The section grew a sibling — FOUND A DEFECT, which is about something other
 * than this card — and an assertion written about the two card-outcome branches
 * must keep its original subject rather than silently widen to text it was never
 * written about. Used where the claim is "the agent is offered X and not Y for
 * ITS OWN card"; the whole-section helper is still right for anything else.
 */
function cardOutcomeBranches(prompt: string): string {
  const section = outcomeSection(prompt);
  const third = section.indexOf('FOUND A DEFECT');
  return third === -1 ? section : section.slice(0, third);
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
    copy: 'never coin a synonym for a shipped term',
    translate: 'a translation card authors no new',
    research: 'A research card ships a document',
    review: 'A finding without a scenario is an opinion',
    verification: 'verification that cannot fail has verified nothing',
    decision: 'ships a decision, not a survey',
    deploy: 'how it is rolled back',
    manual: 'Never paste a secret into the work item.',
    legal: 'stop at the draft',
    chore: 'keep the diff to that change alone',
  };

  it.each(Object.entries(MARKERS))('type %s yields its own steps', (type, marker) => {
    const { prompt } = assembleDispatchPrompt(
      source({ type: type as WorkItemTypeDto, executor: 'coding_agent' }),
    );
    expect(prompt).toContain(marker);
  });

  // ── MOTIR-3059: the design step that closes the loop ──────────────────────
  //
  // The gap this pins is specific: the design result is published by CI, from a
  // step that SHARES a job with the design-asset guards and runs after them — so
  // a guard failure skips it silently. The run sees a green pull request and the
  // card stays empty, which has happened (MOTIR-2413, filed as MOTIR-2981). That
  // fix was a change to the human runbook; the agent reads THIS file.
  describe('WHAT_TO_DO.design tells the agent to confirm the publish', () => {
    const designPrompt = (): string =>
      assembleDispatchPrompt(source({ type: 'design', executor: 'coding_agent' })).prompt;

    it('names the CHECK before the action — not "publish it", but "confirm it arrived"', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('CONFIRM the design result reached the work item');
      // The log line is what makes the check performable rather than vague.
      expect(prompt).toContain('Published N design artifact(s)');
      // …and WHY it can be absent, so the agent knows this is a real case and
      // not a formality.
      expect(prompt).toContain('SKIPPED when the guards fail');
    });

    it('names the SHIPPED publisher, never the general attach tool', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('design-evidence');
      // ⚠️ The general door would put the .png in the ATTACHMENTS panel while CI
      // puts it in the Design result panel — one artifact, two surfaces. The
      // which-door rule is docs/decisions/attachment-api-door.md §3, and this is
      // where an agent would otherwise pick the wrong one.
      expect(prompt).not.toContain('attach_file');
    });

    it('keeps the repository the source of truth', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('REPOSITORY stays the source of truth');
      expect(prompt).toContain('never a replacement for committing the three files');
    });

    it('"Stop at the asset" SURVIVES as the stopping condition', () => {
      // The new step must not read as permission to continue building. If step 5
      // ever disappears, the agent gains a publish instruction and loses the
      // gate that made the design reviewable first.
      const prompt = designPrompt();
      expect(prompt).toContain('Stop at the asset. A design is reviewed before anything is built');
      expect(prompt.indexOf('Stop at the asset')).toBeLessThan(
        prompt.indexOf('CONFIRM the design result'),
      );
    });

    it('carries the step in BOTH workflow variants', () => {
      // A step added to one dispatch path only is the classic half-shipped
      // prompt change: it works when you test it and is missing where it runs.
      for (const sessionBranch of [null, 'session/MOTIR-1-lineage']) {
        const { prompt } = assembleDispatchPrompt(
          source({ type: 'design', executor: 'coding_agent', sessionBranch }),
        );
        expect(prompt).toContain('CONFIRM the design result reached the work item');
      }
    });

    it('changes NO other type’s steps', () => {
      // Asserted as a set difference rather than by eye: a broad edit to the
      // WHAT_TO_DO record would otherwise pass every marker test above.
      for (const type of Object.keys(MARKERS) as WorkItemTypeDto[]) {
        if (type === 'design') continue;
        const { prompt } = assembleDispatchPrompt(source({ type, executor: 'coding_agent' }));
        expect(prompt).not.toContain('CONFIRM the design result');
      }
    });
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
    // MOTIR-3529 — UPDATED, not removed. This used to assert `TITLE carries`,
    // and the stakes it stood for are unchanged; what changed is the mechanism.
    // The title survives as a LABEL and the LINK is what carries the merge back.
    expect(prompt).toContain(`${'PROD-7'} in the TITLE as well`);
    expect(prompt).toContain('the title is a LABEL, not what links the pull');
    expect(prompt).toContain('LINK it: call the link_pull_request tool');
    expect(prompt).toContain('STOP at the open pull request');
    expect(prompt).not.toContain('mark_integrated');
  });

  it('the per-item-PR variant names everything the link call needs, so no step is a lookup', () => {
    // MOTIR-3529 criterion 2. An agent that has to go and FIND an argument is an
    // agent that skips the step, which is the failure the whole story is about.
    const { prompt } = assembleDispatchPrompt(source());
    const step = prompt.split('\n').find((l) => l.includes('link_pull_request'));
    expect(step, 'the link step is missing from the per-item-PR grammar').toBeDefined();
    expect(step).toContain('PROD-7');
    // MOTIR-3678 — the step's wording is now the SHARED one, so this asserts the
    // property the older text was standing in for: every argument is in hand.
    expect(prompt).toContain('pull request (its URL, or repository + number), plus headRef');
    expect(prompt).toContain('headRef subtask/PROD-7-add-the-ready-set-filter-bar');
    expect(prompt).toContain('baseRef main');
    // And it is IMMEDIATELY after the pull request, not left to the end.
    expect(prompt.indexOf('open a pull request against main')).toBeLessThan(
      prompt.indexOf('LINK it: call the link_pull_request tool'),
    );
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
    // MOTIR-3678 — the agent no longer opens one OF ITS OWN, and is told what to
    // do about the one the run has usually already opened.
    expect(prompt).toContain('Do NOT open a pull request of your own.');
    expect(prompt).toContain('If it does not exist yet, you are the');
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
// ── THE LINKING SENTENCE (Story MOTIR-3672 · MOTIR-3678) ─────────────────────
//
// One text, every grammar. The point of the card is that an agent never has to
// work out which lane it is in before it can follow the instruction, and the
// only way that stays true is a test that fails when the two drift.
describe('assembleDispatchPrompt — the linking sentence is ONE text', () => {
  const RATIONALE = LINKING_RATIONALE.join('\n');

  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'motir/auto-20260827-120000'],
  ])('renders it BYTE-IDENTICALLY in the %s grammar', (mode, sessionBranch) => {
    const { prompt, workflowMode } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(workflowMode).toBe(mode);
    // Indentation is the only thing a grammar may vary, so the comparison is on
    // the de-indented text — which is what makes this an assertion about the
    // WORDS rather than about the list they sit in.
    const flat = prompt
      .split('\n')
      .map((l) => l.trim())
      .join('\n');
    expect(flat).toContain(
      RATIONALE.split('\n')
        .map((l) => l.trim())
        .join('\n'),
    );
  });

  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'motir/auto-20260827-120000'],
  ])('tells the %s grammar to CALL link_pull_request with the card key', (mode, sessionBranch) => {
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(prompt).toContain('call the link_pull_request tool with key PROD-7');
  });

  it('says the title is a LABEL with no fallback, and NAMES the failing check', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('There is no fallback');
    expect(prompt).toContain('Motir / work item link');
    expect(prompt).toContain('it goes green on the link itself');
  });

  // ⚠️ The contradiction this card was filed on: `outcomeProtocol` renders for
  // BOTH grammars and used to say "open the pull request" to an agent whose git
  // workflow said not to.
  it('never tells a SESSION-LINEAGE agent to open a pull request of its own', () => {
    const branch = 'motir/auto-20260827-120000';
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch: branch }));
    expect(prompt).not.toContain('    3. open the pull request');
    expect(prompt).toContain('find the session pull request for this repository');
    expect(prompt).toContain(`gh pr list --head ${branch}`);
  });

  it('still tells a PER-ITEM agent to open one', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('    3. open the pull request');
  });
});

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

  // THE MODEL SELF-REPORT (MOTIR-2419) — the one fact only the agent holds.
  // It rides in this section because it applies to BOTH outcomes: a card that
  // turned out to be wrong was still worked by a model.
  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'session/PROD-2-run'],
  ])('asks for the model in the %s variant', (mode, sessionBranch) => {
    // Same half-shipped hazard as the protocol around it: a line added to one
    // branch of the assembler leaves every first-item-of-a-run with no model.
    const { prompt, workflowMode } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(workflowMode).toBe(mode);
    const outcome = outcomeSection(prompt);
    expect(outcome).toContain('MOTIR_AGENT_REPORT');
    expect(outcome).toContain('{"model": "<the model you are running as>"}');
  });

  it('tells the agent to write NOTHING rather than guess', () => {
    // The version of the provenance bug that would survive the fix: a model the
    // agent inferred looks exactly like one it observed.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('write no file at all');
    expect(outcome).toContain('and a guessed one is not');
    // …and the REASON it is the only chance, so the instruction is not read as
    // ceremony to skip when busy.
    expect(outcome).toContain('Nothing outside your process can observe which model answered');
  });

  it('is conditional on the variable, so a --print reader is not told to invent a path', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('If the variable is unset, skip this entirely');
  });

  it('comes BEFORE the two outcomes, because it applies to both', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    const report = outcome.indexOf('MOTIR_AGENT_REPORT');
    expect(report).toBeGreaterThan(-1);
    for (const later of ['FINISHED —', 'THE CARD IS WRONG']) {
      expect(outcome.indexOf(later), `${later} comes after the self-report`).toBeGreaterThan(
        report,
      );
    }
  });

  it('the FINISHED signal names implemented and says it is REQUIRED', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('status implemented');
    expect(outcome).toContain('REQUIRED, not a courtesy');
    // The reason, not just the rule: an agent told only "do this" treats it as
    // ceremony, and the loop's whole ability to tell success from a quiet death
    // rests on it.
    expect(outcome).toContain('died quietly');
  });

  it('states the ORDER — commit, push, open the PR, THEN transition (MOTIR-3004)', () => {
    // Asserted as an ORDER on the assembled string, not as four strings that
    // happen to be present: an agent handed an unordered list does the cheap
    // status call first, and then the card claims built work that exists only in
    // a worktree the run is about to delete.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    const at = (needle: string) => outcome.indexOf(needle);
    expect(at('1. commit')).toBeGreaterThan(-1);
    expect(at('2. push the branch')).toBeGreaterThan(at('1. commit'));
    expect(at('3. open the pull request')).toBeGreaterThan(at('2. push the branch'));
    expect(at('status implemented')).toBeGreaterThan(at('3. open the pull request'));
    // …and it says WHAT the status claims, which is the whole reason for the order.
    expect(outcome).toContain('THE CODE IS ON THE REMOTE');
  });

  it('tells the agent that In Review belongs to CI, not to it (MOTIR-3004)', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('Do NOT set In Review');
    expect(outcome).toContain('CI does');
  });

  it("no assembled text still claims the agent's pull request causes In Review", () => {
    // The GIT WORKFLOW step used to say the title reference "is what moves this
    // work item to In Review". After this story that half is false, and a prompt
    // that says both things teaches the agent the wrong owner of the status.
    const prompt = assembleDispatchPrompt(source()).prompt;
    expect(prompt).not.toContain('moves this work item to In Review');
  });

  it('the defect signal names Planning and NEVER offers `blocked`', () => {
    // The intuitive word for "this card cannot proceed" is `blocked`, and an
    // agent offered both will reach for it — where it would change a label and
    // nothing else, leaving the card ready and pickable (MOTIR-2425).
    // Scoped to the CARD-OUTCOME branches: the claim is about which STATUS the
    // agent is offered for its own card, and the FOUND A DEFECT branch that now
    // follows names the `blocked_by` EDGE — a different word in a different role,
    // and the one thing a filed bug must not create.
    const outcome = cardOutcomeBranches(assembleDispatchPrompt(source()).prompt);
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

  it('bans RESTRUCTURING the plan, and no longer bans creation at all', () => {
    // ⚠️ THIS REPLACES an assertion that pinned the opposite (MOTIR-3020). The
    // old text forbade creating any work item, justified as *"A plan is
    // PROPOSALS awaiting a human's approval; writing the cards would be doing
    // the approving"* — a sentence that misdescribes the mechanism, since
    // `create_work_item` is a direct write entering no proposal pipeline. The
    // half that was load-bearing survives and is what is asserted here; the
    // justification must be gone from the WHOLE prompt, not merely reworded.
    const { prompt } = assembleDispatchPrompt(source());
    const outcome = outcomeSection(prompt);
    expect(outcome).toContain('Do NOT RESTRUCTURE THE PLAN');
    for (const forbidden of ['no archiving', 're-parenting', 're-scoping']) {
      expect(outcome).toContain(forbidden);
    }
    expect(prompt).not.toContain('PROPOSALS');
    expect(prompt).not.toContain('do not create or edit work items yourself');
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
    // The section's own last line, which MOTIR-3020 moved: the third branch now
    // closes it, and its final instruction is the one that matters most about a
    // side-finding — that it is not an ending.
    expect(prompt.trimEnd().endsWith('report its own outcome as above.')).toBe(true);
  });

  it('a MANUAL item gets NEITHER — it has no branch, no commit and no session', () => {
    // `motir auto` skips human work, and a person is not going to call
    // `transition_status`. The manual closing note already says how to report
    // completion.
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual' }));
    expect(prompt).not.toContain('REPORTING THE OUTCOME');
    expect(prompt).not.toContain('YOUR COMMIT');
    // Nor the model self-report: no agent runs, so there is no model to name
    // and nothing writes the file the loop would read (MOTIR-2419).
    expect(prompt).not.toContain('MOTIR_AGENT_REPORT');
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

// ─────────────────────────────────────────────────────────────────────────────
// The MULTI-REPOSITORY grammar (Story MOTIR-2731 · MOTIR-3132)
// ─────────────────────────────────────────────────────────────────────────────
//
// The instruction this replaces was not vague — it was COMPLETE, and wrong for
// one shape of card. `perItemPrWorkflow` names a worktree, a branch, a commit
// convention and a stopping point, so an agent handed a two-repository card
// follows it exactly, opens one pull request and exits 0. The card then sits at
// In Review forever, held by a completion gate waiting on a repository nothing
// ever told anyone to open a pull request against, and the run that caused it
// looks green.
//
// So the property under test is a pair:
//
//   * fewer than two repositories renders EXACTLY today's text — asserted
//     against the source with and without the field, byte for byte, because
//     "every existing card is unaffected" is the whole back-compatibility claim
//     and it is cheap to prove rather than intend;
//   * two or more renders one worktree, one branch and one pull request PER
//     repository, sharing ONE branch name, every pull-request title carrying the
//     key, and a closing line that says the item completes only when all of them
//     have merged.

/** Two repositories, primary first, with different default branches — so a
 *  block that branched from a hardcoded `main` is visible. */
const TWO_REPOS = [
  { name: 'motir-core', defaultBranch: 'main' },
  { name: 'motir-ai', defaultBranch: 'trunk' },
];

describe('the repository COUNT axis — fewer than two changes nothing', () => {
  it('renders byte-identically with no field, an empty set, and a one-element set', () => {
    const base = assembleDispatchPrompt(source()).prompt;
    expect(assembleDispatchPrompt(source({ targetRepos: [] })).prompt).toBe(base);
    expect(
      assembleDispatchPrompt(
        source({ targetRepos: [{ name: 'motir-core', defaultBranch: 'main' }] }),
      ).prompt,
    ).toBe(base);
  });

  it('renders byte-identically for an UNPINNED card and for a SESSION-LINEAGE card', () => {
    const unpinned = source({ targetRepo: null });
    expect(assembleDispatchPrompt({ ...unpinned, targetRepos: [] }).prompt).toBe(
      assembleDispatchPrompt(unpinned).prompt,
    );
    const lineage = source({ sessionBranch: 'motir/auto-1' });
    expect(
      assembleDispatchPrompt({
        ...lineage,
        targetRepos: [{ name: 'motir-core', defaultBranch: 'main' }],
      }).prompt,
    ).toBe(assembleDispatchPrompt(lineage).prompt);
  });

  it('renders NO GIT WORKFLOW at all for a manual item, however many repositories it names', () => {
    // A manual item has no branch and no pull request; instructing N of them
    // would be a lie the CLI could act on, and the repository count does not
    // make it less of one.
    const manual = assembleDispatchPrompt(
      source({ type: 'manual', executor: 'human', targetRepos: TWO_REPOS }),
    );
    expect(manual.prompt).not.toContain('GIT WORKFLOW');
    expect(manual.prompt).not.toContain('git worktree add');
    expect(manual.workflowMode).toBe('per_item_pr');
    expect(manual.sessionBranch).toBeNull();
  });
});

describe('the MULTI-REPOSITORY per-item-PR workflow', () => {
  const built = () => assembleDispatchPrompt(source({ targetRepos: TWO_REPOS })).prompt;

  it('renders one worktree, one branch and one pull request PER repository, in set order', () => {
    const prompt = built();
    expect(prompt.match(/git worktree add/g)).toHaveLength(2);
    expect(prompt).toContain('git worktree add ../motir-core-prod-7 -b');
    expect(prompt).toContain('git worktree add ../motir-ai-prod-7 -b');
    // Each block ENTERS its own repository first, so every worktree path is the
    // same `../<repo>-<key>` the single-repository grammar renders.
    expect(prompt).toContain('1. cd . && git fetch origin');
    expect(prompt).toContain('1. cd ../motir-ai && git fetch origin');
    // Set order, primary first — the primary is the one the agent stands in.
    expect(prompt.indexOf('motir-core  (your working directory)')).toBeLessThan(
      prompt.indexOf('motir-ai  (a sibling checkout)'),
    );
  });

  it('branches each repository from ITS OWN default branch, never a hardcoded main', () => {
    const prompt = built();
    expect(prompt).toContain('-b subtask/PROD-7-add-the-ready-set-filter-bar origin/main');
    expect(prompt).toContain('-b subtask/PROD-7-add-the-ready-set-filter-bar origin/trunk');
    expect(prompt).toContain('open a pull request against trunk.');
  });

  it('falls back to `origin/main` for a repository whose default branch Motir does not know', () => {
    // `null`, never a guessed branch — the same rule the payload's coordinates
    // follow. `main` is the fallback the single-repository grammar has always
    // hardcoded, so an unknown default branch renders the text that already
    // shipped rather than a second unknown.
    const prompt = assembleDispatchPrompt(
      source({
        targetRepos: [
          { name: 'motir-core', defaultBranch: null },
          { name: 'motir-ai', defaultBranch: null },
        ],
      }),
    ).prompt;
    expect(prompt.match(/origin\/main/g)).toHaveLength(2);
    expect(prompt).toContain('open a pull request against main.');
  });

  it('uses the SAME branch name in every repository', () => {
    const branch = `subtask/PROD-7-${branchSlug('Add the ready-set filter bar')}`;
    const names = [...built().matchAll(/-b (\S+) origin\//g)].map((m) => m[1]);
    expect(names).toEqual([branch, branch]);
  });

  it('LINKS every pull request — once per repository, the reference the completion gate reads', () => {
    // MOTIR-3529 — UPDATED, not removed. This used to count `TITLE carries`
    // lines. The stakes are unchanged and still the reason it exists: the gate
    // counts merges against the item's LINKED pull requests, so a pull request
    // the gate cannot see holds the card open on work that has shipped. What
    // changed is that the link is now DECLARED rather than parsed out of a
    // string — and it is per REPOSITORY, because each has its own pull request.
    //
    // Counted on the GIT-WORKFLOW step specifically. The outcome protocol names
    // the tool a third time, in its finish order — deliberately, and asserted
    // separately below rather than folded into this count, since one is
    // per-repository and the other is per-item.
    const linkSteps = built()
      .split('\n')
      .filter((l) => l.includes('LINK it: call the link_pull_request tool'));
    expect(linkSteps).toHaveLength(2);
    for (const step of linkSteps) expect(step).toContain('PROD-7');
    expect(built()).toContain('ONCE PER REPOSITORY');
  });

  it('the outcome protocol’s finish ORDER carries the link too — between the PR and Implemented', () => {
    // The third carrier, and the one that would otherwise contradict the two
    // above: an agent following this list literally would go commit → push →
    // open → transition and never link.
    const prompt = built();
    const order = prompt.slice(prompt.indexOf('IN THIS ORDER'));
    expect(order.indexOf('3. open the pull request')).toBeLessThan(
      order.indexOf('4. link it with the link_pull_request tool'),
    );
    expect(order.indexOf('4. link it with the link_pull_request tool')).toBeLessThan(
      order.indexOf('5. move PROD-7 to Implemented'),
    );
    expect(order).toContain('once per repository if this item');
  });

  it('keeps the key in every TITLE, re-framed as a LABEL rather than the mechanism', () => {
    // The label half of the same change: dropping it would cost a human reading
    // a pull-request list, which is a real reader with no other affordance.
    const titleSteps = built()
      .split('\n')
      .filter((l) => l.includes('in the TITLE as well'));
    expect(titleSteps).toHaveLength(2);
    for (const step of titleSteps) expect(step).toContain('PROD-7');
    expect(built()).toContain('it is not what links the pull request');
  });

  it('says the item completes only when EVERY pull request has merged, and never instructs a merge', () => {
    const prompt = built();
    expect(prompt).toContain('STOP at the 2 open pull requests.');
    expect(prompt).toContain('EVERY one of them has merged');
    expect(prompt).not.toContain('squash-merge');
    expect(prompt).not.toContain('git branch -d');
  });

  it('names every repository in CONTEXT, marks the working directory, and asserts no absolute path', () => {
    const prompt = built();
    expect(prompt).toContain('- Repositories (2) — this item ships in EVERY one of them:');
    expect(prompt).toContain('- motir-core — the PRIMARY, and your working directory.');
    expect(prompt).toContain('- motir-ai — expected as a sibling of it, at ../motir-ai.');
    // The server cannot know where a person keeps their checkouts; the run does.
    expect(prompt).not.toMatch(/^\s*-\s+\/[A-Za-z]/m);
    // The single-repository line is GONE for this card, not printed beside it.
    expect(prompt).not.toContain('- Repo: motir-core');
  });

  it('carries NO delivery state — the prompt instructs, the run informs', () => {
    // Delivery is the one fact that DIFFERS between two dispatches of an
    // unchanged card, and the prompt is a pure function of server state. Putting
    // it here would make a resumed run read as a different card (MOTIR-3136 owns
    // telling the person).
    // Scoped to the CONTEXT block that names the repositories: the word
    // "awaiting" legitimately appears in the outcome protocol, about a PLAN
    // awaiting approval, which is a different fact entirely.
    const repoBlock = built()
      .split('\n')
      .filter((l) => l.includes('motir-core') || l.includes('motir-ai'))
      .join('\n');
    for (const state of ['delivered', 'awaiting', 'unestablished', 'excluded']) {
      expect(repoBlock).not.toContain(state);
    }
  });
});

describe('the MULTI-REPOSITORY session-lineage workflow', () => {
  const built = () =>
    assembleDispatchPrompt(source({ targetRepos: TWO_REPOS, sessionBranch: 'motir/auto-1' }));

  it('instructs the same session branch in every repository and exactly ONE mark_integrated', () => {
    const { prompt, workflowMode, sessionBranch } = built();
    expect(workflowMode).toBe('session_lineage');
    expect(sessionBranch).toBe('motir/auto-1');
    expect(prompt.match(/origin\/motir\/auto-1/g)).toHaveLength(2);
    expect(prompt.match(/Integrate the commit into motir\/auto-1/g)).toHaveLength(2);
    // ONE call for the item, not one per repository: `work_item.sessionBranch`
    // is a scalar, which is the same reason the branch name is shared.
    expect(prompt.match(/mark_integrated/g)).toHaveLength(1);
  });

  it('opens no pull request in any repository', () => {
    expect(built().prompt).toContain('Do NOT open a pull request OF YOUR OWN in any repository.');
    expect(built().prompt).not.toContain('TITLE carries');
  });
});

// ── the FOUND A DEFECT branch and the per-run findings policy (MOTIR-3020) ───
//
// `docs/decisions/run-findings-protocol.md` Q1 (the policy's shape) and Q3 (the
// bug's parent) are what this asserts against.

/** The third branch's text alone — an assertion about it must not be satisfiable
 *  by the two card-outcome branches above it. */
function defectBranch(prompt: string): string {
  const at = prompt.indexOf('FOUND A DEFECT');
  expect(at, 'the prompt carries a FOUND A DEFECT branch').toBeGreaterThan(-1);
  return prompt.slice(at);
}

const VARIANTS: { name: string; over: Partial<DispatchPromptSource> }[] = [
  { name: 'per_item_pr', over: { sessionBranch: null } },
  { name: 'session_lineage', over: { sessionBranch: 'motir/auto-20260819' } },
];

describe('assembleDispatchPrompt — FOUND A DEFECT', () => {
  it('instructs: reproduce first, file a bug with the evidence, then carry on', () => {
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('REPRODUCE IT FIRST');
    expect(branch).toContain('create_work_item');
    expect(branch).toContain("kind:      'bug'");
    expect(branch).toContain('THE REPRODUCTION');
    expect(branch).toContain('THE EVIDENCE');
    expect(branch).toContain('Carry on with your card');
  });

  it('says explicitly that filing does NOT end the run or change its own outcome', () => {
    // The one thing an agent gets wrong unprompted: it has just found something
    // broken, and treats that as a reason to stop.
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('This is NOT');
    expect(branch).toContain('an ending');
    expect(branch).toContain('does not finish your card');
    expect(branch).toContain('does not fail it');
  });

  it('names the parent as a KEY, leaving nothing for the agent to choose', () => {
    // ADR Q3: the in-flight card's PARENT, which is already on the dispatch
    // payload — so the text states the key rather than a rule to apply.
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('parentKey: PROD-2');
    expect(branch).toContain('not a choice');
    expect(branch).toContain('do not invent one');
  });

  it('falls back to the card ITSELF when it has no parent — never the project root', () => {
    const branch = defectBranch(assembleDispatchPrompt(source({ parent: null })).prompt);
    expect(branch).toContain('parentKey: PROD-7');
    expect(branch).toContain('which has no parent of its own');
  });

  it('requires the relates_to trace and forbids the bug blocking anything', () => {
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('relates_to');
    expect(branch).toContain('BLOCKS NOTHING');
    expect(branch).toContain('No blocked_by edge, no sprint, no estimate');
  });

  it('the WHAT TO DO step and the outcome protocol agree, read out of ONE prompt', () => {
    // ⚠️ The drift this closes: `WHAT_TO_DO.code` step 5 told the agent to "log
    // anything else you find as a separate work item" while the outcome protocol
    // two sections later forbade creating any work item — both in every shipped
    // `code` prompt. Asserted from a SINGLE assembled string so the two texts
    // cannot disagree again without failing here.
    const { prompt } = assembleDispatchPrompt(source({ type: 'code' }));
    const step = prompt.slice(prompt.indexOf('WHAT TO DO'), prompt.indexOf('ACCEPTANCE CRITERIA'));
    expect(step).toContain('FOUND A DEFECT');
    // The exact instruction that contradicted the protocol is gone — and it is
    // the PHRASE that has to go, not the word: the step still says "auto-loaded"
    // two lines up, and an assertion on `log` alone would fail on that.
    expect(step).not.toContain('log anything else you find as a separate work item');
    expect(step).toContain('whether this run may file it');
    // And what it points at actually exists in the same prompt.
    expect(prompt).toContain('FOUND A DEFECT — your card is fine');
  });
});

describe('assembleDispatchPrompt — the per-run findings policy', () => {
  it('renders the FULL protocol when no policy is supplied', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('FOUND A DEFECT');
    expect(prompt).toContain('motir plan --detach PROD-7');
  });

  it('renders the FULL protocol for an explicitly-permissive policy, identically', () => {
    // The default is a VALUE, not a separate code path: an omitted policy and an
    // all-true one must produce the same bytes, or "omitted means full" is a
    // second implementation of the same claim.
    const omitted = assembleDispatchPrompt(source()).prompt;
    const explicit = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: true } }),
    ).prompt;
    expect(explicit).toBe(omitted);
  });

  describe.each(VARIANTS)('on $name', ({ over }) => {
    it('with bug filing DISABLED renders no branch at all, and says comment instead', () => {
      const { prompt } = assembleDispatchPrompt(
        source({ ...over, findingsPolicy: { logBug: false, replan: true } }),
      );
      // Empty in, nothing out: no instructions, no `create_work_item`, no trace.
      expect(prompt).not.toContain('create_work_item');
      expect(prompt).not.toContain('REPRODUCE IT FIRST');
      expect(prompt).not.toContain('BLOCKS NOTHING');
      // But the finding still reaches a human — a disabled policy was never
      // asking the agent to forget what it saw.
      expect(prompt).toContain('without bug filing');
      expect(prompt).toContain('Comment the finding on PROD-7 instead');
      // The other switch is untouched.
      expect(prompt).toContain('motir plan --detach PROD-7');
    });

    it('with re-planning DISABLED renders no submit step, and leaves the card in progress', () => {
      const { prompt } = assembleDispatchPrompt(
        source({ ...over, findingsPolicy: { logBug: true, replan: false } }),
      );
      expect(prompt).not.toContain('motir plan --detach');
      expect(prompt).not.toContain('status planning');
      expect(prompt).toContain('leave the card In Progress');
      expect(prompt).toContain('without re-planning');
      // The other switch is untouched.
      expect(prompt).toContain('create_work_item');
    });

    it('with BOTH disabled keeps the FINISHED branch whole', () => {
      const { prompt } = assembleDispatchPrompt(
        source({ ...over, findingsPolicy: { logBug: false, replan: false } }),
      );
      expect(prompt).toContain('FINISHED — the work is done');
      expect(prompt).toContain('status implemented');
      expect(prompt).not.toContain('create_work_item');
      expect(prompt).not.toContain('motir plan --detach');
    });
  });

  it('DETERMINISM holds per policy — and two policies differ, so the switch is not inert', () => {
    // ⚠️ BOTH HALVES. The module's contract (MOTIR-881) is byte-identical output
    // for an unchanged input; the policy is now part of that input. Asserting
    // only the first half would pass just as well against a switch that renders
    // the same text whatever it is handed, and every disabled-branch assertion
    // above would then be vacuous.
    const full = source({ findingsPolicy: { logBug: true, replan: true } });
    const none = source({ findingsPolicy: { logBug: false, replan: false } });
    expect(assembleDispatchPrompt(full).prompt).toBe(assembleDispatchPrompt(full).prompt);
    expect(assembleDispatchPrompt(none).prompt).toBe(assembleDispatchPrompt(none).prompt);
    expect(assembleDispatchPrompt(full).prompt).not.toBe(assembleDispatchPrompt(none).prompt);
  });
});

describe('parseFindingsPolicy — the shared wire vocabulary', () => {
  it.each([undefined, null, '', '   '])('%o means the full protocol', (raw) => {
    expect(parseFindingsPolicy(raw)).toEqual({
      policy: { logBug: true, replan: true },
      unknown: null,
    });
  });

  it.each([
    ['log-bug', { logBug: false, replan: true }],
    ['replan', { logBug: true, replan: false }],
    ['log-bug,replan', { logBug: false, replan: false }],
    [' replan , log-bug ', { logBug: false, replan: false }],
    ['log-bug,,replan', { logBug: false, replan: false }],
  ])('%s disables what it names', (raw, expected) => {
    expect(parseFindingsPolicy(raw)).toEqual({ policy: expected, unknown: null });
  });

  it('REFUSES an unrecognised capability rather than ignoring it', () => {
    // The lie this parameter exists to remove: an operator who typed the CLI
    // flag's spelling on the wire must not be handed the full protocol while
    // believing they narrowed it.
    expect(parseFindingsPolicy('no-log-bug')).toEqual({ policy: null, unknown: 'no-log-bug' });
    expect(parseFindingsPolicy('log-bug,nonsense')).toEqual({ policy: null, unknown: 'nonsense' });
  });

  it('names both capabilities in the vocabulary it publishes', () => {
    expect([...FINDINGS_POLICY_TOKENS]).toEqual(['log-bug', 'replan']);
  });
});
