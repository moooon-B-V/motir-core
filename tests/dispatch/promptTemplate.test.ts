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
const SECTIONS = ['CONTEXT', 'WHAT TO DO', 'ACCEPTANCE CRITERIA', 'GIT WORKFLOW'];

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
