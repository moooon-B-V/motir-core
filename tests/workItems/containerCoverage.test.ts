import { describe, expect, it } from 'vitest';
import {
  containerCoverageFinding,
  criterionTokens,
  quantifiesOverChildren,
  unownedCriteria,
  type CoverageChild,
} from '@/lib/workItems/containerCoverage';
import { acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';

// The CONTAINER-COVERAGE check's pure half (MOTIR-5362). The service half — the
// rows it gathers and the verdict it must not touch — is asserted over real
// Postgres in `tests/mcp/validate-work-item.test.ts`.

const at = (iso: string) => new Date(iso);

describe('acceptanceCriteriaTexts — one string per criterion, numbered as the shape checks number them', () => {
  it('attributes continuation lines to the bullet they wrap from, and skips the lead-in', () => {
    const md = [
      '## Acceptance criteria',
      '',
      '*(met by the assembled stories)*',
      '',
      '- first criterion',
      '  wrapping onto a second line',
      '2. second criterion',
      '',
      '## Context refs',
      '',
      '- not a criterion',
    ].join('\n');
    const criteria = acceptanceCriteriaTexts(md);
    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toContain('wrapping onto a second line');
    expect(criteria[1]).toMatch(/^2\. second criterion/);
  });

  it('returns nothing for a body with no acceptance-criteria heading — never a guess', () => {
    expect(acceptanceCriteriaTexts('## Verification\n\n- walk the recipe')).toEqual([]);
    expect(acceptanceCriteriaTexts(null)).toEqual([]);
  });
});

describe('containerCoverageFinding — the MEASURED fixture (MOTIR-4882, read 2026-09-13)', () => {
  /**
   * MOTIR-4882's seven criteria verbatim, and its two children as they stood:
   * both created 2026-09-07, the story 2026-09-08 — ADOPTED. Criteria 1, 3 and 6
   * are owned by neither child (filed as MOTIR-5401); criterion 7 is owned by
   * MOTIR-4793's BODY under a title that does not name it, which is the accepted
   * false-positive class of a title reading. Holding all four here pins what the
   * measurement on MOTIR-5362 actually saw, not an idealised answer.
   */
  const STORY = {
    createdAt: at('2026-09-08T00:09:36.044Z'),
    descriptionMd: [
      '## Acceptance criteria',
      '',
      '- `GitProvider` declares `mergeChangeRequest` and the GITHUB provider implements it, returning a normalized success or a **typed** refusal; no consumer above the provider imports a GitHub type or a status code.',
      '- Approving a `pull_request_merge` gate on an IMPORTED repository merges that pull request on GitHub, and the card reaches Done through the SAME webhook path a hand merge takes — asserted end to end, not by the gate writing a status.',
      "- The App is selected from the repository's provenance: a HOSTED repository mints through the provisioning App and an IMPORTED one through the integration App, with a test driving both and asserting which credential each took.",
      '- **Each of the six refusals renders in the control with copy naming the next action**, and the test drives them as a matrix rather than asserting one: not-green, conflict, protected branch, no linked pull request, missing permission, already-decided.',
      '- `prMergeMode` decides whether a gate is created at all — `manual` creates one, `auto` creates none — asserted on a project of each, and the value is read from the PROJECT.',
      '- No `pull_request_merge` gate is created, and Motir attempts no merge, for a pull request whose checks are not green, in either mode.',
      "- The merge call is a **side effect OUTSIDE the transaction** that records the decision, per the repo's own convention, and a merge that fails leaves the gate decidable rather than half-decided.",
    ].join('\n'),
  };
  const CHILDREN: CoverageChild[] = [
    {
      identifier: 'MOTIR-4787',
      title:
        "(platform, manual) Raise the `motir-integration` GitHub App to `contents: write` and re-consent its installations — merging a pull request needs it, and the granted set is read back from the App's own API",
      createdAt: at('2026-09-07T00:22:15.773Z'),
    },
    {
      identifier: 'MOTIR-4793',
      title:
        '(motir-core) The pull-request MERGE gate — Motir merges through the App, `Project.prMergeMode` gets its first reader, and every refusal renders in the SAME control in the Development section',
      createdAt: at('2026-09-07T00:22:16.075Z'),
    },
  ];

  it('names criteria 1, 3, 6 (unowned) and 7 (the measured false positive), with both adopted children', () => {
    expect(containerCoverageFinding(STORY, CHILDREN)).toEqual({
      unownedCriterionIndices: [1, 3, 6, 7],
      adoptedChildren: ['MOTIR-4787', 'MOTIR-4793'],
    });
  });

  it('says nothing when every child was written UNDER the container — adoption is the gate', () => {
    const authoredUnder = CHILDREN.map((c) => ({ ...c, createdAt: at('2026-09-09T00:00:00Z') }));
    expect(containerCoverageFinding(STORY, authoredUnder)).toBeNull();
  });

  it('a child created at the SAME instant as the container is not adopted', () => {
    const sameInstant = CHILDREN.map((c) => ({ ...c, createdAt: STORY.createdAt }));
    expect(containerCoverageFinding(STORY, sameInstant)).toBeNull();
  });

  it('says nothing when the adopted children own every criterion', () => {
    const owners: CoverageChild[] = [
      ...CHILDREN,
      {
        identifier: 'MOTIR-9001',
        title: '`GitProvider.mergeChangeRequest` — the seam and its GitHub implementation',
        createdAt: at('2026-09-09T00:00:00Z'),
      },
      {
        identifier: 'MOTIR-9002',
        title: 'The App is selected by repository provenance — hosted vs imported credential',
        createdAt: at('2026-09-09T00:00:00Z'),
      },
      {
        identifier: 'MOTIR-9003',
        title: 'No `pull_request_merge` gate for checks that are not green',
        createdAt: at('2026-09-09T00:00:00Z'),
      },
      {
        identifier: 'MOTIR-9004',
        title: 'The merge runs outside the transaction',
        createdAt: at('2026-09-09T00:00:00Z'),
      },
    ];
    expect(containerCoverageFinding(STORY, owners)).toBeNull();
  });
});

describe('unownedCriteria — what counts as ownership', () => {
  const container = (criteria: string[]) =>
    ['## Acceptance criteria', '', ...criteria.map((c) => `- ${c}`)].join('\n');

  it('ONE shared noun is not ownership — a child must carry two of the criterion’s words', () => {
    const md = container(['The session cookie domain is unchanged on the application host.']);
    expect(unownedCriteria(md, [{ title: 'Planning session transcript export' }])).toEqual([1]);
    expect(unownedCriteria(md, [{ title: 'Session cookie hardening' }])).toEqual([]);
  });

  it('a criterion with a single distinguishing token is owned by a title carrying that one', () => {
    const md = container(['The `prMergeMode` is read.']);
    expect(criterionTokens('- The `prMergeMode` is read.').spans).toEqual(['prmergemode']);
    expect(unownedCriteria(md, [{ title: 'Readers move to `Project.prMergeMode`' }])).toEqual([]);
  });

  it('matches a code span as a SUBSTRING and folds regular plurals on both sides', () => {
    const md = container(['Every refusals matrix renders `prMergeMode` copy.']);
    expect(unownedCriteria(md, [{ title: 'The refusal copy for Project.prMergeMode' }])).toEqual(
      [],
    );
  });

  it('never reports a criterion that QUANTIFIES OVER THE CHILDREN — its owner is all of them', () => {
    expect(quantifiesOverChildren('- Each story carries its own ADR naming its mirrors.')).toBe(
      true,
    );
    expect(quantifiesOverChildren('1. Every story below is `done`.')).toBe(true);
    expect(quantifiesOverChildren('- For **every** way a credit can be spent, …')).toBe(false);
    const md = container([
      'Each story carries its own ADR naming its mirrors.',
      'Every story below is done.',
    ]);
    expect(unownedCriteria(md, [{ title: 'Unrelated billing work' }])).toEqual([]);
  });

  it('never reports a criterion it cannot judge — no distinguishing token at all', () => {
    const md = container(['It is done and it is fine.']);
    expect(unownedCriteria(md, [{ title: 'Something entirely different' }])).toEqual([]);
  });

  it('ignores work-item keys and planning vocabulary as tokens', () => {
    expect(criterionTokens('- MOTIR-4793 story acceptance criteria asserted').words).toEqual([]);
  });

  it('returns nothing for a container with no children or no criteria', () => {
    expect(unownedCriteria(container(['A thing about widgets and gadgets.']), [])).toEqual([]);
    expect(unownedCriteria('No heading here.', [{ title: 'x' }])).toEqual([]);
  });
});
