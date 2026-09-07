import { describe, expect, it } from 'vitest';
import {
  assembleDispatchPrompt,
  branchSlug,
  FINDINGS_POLICY_TOKENS,
  FULL_FINDINGS_POLICY,
  LINKING_RATIONALE,
  NO_INJECTIONS,
  parseFindingsPolicy,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import {
  AI_REQUIREMENT_FIELDS,
  AI_REQUIREMENT_REQUIRED_NON_EMPTY,
} from '../fixtures/settledRequirement';

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

  // ── MOTIR-3059, REWRITTEN BY MOTIR-3783: the design step that closes the loop
  //
  // MOTIR-3059 pinned a CONFIRMATION: the result was published by CI from a step
  // sharing a job with the design-asset guards, so a guard failure skipped it
  // silently and the agent's job was to notice (MOTIR-2413 / MOTIR-2981).
  //
  // ⚠️ THAT WHOLE FRAME IS GONE. MOTIR-3780 moved the publish from a CI script to
  // the `publish_design_result` tool, because a script has to BE PRESENT in the
  // repository the design lands in and that was true of exactly one of the four.
  // So the agent no longer confirms somebody else's publish — it MAKES the
  // publish, and the step is written in `linkingStep`'s register: a named tool
  // with named arguments, no conditional, no route names, no job log.
  //
  // The failure MODE the old step existed for is unchanged and is why the
  // absence assertions below matter: a design card whose result never arrives
  // still looks exactly like one that succeeded.
  describe('WHAT_TO_DO.design tells the agent to PUBLISH the result', () => {
    const designPrompt = (): string =>
      assembleDispatchPrompt(source({ type: 'design', executor: 'coding_agent' })).prompt;

    it('names the TOOL and its arguments — the register `linkingStep` set', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('publish_design_result');
      // Named arguments, not a description of a payload: this is the exact
      // asymmetry MOTIR-3783 was filed about. The old step named three HTTP
      // routes in prose and supplied no base URL, no credential and no request
      // shape, so its "publish it yourself" fallback was uncallable.
      for (const arg of ['mock', 'image', 'note_file', 'noteMd']) {
        expect(prompt, `the design step omits the \`${arg}\` argument`).toContain(arg);
      }
    });

    it('the publish is the STEP, not a fallback behind a conditional', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('PUBLISH the design result');
      // The old wording made the agent's own publish an exception reached by
      // failing to find a log — which, in a repository with no lane, was the
      // only path, arrived at by looking for something that was never coming.
      expect(prompt).not.toContain('If it is not there');
      expect(prompt).not.toContain('CONFIRM the design result reached the work item');
    });

    it('⚠️ ABSENCE: no retired CI string can creep back in a later edit', () => {
      // A guard on absence, not only on presence (MOTIR-3783 AC 5). Every string
      // here names a mechanism that will not exist once the retirement story
      // lands, and each would send an agent to look for something that is gone.
      const prompt = designPrompt();
      for (const retired of [
        'design-asset guards',
        'Published N design artifact(s)',
        'SKIPPED when the guards fail',
        'upload-token',
        'design-evidence',
        'job log',
      ]) {
        expect(prompt, `the design step still names the retired \`${retired}\``).not.toContain(
          retired,
        );
      }
    });

    it('still never routes a design asset through the general attach door', () => {
      // ⚠️ Unchanged in force, and now with a second reason. The general door
      // would put the .png in the ATTACHMENTS panel while this publishes to the
      // Design result panel — one artifact, two surfaces
      // (docs/decisions/attachment-api-door.md §3) — and `attach_file` refuses
      // `text/html` outright, so the mock could not travel that way at all.
      expect(designPrompt()).not.toContain('attach_file');
    });

    it('says WHICH note sections to send, and why not the whole file', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('SECTIONS');
      expect(prompt).toContain('never the whole note');
    });

    it('keeps the silent-failure warning, RETARGETED at the un-made call', () => {
      // The most valuable sentence the old step carried, and the one most likely
      // to be swept out as CI-era residue: the risk did not disappear with CI,
      // it MOVED. An agent that simply forgets produces the identical symptom.
      const prompt = designPrompt();
      expect(prompt).toContain('looks exactly like one that succeeded');
      expect(prompt).toContain('card empty');
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
        prompt.indexOf('PUBLISH the design result'),
      );
    });

    it('carries the step in BOTH workflow variants', () => {
      // A step added to one dispatch path only is the classic half-shipped
      // prompt change: it works when you test it and is missing where it runs.
      for (const sessionBranch of [null, 'session/MOTIR-1-lineage']) {
        const { prompt } = assembleDispatchPrompt(
          source({ type: 'design', executor: 'coding_agent', sessionBranch }),
        );
        expect(prompt).toContain('PUBLISH the design result');
      }
    });

    it('changes NO other type’s steps', () => {
      // Asserted as a set difference rather than by eye: a broad edit to the
      // WHAT_TO_DO record would otherwise pass every marker test above.
      for (const type of Object.keys(MARKERS) as WorkItemTypeDto[]) {
        if (type === 'design') continue;
        const { prompt } = assembleDispatchPrompt(source({ type, executor: 'coding_agent' }));
        expect(prompt).not.toContain('PUBLISH the design result');
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

  it('names the exact submit, key substituted — the TOOL, anchored at this card', () => {
    // Verbatim, because an agent told to "submit your findings for re-planning"
    // will invent an invocation — and the likely invention is an unanchored
    // thread, which produces a project-wide plan about one card's defect.
    // ⚠️ THE INVOCATION CHANGED (MOTIR-4083): the door is `submit_plan_session`
    // with `targetKeys: [<KEY>]`, not `motir plan --detach <KEY>`. The full
    // contract of the two tool steps is the MOTIR-4083 block below; this keeps
    // the original claim — the anchor is spelled out, with the key in it.
    const outcome = outcomeSection(assembleDispatchPrompt(source({ key: 'PROD-99' })).prompt);
    expect(outcome).toContain('submit_plan_session tool');
    expect(outcome).toMatch(/targetKeys:\s+\[PROD-99\]/);
    expect(outcome).toContain('anchors the thread to this card');
    expect(outcome).not.toContain('motir plan');
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
    expect(prompt).toMatch(/submit_plan_session[\s\S]*targetKeys:\s+\[PROD-7\]/);
  });

  it('renders the FULL protocol for an explicitly-permissive policy, identically', () => {
    // The default is a VALUE, not a separate code path: an omitted policy and an
    // all-true one must produce the same bytes, or "omitted means full" is a
    // second implementation of the same claim.
    const omitted = assembleDispatchPrompt(source()).prompt;
    const explicit = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false } }),
    ).prompt;
    expect(explicit).toBe(omitted);
  });

  describe.each(VARIANTS)('on $name', ({ over }) => {
    it('with bug filing DISABLED renders no branch at all, and says comment instead', () => {
      const { prompt } = assembleDispatchPrompt(
        source({
          ...over,
          findingsPolicy: { logBug: false, replan: true, autoApproveReplan: false },
        }),
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
      expect(prompt).toMatch(/submit_plan_session[\s\S]*targetKeys:\s+\[PROD-7\]/);
    });

    it('with re-planning DISABLED renders no submit step, and leaves the card in progress', () => {
      const { prompt } = assembleDispatchPrompt(
        source({
          ...over,
          findingsPolicy: { logBug: true, replan: false, autoApproveReplan: false },
        }),
      );
      expect(prompt).not.toContain('submit_plan_session');
      expect(prompt).not.toContain('append_plan_turn');
      expect(prompt).not.toContain('status planning');
      expect(prompt).toContain('leave the card In Progress');
      expect(prompt).toContain('without re-planning');
      // The other switch is untouched.
      expect(prompt).toContain('create_work_item');
    });

    it('with BOTH disabled keeps the FINISHED branch whole', () => {
      const { prompt } = assembleDispatchPrompt(
        source({
          ...over,
          findingsPolicy: { logBug: false, replan: false, autoApproveReplan: false },
        }),
      );
      expect(prompt).toContain('FINISHED — the work is done');
      expect(prompt).toContain('status implemented');
      expect(prompt).not.toContain('create_work_item');
      expect(prompt).not.toContain('submit_plan_session');
    });
  });

  it('DETERMINISM holds per policy — and two policies differ, so the switch is not inert', () => {
    // ⚠️ BOTH HALVES. The module's contract (MOTIR-881) is byte-identical output
    // for an unchanged input; the policy is now part of that input. Asserting
    // only the first half would pass just as well against a switch that renders
    // the same text whatever it is handed, and every disabled-branch assertion
    // above would then be vacuous.
    const full = source({
      findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false },
    });
    const none = source({
      findingsPolicy: { logBug: false, replan: false, autoApproveReplan: false },
    });
    expect(assembleDispatchPrompt(full).prompt).toBe(assembleDispatchPrompt(full).prompt);
    expect(assembleDispatchPrompt(none).prompt).toBe(assembleDispatchPrompt(none).prompt);
    expect(assembleDispatchPrompt(full).prompt).not.toBe(assembleDispatchPrompt(none).prompt);
  });
});

describe('THE CARD IS WRONG — the agent COMPOSES the WHAT, through the plan-session TOOLS (MOTIR-4083)', () => {
  // The submit used to be one shell command that sent a KEY and nothing else;
  // the evidence went into a comment a person reads, and the first thing a
  // triggered re-plan did was open a conversation to ask what was wrong. Now
  // the agent appends the finding as a turn, composes motir-ai's six-field
  // requirement, and submits both — through the tools it was already holding.
  //
  // ⚠️ EVERY ASSERTION HERE IS ON THE COMPOSED PROMPT — the artifact the agent
  // receives — never on the template source. And the field names are read
  // against the fixture that mirrors motir-ai's OWN list, because this seam
  // already failed once with both halves green (MOTIR-4168): a prompt asserted
  // only against itself is what let it.

  /** The card-is-wrong branch alone: from its heading to the third branch. */
  function replanArm(prompt: string): string {
    const section = cardOutcomeBranches(prompt);
    const at = section.indexOf('THE CARD IS WRONG');
    expect(at, 'the prompt carries THE CARD IS WRONG').toBeGreaterThan(-1);
    return section.slice(at);
  }

  /**
   * The two tool steps, sliced by their own numbering, so an assertion about
   * one call cannot be satisfied by text belonging to the other.
   */
  function toolSteps(arm: string): { append: string; submit: string } {
    const append = arm.indexOf('5. Put the finding on the planning thread');
    const submit = arm.indexOf('6. Compose the WHAT');
    const once = arm.indexOf('7. SUBMITTING IS THE ACT THAT SPENDS');
    expect(append, 'step 5 is the append').toBeGreaterThan(-1);
    expect(submit, 'step 6 is the submit').toBeGreaterThan(append);
    expect(once, 'step 7 is the once rule').toBeGreaterThan(submit);
    return { append: arm.slice(append, submit), submit: arm.slice(submit, once) };
  }

  /** One field's entry under `requirement:` — its name line plus the deeper-indented continuation lines. */
  function fieldEntry(submit: string, field: string): string {
    const lines = submit.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^\\s+${field}\\s{2,}`).test(l));
    expect(start, `${field} is taught`).toBeGreaterThan(-1);
    let end = start + 1;
    while (end < lines.length && /^\s{20,}\S/.test(lines[end]!)) end++;
    return lines.slice(start, end).join('\n');
  }

  it('step 5 names the TOOLS — append, then submit — after the Planning transition, and the shell-out is GONE', () => {
    const { prompt } = assembleDispatchPrompt(source({ key: 'PROD-99' }));
    const arm = replanArm(prompt);
    const at = (needle: string) => arm.indexOf(needle);
    expect(at('status planning')).toBeGreaterThan(-1);
    expect(at('append_plan_turn tool')).toBeGreaterThan(at('status planning'));
    expect(at('submit_plan_session tool')).toBeGreaterThan(at('append_plan_turn tool'));
    expect(at('Stop. Do not pick up other work')).toBeGreaterThan(at('submit_plan_session tool'));
    // ABSENCE, on the WHOLE prompt: a composed prompt still naming the retired
    // door fails here, whatever else it says.
    expect(prompt).not.toContain('motir plan');
    expect(prompt).not.toContain('--detach');
  });

  it('carries `targetKeys: [<KEY>]` on BOTH calls — the anchor is an argument now, and two calls are two chances to drop it', () => {
    const { prompt } = assembleDispatchPrompt(source({ key: 'PROD-99' }));
    const { append, submit } = toolSteps(replanArm(prompt));
    expect(append).toMatch(/targetKeys:\s+\[PROD-99\]/);
    expect(submit).toMatch(/targetKeys:\s+\[PROD-99\]/);
    expect(append).toMatch(/projectKey:\s+PROD\b/);
    expect(submit).toMatch(/projectKey:\s+PROD\b/);
    // …and it says WHY at the first call, and that both carry it at the second.
    expect(append).toContain('anchors the thread to this card');
    expect(append).toContain('PROJECT-WIDE thread');
    expect(submit).toContain('Both calls carry targetKeys');
  });

  it('teaches the six FIELD NAMES the wire and the validator use, in CANONICAL ORDER — read against motir-ai’s list', () => {
    // A rename on any of the three sides — the prompt, `submit_plan_session`'s
    // schema, motir-ai's `REQUIREMENT_FIELDS` (mirrored by the fixture) — fails
    // here rather than at a planning run in production.
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toContain('six named fields, in this order');
    let last = -1;
    for (const field of AI_REQUIREMENT_FIELDS) {
      const at = submit.search(new RegExp(`^\\s+${field}\\s{2,}`, 'm'));
      expect(at, `${field} is taught, after the field before it`).toBeGreaterThan(last);
      last = at;
    }
    // Exactly six — no seventh field invented, none dropped.
    const taught = submit.split('\n').filter((l) => /^ {11}[A-Za-z]+ {2,}/.test(l));
    expect(taught).toHaveLength(AI_REQUIREMENT_FIELDS.length);
  });

  it('marks exactly the REQUIRED three, and says "" is an ANSWER for the other three', () => {
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    for (const field of AI_REQUIREMENT_FIELDS) {
      const required = (AI_REQUIREMENT_REQUIRED_NON_EMPTY as readonly string[]).includes(field);
      const entry = fieldEntry(submit, field);
      if (required) {
        expect(entry, `${field} is marked required`).toContain('REQUIRED');
        expect(entry, `${field} does not offer ""`).not.toContain('""');
      } else {
        expect(entry, `${field} is not marked required`).not.toContain('REQUIRED');
        expect(entry, `${field} says "" is an answer`).toContain('""');
      }
    }
    expect(submit).toContain('three REQUIRED fields must be non-empty');
    expect(submit).toContain('which is an answer, not a blank to skip');
  });

  it('states the SELF-CONTAINED bar, and names the pointer as insufficient', () => {
    // "See my comment" satisfies "pass your evidence" and supplies nothing — it
    // is the answer a vaguer instruction gets, so the prompt names it.
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toContain('SELF-CONTAINED');
    expect(submit).toContain('"see my comment on the card"');
    expect(submit).toContain('supplies nothing');
    expect(submit).toContain('put the content in the field');
  });

  it('says the turn is the agent’s ONLY contribution — a brief, not a note', () => {
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toContain('This is your ONLY contribution');
    expect(submit).toContain('nothing will come back and ask you');
    expect(submit).toMatch(/Write a brief, not a\s+note/);
  });

  it('says APPENDING IS NOT SUBMITTING, and that submitting is the act that spends', () => {
    // "Run it once" has two parts now, and this is the one the split makes easy
    // to get wrong: an agent that thinks its append submitted stops having done
    // nothing. Stated in the prompt's own voice, not left to the tool text.
    const arm = replanArm(assembleDispatchPrompt(source()).prompt);
    const { append } = toolSteps(arm);
    expect(append).toContain('APPENDING IS NOT SUBMITTING');
    expect(append).toMatch(/costs nothing and\s+starts no job/);
    expect(append).toContain('Nothing has reached the planner until step 6');
    expect(arm).toContain("SUBMITTING IS THE ACT THAT SPENDS the token owner's AI credits");
  });

  it('the one legitimate retry is its OWN sentence, apart from *submit ONCE*', () => {
    // Two distinct sentences, because collapsing them is how "never retry"
    // becomes "retry freely". A schema-rejected requirement spent nothing, so
    // that ONE case is re-submitted — without the requirement.
    const arm = replanArm(assembleDispatchPrompt(source()).prompt);
    const once = arm.indexOf('do it exactly ONCE. Never retry it, even on a timeout');
    const exception = arm.indexOf('REJECTS your arguments');
    expect(once).toBeGreaterThan(-1);
    expect(exception).toBeGreaterThan(once);
    expect(arm).toMatch(/nothing happened — no job was created and no credits were spent/);
    expect(arm).toMatch(/re-submit once, WITHOUT the requirement/);
    expect(arm).toContain('That is the only retry there is');
  });

  it('does NOT ask the agent to diagnose the planning rules — asserted by absence', () => {
    // That is the fix phase's work, and an agent asked to classify invents.
    const { prompt } = assembleDispatchPrompt(source());
    for (const forbidden of [
      'planning rule',
      'planning bug',
      'log_planning_bug',
      'MOTIR-1465',
      'which rule',
      'lesson',
    ]) {
      expect(prompt.toLowerCase(), `no "${forbidden}"`).not.toContain(forbidden.toLowerCase());
    }
    const arm = replanArm(prompt);
    expect(arm).toContain('you are not asked to classify the');
    expect(arm).toMatch(/what is wrong with the\s+CARD, not why it was planned that way/);
  });

  it('a refusal with NO composed WHAT is still SENT', () => {
    // Refusing must never become conditional on writing well — the consumer
    // falls back to opening a conversation (MOTIR-4082), and the tool forwards a
    // partial or absent requirement unchanged (MOTIR-4172).
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toMatch(/submit anyway, WITHOUT\s+requirement/);
    expect(submit).toContain('must never wait on writing well');
  });

  it('the comment STAYS, and the turn carries the SAME content', () => {
    // Composed once, delivered twice: the human-readable trail is not traded
    // for the machine-readable one.
    const arm = replanArm(assembleDispatchPrompt(source()).prompt);
    expect(arm).toContain('3. Comment the finding on PROD-7');
    expect(toolSteps(arm).append).toContain('the SAME text as your step-3 comment');
  });

  it('is ONE text in both workflow variants — the arm does not vary by lineage', () => {
    // The composition is decided by the run's POLICY and the card, never by
    // which git workflow the item was dispatched under.
    const per = replanArm(assembleDispatchPrompt(source({ sessionBranch: null })).prompt);
    const lineage = replanArm(
      assembleDispatchPrompt(source({ sessionBranch: 'session/PROD-2-run' })).prompt,
    );
    expect(lineage).toBe(per);
  });

  it('with re-planning DISABLED, neither tool is named and nothing is composed', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: false, autoApproveReplan: false } }),
    );
    const outcome = outcomeSection(prompt);
    for (const gone of [
      'append_plan_turn',
      'submit_plan_session',
      'targetKeys',
      'requirement',
      'ONLY contribution',
      'SUBMITTING IS THE ACT',
    ]) {
      expect(outcome, `no "${gone}"`).not.toContain(gone);
    }
    expect(outcome).toContain('leave the card In Progress');
  });
});

describe('parseFindingsPolicy — the shared wire vocabulary', () => {
  it.each([undefined, null, '', '   '])('%o means the full protocol', (raw) => {
    expect(parseFindingsPolicy(raw)).toEqual({
      policy: { logBug: true, replan: true, autoApproveReplan: false },
      unknown: null,
    });
  });

  it.each([
    ['log-bug', { logBug: false, replan: true, autoApproveReplan: false }],
    ['replan', { logBug: true, replan: false, autoApproveReplan: false }],
    ['log-bug,replan', { logBug: false, replan: false, autoApproveReplan: false }],
    [' replan , log-bug ', { logBug: false, replan: false, autoApproveReplan: false }],
    ['log-bug,,replan', { logBug: false, replan: false, autoApproveReplan: false }],
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

// ── THE TWO LANES a re-plan can go down (MOTIR-4085) ────────────────────────
//
// `--auto-approve-replan` lets an unattended loop approve a re-plan itself and
// carry on. The BOUND on what it may approve is the loop's, enforced over the
// plan that comes back — nothing here is trusted. What the prompt buys is that
// the agent KNOWS which choice it is making: keep the correction to its own card
// and its siblings and the loop may act on it, or reach wider on purpose and a
// person decides.
//
// ⚠️ THE TESTS THAT MATTER MOST ARE THE ABSENCE ONES. A section rendered
// unconditionally would tell every agent on every run that its plan might be
// approved unattended, which is false for every run without the flag — and false
// in the direction an agent cannot check.
describe('THE CARD IS WRONG — the two lanes (MOTIR-4085)', () => {
  const withLane = (over: Partial<DispatchPromptSource> = {}) =>
    assembleDispatchPrompt(
      source({
        ...over,
        findingsPolicy: { logBug: true, replan: true, autoApproveReplan: true },
      }),
    ).prompt;

  it('renders NOTHING without the flag — the default prompt is byte-identical', () => {
    // The whole no-regression claim in one assertion: a run with no
    // auto-approving loop must send the prompt it sent before this existed.
    const before = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false } }),
    ).prompt;
    expect(before).toBe(assembleDispatchPrompt(source()).prompt);
    expect(before).not.toContain('TWO LANES');
  });

  it('names BOTH lanes, and the card and container each is anchored at', () => {
    const prompt = withLane();
    expect(prompt).toContain('TWO LANES');
    expect(prompt).toContain('--auto-approve-replan');
    // The card's own lane is the leaf plus its siblings under its parent…
    expect(prompt).toContain('PROD-7 and its siblings under PROD-2');
    // …and the normal lane is the container, by key, in BOTH calls.
    expect(prompt).toContain('[PROD-2]');
    expect(prompt).toContain('in BOTH calls');
  });

  it('says the normal lane is ALWAYS available, and that stopping is correct', () => {
    // ⚠️ THE ANTI-INCENTIVE HALF. An agent that believes it must keep the run
    // going has a reason to invent a local fix it does not believe in — which
    // buys continuity by spending plan quality. So the text has to say, in
    // words, that it is not being asked to keep the run going.
    const prompt = withLane();
    expect(prompt).toContain('ALWAYS available');
    expect(prompt).toContain('CHOOSE THE LANE THAT IS TRUE');
    expect(prompt).toContain('You are not being asked to keep the run going');
  });

  it('says a plan anchored here but wider is NOT approved, and is not a rejection', () => {
    const prompt = withLane();
    expect(prompt).toContain('the loop does not approve it');
    expect(prompt).toContain('names what fell outside');
    expect(prompt).toContain('not a rejection of your finding');
  });

  it('offers the anchorless lane for a missing PRECONDITION', () => {
    // The case with no card to name: nothing that exists is the target, so the
    // planner settles a new one. Omitting targetKeys is how that is expressed.
    expect(withLane()).toContain('omit targetKeys entirely');
  });

  it('degrades honestly for a PARENTLESS card — no sibling level to offer', () => {
    const prompt = withLane({ parent: null });
    expect(prompt).toContain('it has no parent, so it has no sibling level either');
    // …and it must not invent a container key it does not have.
    expect(prompt).not.toMatch(/siblings under (?!PROD-2)/);
  });

  it('renders nothing when re-planning is DISABLED — there is no plan to approve', () => {
    // Contradictory by construction, and `parseFindingsPolicy` resolves it to
    // the safe side. This asserts the template does not describe a lane for a
    // submission the same prompt has just forbidden.
    const prompt = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: false, autoApproveReplan: true } }),
    ).prompt;
    expect(prompt).not.toContain('TWO LANES');
    expect(prompt).toContain('without re-planning');
  });

  it('leaves the submit steps and their anchor UNCHANGED', () => {
    // The lane block is added BESIDE the protocol, not woven into it: the two
    // calls, the requirement fields and the one-shot rule are what they were.
    const prompt = withLane();
    expect(prompt).toMatch(/append_plan_turn[\s\S]*targetKeys:\s+\[PROD-7\]/);
    expect(prompt).toMatch(/submit_plan_session[\s\S]*targetKeys:\s+\[PROD-7\]/);
    expect(prompt).toContain('SUBMITTING IS THE ACT THAT SPENDS');
  });

  it('is DETERMINISTIC, and the two policies differ — so the switch is not inert', () => {
    const on = source({ findingsPolicy: { logBug: true, replan: true, autoApproveReplan: true } });
    const off = source({
      findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false },
    });
    expect(assembleDispatchPrompt(on).prompt).toBe(assembleDispatchPrompt(on).prompt);
    expect(assembleDispatchPrompt(on).prompt).not.toBe(assembleDispatchPrompt(off).prompt);
  });

  describe.each(VARIANTS)('on $name', ({ over }) => {
    it('renders the lane block in both git workflows', () => {
      // The election is about the PLAN, not about the branch, so it must not
      // vary with the workflow the run happens to be in.
      expect(withLane(over)).toContain('TWO LANES');
    });
  });
});

describe('parseFindingsPolicy — the auto-approve lane rides its own parameter', () => {
  it('defaults to FALSE, so every existing caller parses to what it always did', () => {
    expect(parseFindingsPolicy(undefined).policy).toEqual(FULL_FINDINGS_POLICY);
    expect(parseFindingsPolicy('').policy?.autoApproveReplan).toBe(false);
    expect(parseFindingsPolicy('log-bug').policy?.autoApproveReplan).toBe(false);
  });

  it('carries the flag through an empty and a non-empty disable list alike', () => {
    expect(parseFindingsPolicy('', { autoApproveReplan: true }).policy).toEqual({
      logBug: true,
      replan: true,
      autoApproveReplan: true,
    });
    expect(parseFindingsPolicy('log-bug', { autoApproveReplan: true }).policy).toEqual({
      logBug: false,
      replan: true,
      autoApproveReplan: true,
    });
  });

  it('RESOLVES the contradiction to the safe side — no re-plan means no lane', () => {
    // Approving a re-plan the agent was told not to submit is not a lane, it is
    // a nonsense. The CLI refuses the two flags at parse time; this is the same
    // rule for every other caller, and it fails to NO LANE rather than to one.
    expect(parseFindingsPolicy('replan', { autoApproveReplan: true }).policy).toEqual({
      logBug: true,
      replan: false,
      autoApproveReplan: false,
    });
  });

  it('still refuses an unknown token, whatever the flag says', () => {
    const parsed = parseFindingsPolicy('no-log-bug', { autoApproveReplan: true });
    expect(parsed.policy).toBeNull();
    expect(parsed.unknown).toBe('no-log-bug');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPTANCE-RECEIPT STEPS (bug MOTIR-4704)
//
// Both directions are asserted, and the NEGATIVE one is the reason this block
// exists. The bug being fixed is that the runner was never told to publish; the
// bug this could introduce is telling every `type: test` card to publish a
// recording it never made, which sends an agent hunting for a video that does
// not exist. A suite that only checks the positive direction leaves the
// condition itself untested.
// ─────────────────────────────────────────────────────────────────────────────

describe('the acceptance-receipt steps are conditional on the card recording one', () => {
  const acceptanceCard = (over: Partial<DispatchPromptSource> = {}) =>
    source({
      key: 'PROD-40',
      type: 'test',
      title: 'Story E2E (Playwright) + ACCEPTANCE VIDEO — walk both surfaces',
      descriptionMd: [
        'Record the story working, paced for a human.',
        '',
        '## Acceptance criteria',
        '',
        '- The spec declares its story and stays under 60s.',
      ].join('\n'),
      ...over,
    });

  it('names BOTH calls on a card that records an acceptance video', () => {
    const { prompt } = assembleDispatchPrompt(acceptanceCard());

    expect(prompt).toContain('create_acceptance_upload');
    expect(prompt).toContain('publish_acceptance_result');
    // The mint-then-PUT shape has to be stated, or an agent reads two tool names
    // and looks for the argument that takes the bytes.
    expect(prompt).toContain('Content-Type: video/webm');
    // The silence is the hazard, so the prompt says so where the agent is
    // standing when it decides whether the run is over.
    expect(prompt).toContain('NOTHING ELSE MAKES THAT CALL');
  });

  it('keeps the ordinary test steps and APPENDS to them', () => {
    // Appended, never substituted: an acceptance card still writes and greens
    // its spec, and the publish is the step after that.
    const { prompt } = assembleDispatchPrompt(acceptanceCard());
    expect(prompt).toContain('4. Run the test files you added or changed and leave them green.');
    expect(prompt).toContain('5. PUBLISH the receipt');
  });

  it('finds the signal in the DESCRIPTION when the title does not carry it', () => {
    const { prompt } = assembleDispatchPrompt(
      acceptanceCard({
        title: 'Story E2E — an admin and a member walk the spend surfaces',
        descriptionMd: "Declare the story with `acceptanceStory('PROD-39')` and pace it.",
      }),
    );
    expect(prompt).toContain('publish_acceptance_result');
  });

  it('says NOTHING about publishing on an ordinary regression test card', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        type: 'test',
        title: 'Cover the ready-filter reducer',
        descriptionMd: 'Write unit tests for the reducer’s three branches.',
      }),
    );

    expect(prompt).not.toContain('create_acceptance_upload');
    expect(prompt).not.toContain('publish_acceptance_result');
    expect(prompt).toContain('4. Run the test files you added or changed and leave them green.');
  });

  it('says nothing about publishing on a `code` card that merely mentions the video', () => {
    // The gate is the TYPE and the text together. A code card describing the
    // acceptance lane is not a card that records a receipt.
    const { prompt } = assembleDispatchPrompt(
      source({
        type: 'code',
        title: 'Rename the acceptance video lane',
        descriptionMd: 'The lane is called `Acceptance video` and publishes nothing.',
      }),
    );
    expect(prompt).not.toContain('publish_acceptance_result');
  });

  it('says nothing on a MANUAL item, which has no run to record in', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        type: 'manual',
        executor: 'human',
        title: 'Watch the acceptance video and approve it',
        descriptionMd: 'A person watches the receipt and decides.',
      }),
    );
    expect(prompt).not.toContain('create_acceptance_upload');
  });
});
