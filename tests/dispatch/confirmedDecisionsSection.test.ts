import { describe, expect, it } from 'vitest';
import {
  assembleDispatchPrompt,
  type ConfirmedDecisionForPrompt,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';

// THE DISPATCHED PROMPT HANDS A RUN ITS EPIC'S CONFIRMED DECISIONS (Story MOTIR-5871 ·
// Subtask MOTIR-5959; ADR `approval-gates.md` §1's MOTIR-5952 amendment, point 10).
// PURE: the section renders the decisions it is given in the order given, dated, with
// their `## Decision` and `## Resulting direction`, followed by the CALENDAR rule — and
// an empty list renders no section and no heading. The ordering and the exclusions are
// the service's (`tests/dispatch/confirmedDecisionsRead.test.ts`).

function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Build the export page',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 45,
    descriptionMd: 'Build it.\n\n## Acceptance criteria\n\n- It exports.',
    blockerKeys: [],
    openDependentKeys: [],
    parent: { key: 'PROD-2', title: 'Exports' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    ...over,
  };
}

const EARLIER: ConfirmedDecisionForPrompt = {
  key: 'PROD-10',
  title: 'Exports move to object storage',
  decidedAt: '2026-09-01T09:00:00.000Z',
  decisionMd: 'Exports move to managed object storage.',
  resultingDirectionMd: 'Every export is written to the bucket.',
};
const LATER: ConfirmedDecisionForPrompt = {
  key: 'PROD-11',
  title: 'Drop the CSV variant',
  decidedAt: '2026-09-15T09:00:00.000Z',
  decisionMd: 'CSV export is dropped.\nOnly XLSX remains.',
  resultingDirectionMd: 'Every export is XLSX, written to the bucket.',
};

const HEADING = 'CONFIRMED DECISIONS ON THIS EPIC — the direction a person agreed, oldest first';

describe('the section', () => {
  it('renders each decision in the order given — key, title, date, Decision, Resulting direction', () => {
    const { prompt } = assembleDispatchPrompt(source({ confirmedDecisions: [EARLIER, LATER] }));
    const start = prompt.indexOf(HEADING);
    expect(start).toBeGreaterThan(-1);
    const section = prompt.slice(start, prompt.indexOf('CARD DESCRIPTION'));
    expect(section).toContain(
      [
        '  PROD-10 — Exports move to object storage',
        '    confirmed 2026-09-01T09:00:00.000Z',
        '    Decision:',
        '      Exports move to managed object storage.',
        '    Resulting direction:',
        '      Every export is written to the bucket.',
      ].join('\n'),
    );
    expect(section).toContain(
      [
        '  PROD-11 — Drop the CSV variant',
        '    confirmed 2026-09-15T09:00:00.000Z',
        '    Decision:',
        '      CSV export is dropped.',
        '      Only XLSX remains.',
      ].join('\n'),
    );
    expect(section.indexOf('PROD-10')).toBeLessThan(section.indexOf('PROD-11'));
  });

  it('sits AFTER the context facts and BEFORE the card description', () => {
    const { prompt } = assembleDispatchPrompt(source({ confirmedDecisions: [EARLIER] }));
    expect(prompt.indexOf(HEADING)).toBeLessThan(prompt.indexOf('CARD DESCRIPTION'));
  });

  it('an empty section body still says so rather than rendering a blank', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ confirmedDecisions: [{ ...EARLIER, resultingDirectionMd: '  ' }] }),
    );
    expect(prompt).toContain('    Resulting direction:\n      (empty)');
  });
});

describe('THE CALENDAR RULE', () => {
  it('tells the agent that NEWER contradicting code is reported and never changed — and where', () => {
    const { prompt } = assembleDispatchPrompt(source({ confirmedDecisions: [EARLIER] }));
    const rule = prompt.slice(
      prompt.indexOf('HOW TO READ THEM'),
      prompt.indexOf('CARD DESCRIPTION'),
    );
    expect(rule).toContain('git log -1 --format=%cI -- <path>');
    expect(rule).toContain('committed AFTER the decision was');
    expect(rule).toContain('DO NOT change it to');
    expect(rule).toContain('match the decision');
    expect(rule).toContain('in your pull request body AND in a comment on this card');
    expect(rule).toContain('the decision key, the path');
    expect(rule).toContain('and the commit date');
    // The other half: a decision newer than the code governs the work.
    expect(rule).toContain('Where a');
    expect(rule).toContain(
      'decision is NEWER than the code it describes, the decision governs your work.',
    );
  });
});

describe('the ordinary card', () => {
  it('no decisions renders no section and no heading — the prompt is unchanged', () => {
    const without = assembleDispatchPrompt(source()).prompt;
    expect(without).not.toContain('CONFIRMED DECISIONS');
    expect(without).not.toContain('HOW TO READ THEM');
    expect(assembleDispatchPrompt(source({ confirmedDecisions: [] })).prompt).toBe(without);
  });
});
