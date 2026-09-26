import { describe, expect, it } from 'vitest';
import {
  assembleDispatchPrompt,
  type ChangesRequestedForPrompt,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';

// THE NEXT RUN IS HANDED THE REASON (Story MOTIR-6070 · Subtask MOTIR-6422; ADR
// `approval-gates.md` §10h note 4). PURE: the CHANGES REQUESTED section renders the
// refusals it is given — who, when, through which surface, the refused version, the
// verdict when set, the reason verbatim — and an empty list renders no section at all.
// A GitHub refusal with no body says §10b's words. Which refusal is handed over (the
// latest DECIDED gate, any kind) is the service's, in `changesRequestedRead.test.ts`.

function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Design the export page',
    kind: 'subtask',
    type: 'design',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 45,
    descriptionMd: 'Draw it.\n\n## Acceptance criteria\n\n- It is drawn.',
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

const DESIGN_REFUSAL: ChangesRequestedForPrompt = {
  key: 'PROD-7',
  gateId: 'gate-1',
  kind: 'design_result',
  noteMd: 'The empty state is missing.\nAnd the header wraps at 360px.',
  decidedByLabel: 'Ada L. <ada@example.com>',
  decidedAt: '2026-09-20T10:00:00.000Z',
  decisionSource: 'ui',
  refusalVerdict: 'revise',
  subjectVersion: 'evidence-v2',
};

const HEADING = 'CHANGES REQUESTED — the last attempt was sent back, and why';

function sectionOf(prompt: string): string {
  const start = prompt.indexOf(HEADING);
  expect(start).toBeGreaterThan(-1);
  return prompt.slice(start, prompt.indexOf('CARD DESCRIPTION'));
}

describe('the CHANGES REQUESTED section', () => {
  it('names the decider, the date, the refused version, the verdict and the reason verbatim', () => {
    const { prompt } = assembleDispatchPrompt(source({ changesRequested: [DESIGN_REFUSAL] }));
    const section = sectionOf(prompt);
    expect(section).toContain(
      [
        '  PROD-7 — its design_result gate was refused',
        '    by Ada L. <ada@example.com> in Motir, on 2026-09-20T10:00:00.000Z',
        '    refused version: evidence-v2',
        '    verdict: Revise — the reviewer asked for this work to be revised.',
        '    reason (verbatim):',
        '      The empty state is missing.',
        '      And the header wraps at 360px.',
      ].join('\n'),
    );
    expect(section).toContain('ADDRESS THIS REASON IN THIS ATTEMPT.');
  });

  it('sits among the gate-derived context — after the confirmed decisions, before CARD DESCRIPTION', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        changesRequested: [DESIGN_REFUSAL],
        confirmedDecisions: [
          {
            key: 'PROD-10',
            title: 'A decision',
            decidedAt: '2026-09-01T09:00:00.000Z',
            decisionMd: 'Decided.',
            resultingDirectionMd: 'Direction.',
          },
        ],
      }),
    );
    const decisions = prompt.indexOf('CONFIRMED DECISIONS ON THIS EPIC');
    const refused = prompt.indexOf(HEADING);
    const body = prompt.indexOf('CARD DESCRIPTION');
    expect(decisions).toBeGreaterThan(-1);
    expect(decisions).toBeLessThan(refused);
    expect(refused).toBeLessThan(body);
  });

  it('renders NOTHING — no heading — for a card with no refusal', () => {
    const absent = assembleDispatchPrompt(source()).prompt;
    const empty = assembleDispatchPrompt(source({ changesRequested: [] })).prompt;
    expect(absent).not.toContain('CHANGES REQUESTED');
    // Byte-identical to the prompt before the field existed.
    expect(empty).toBe(absent);
  });

  it('a GitHub refusal with no body says "no reason given on GitHub", and carries no verdict line', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        changesRequested: [
          {
            ...DESIGN_REFUSAL,
            kind: 'pull_request_approval',
            noteMd: null,
            decidedByLabel: 'octocat',
            decisionSource: 'github',
            refusalVerdict: null,
            subjectVersion: 'moooon/motir-core#1@abc',
          },
        ],
      }),
    );
    const section = sectionOf(prompt);
    expect(section).toContain('    by octocat in a GitHub review, on 2026-09-20T10:00:00.000Z');
    expect(section).toContain('    reason (verbatim):\n      (no reason given on GitHub)');
    expect(section).not.toContain('verdict:');
  });

  it('a re-plan verdict and a missing version / decider are said, never left blank', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        changesRequested: [
          {
            ...DESIGN_REFUSAL,
            refusalVerdict: 're_plan',
            decidedByLabel: null,
            decisionSource: null,
            subjectVersion: null,
          },
        ],
      }),
    );
    const section = sectionOf(prompt);
    expect(section).toContain('    by somebody no longer resolvable, on 2026-09-20T10:00:00.000Z');
    expect(section).toContain('    refused version: not recorded');
    expect(section).toContain(
      '    verdict: Re-plan — the reviewer judged the plan around this work wrong.',
    );
  });

  it('renders one entry per refusal handed over — the card’s own and its run target’s — in order', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        changesRequested: [
          DESIGN_REFUSAL,
          {
            ...DESIGN_REFUSAL,
            key: 'PROD-2',
            kind: 'acceptance_result',
            noteMd: 'The video stops before the export finishes.',
            refusalVerdict: null,
          },
        ],
      }),
    );
    const section = sectionOf(prompt);
    expect(section.match(/CHANGES REQUESTED/g)).toHaveLength(1);
    expect(section.indexOf('  PROD-7 — its design_result gate')).toBeLessThan(
      section.indexOf('  PROD-2 — its acceptance_result gate'),
    );
    expect(section).toContain('      The video stops before the export finishes.');
  });
});
