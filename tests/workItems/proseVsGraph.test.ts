import { describe, expect, it } from 'vitest';
import {
  POST_MERGE_CRITERION_PHRASES,
  acceptanceCriteriaSpan,
  bodyReferenceSeverities,
  firstPostMergeCriterion,
  isOrderingCheckExempt,
} from '@/lib/workItems/proseVsGraph';

// The PURE half of the prose-vs-graph advisory (MOTIR-1969) — reference
// extraction + the acceptance-criteria section heuristic that promotes a
// reference from `advisory` to `likely-missing-edge`. No DB, no IO.

const token = (label: string, id: string) => `[${label}](motir:${id})`;

describe('acceptanceCriteriaSpan — the section heuristic', () => {
  it('spans from the AC heading to the next heading of the SAME level', () => {
    const md = [
      '# Intro',
      'body',
      '## Acceptance criteria',
      '- one',
      '## Context refs',
      '- ref',
    ].join('\n');
    const span = acceptanceCriteriaSpan(md);
    expect(span).not.toBeNull();
    expect(md.slice(span!.start, span!.end)).toBe('## Acceptance criteria\n- one\n');
  });

  it('a HIGHER-level heading also closes the section', () => {
    const md = ['### Acceptance criteria', '- one', '## Context refs', '- ref'].join('\n');
    const span = acceptanceCriteriaSpan(md)!;
    expect(md.slice(span.start, span.end)).toBe('### Acceptance criteria\n- one\n');
  });

  it('a DEEPER sub-heading stays INSIDE the section', () => {
    const md = ['## Acceptance criteria', '### Sub', '- one', '## After', 'x'].join('\n');
    const span = acceptanceCriteriaSpan(md)!;
    expect(md.slice(span.start, span.end)).toBe('## Acceptance criteria\n### Sub\n- one\n');
  });

  it('runs to the END of the body when no heading follows', () => {
    const md = '## Acceptance criteria\n- one\n- two';
    const span = acceptanceCriteriaSpan(md)!;
    expect(span.end).toBe(md.length);
  });

  it('matches case-insensitively at any heading level', () => {
    expect(acceptanceCriteriaSpan('###### ACCEPTANCE CRITERIA\n- x')).not.toBeNull();
    expect(acceptanceCriteriaSpan('# acceptance criteria — must all hold\n- x')).not.toBeNull();
  });

  it('a body with NO acceptance-criteria heading returns null (degrades, never errors)', () => {
    expect(acceptanceCriteriaSpan('## Context refs\n- x')).toBeNull();
    // ACs written inline in prose, with no heading, are the same case.
    expect(acceptanceCriteriaSpan('The acceptance criteria are: it must work.')).toBeNull();
  });
});

describe('bodyReferenceSeverities — the named set N, with tiers', () => {
  it('a reference named ONLY outside the AC section is plain `advisory`', () => {
    const md = `Context: ${token('MOTIR-9', 'id9')}\n\n## Acceptance criteria\n- nothing named here`;
    expect([...bodyReferenceSeverities(md)]).toEqual([['id9', 'advisory']]);
  });

  it('a reference inside the AC section is `likely-missing-edge`', () => {
    const md = `## Acceptance criteria\n- consumes ${token('MOTIR-9', 'id9')}`;
    expect([...bodyReferenceSeverities(md)]).toEqual([['id9', 'likely-missing-edge']]);
  });

  it('the SAME id named in BOTH places reports the HIGHEST tier, once', () => {
    const md = [
      `Prose mentions ${token('MOTIR-9', 'id9')}.`,
      '',
      '## Acceptance criteria',
      `- consumes ${token('MOTIR-9', 'id9')}`,
      '',
      '## Context refs',
      `- ${token('MOTIR-9', 'id9')}`,
    ].join('\n');
    expect([...bodyReferenceSeverities(md)]).toEqual([['id9', 'likely-missing-edge']]);
  });

  it('with NO acceptance-criteria heading every reference falls back to `advisory`', () => {
    const md = `The card consumes ${token('MOTIR-9', 'id9')} and relates to ${token('MOTIR-8', 'id8')}.`;
    expect([...bodyReferenceSeverities(md)]).toEqual([
      ['id9', 'advisory'],
      ['id8', 'advisory'],
    ]);
  });

  it('DEDUPES multiple links to the same id', () => {
    const md = `${token('A', 'id9')} ${token('B', 'id9')} ${token('C', 'id9')}`;
    expect(bodyReferenceSeverities(md).size).toBe(1);
  });

  it('a token inside a CODE FENCE or BLOCKQUOTE is extracted — same N as auto-relate', () => {
    // Deliberate: this module reuses the shipped auto-relate extraction, which is
    // what wrote the `relates_to` edge the advisory contrasts against blocked_by.
    // A narrower N here would disagree with the graph it audits.
    const fenced = `\`\`\`md\n${token('MOTIR-9', 'id9')}\n\`\`\``;
    expect([...bodyReferenceSeverities(fenced).keys()]).toEqual(['id9']);
    const quoted = `> see ${token('MOTIR-8', 'id8')}`;
    expect([...bodyReferenceSeverities(quoted).keys()]).toEqual(['id8']);
  });

  it('a MALFORMED near-token is body text, never an error and never a reference', () => {
    const md = [
      '[MOTIR-9](motir:)', // empty payload
      '[MOTIR-9](https://example.com/motir:id9)', // not the motir: scheme
      '[MOTIR-9(motir:id9)', // unclosed bracket
      'motir:id9', // bare scheme, no link
    ].join('\n');
    expect(bodyReferenceSeverities(md).size).toBe(0);
  });

  it('an INTRA-PLAN token is keyed by its `planItem:` temp-ref', () => {
    const md = `## Acceptance criteria\n- needs [New sibling](motir-ref:planItem:pi_7)`;
    expect([...bodyReferenceSeverities(md)]).toEqual([['planItem:pi_7', 'likely-missing-edge']]);
  });

  it('an empty / null / undefined body yields no references', () => {
    expect(bodyReferenceSeverities(null).size).toBe(0);
    expect(bodyReferenceSeverities(undefined).size).toBe(0);
    expect(bodyReferenceSeverities('').size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDERING CHECK (MOTIR-2175) — gate 14's third axis, mechanized.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate 14's ORDERING sentence, transcribed VERBATIM from
 * `motir-meta/prompts/plan-rules.md` (*"An ACCEPTANCE CRITERION must be
 * satisfiable INSIDE the card's own scope boundary"*, THIRD AXIS bullet).
 *
 * ⚠️ This is the DRIFT GUARD's fixture, and its whole value is being a copy of
 * the prose rather than a restatement of the code. `plan-rules.md` lives in
 * another repo, so it cannot be read at test time — transcribing it here means
 * a phrase added to the rule and not to the constant fails THIS test, loudly,
 * instead of leaving a silent gap in the check. If you edit the rule, edit this
 * string in the same pass.
 */
const GATE_14_ORDERING_SENTENCE =
  '**Its tell is purely lexical and costs no judgement: the words "merged to `main`", ' +
  '"once this lands", "after release", "on `main`", "the published X" — and EVERY criterion ' +
  'at or below the first line carrying one belongs to a different card,**';

/** The quoted phrases, pulled out of the prose exactly as it writes them. */
const gate14Phrases = [...GATE_14_ORDERING_SENTENCE.matchAll(/"([^"]+)"/g)].map((m) =>
  (m[1] as string).replace(/`/g, '').replace(/ X$/, ''),
);

/** A body carrying `criteria` as its acceptance-criteria list. */
const withCriteria = (...criteria: string[]) =>
  ['Narrative body.', '', '## Acceptance criteria', '', ...criteria.map((c) => `- ${c}`)].join(
    '\n',
  );

describe('POST_MERGE_CRITERION_PHRASES — the drift guard', () => {
  it('COVERS every phrase gate 14 names, verbatim', () => {
    // Sanity: the transcription really did yield the five quoted phrases, so a
    // regex that silently matched nothing cannot make this test vacuous.
    expect(gate14Phrases).toEqual([
      'merged to main',
      'once this lands',
      'after release',
      'on main',
      'the published',
    ]);
    for (const phrase of gate14Phrases) {
      expect(POST_MERGE_CRITERION_PHRASES).toContain(phrase);
    }
  });

  it('adds `once it lands` — the conjugation MOTIR-2162 actually shipped', () => {
    // The ONE member gate 14's prose does not spell out. It is the same tell in
    // the third person, and it is the exact wording of the criterion that got
    // through (MOTIR-2164), so the list is a deliberate superset of the prose,
    // never a subset. Any OTHER divergence is drift and fails the test above.
    expect(POST_MERGE_CRITERION_PHRASES).toContain('once it lands');
    expect(new Set(POST_MERGE_CRITERION_PHRASES)).toEqual(
      new Set([...gate14Phrases, 'once it lands']),
    );
  });

  it('every phrase FIRES when it sits in a criterion — the list is wired, not decorative', () => {
    for (const phrase of POST_MERGE_CRITERION_PHRASES) {
      const found = firstPostMergeCriterion(
        withCriteria('a clean criterion', `something ${phrase} X`),
      );
      expect(found, `phrase "${phrase}" did not fire`).toEqual({ phrase, criterionIndex: 2 });
    }
  });
});

describe('firstPostMergeCriterion — gate 14, ORDERING axis', () => {
  it('MOTIR-2162 REGRESSION: reproduces criterion 5 verbatim and names criterion 5', () => {
    // The card that got through, six hours after the ORDERING limb landed on
    // `main` (MOTIR-2164). Criterion 5 is quoted from the bug's own record.
    const md = withCriteria(
      '`motir-core/docs/decisions/code-graph-index-fleet.md` gains an offboarding section that ' +
        'answers, per trigger, which of the three artifacts is removed and by whom.',
      'The decision names the **order** (snapshot before coordination row) and the idempotency ' +
        'requirement.',
      'The core→ai trigger is pinned as a named seam (route / event / job).',
      'Every deferral this section writes is a card filed in the same action, with its key cited ' +
        'inline.',
      "`src/services/codeRepoService.ts`'s header block … is updated to point at the decision " +
        '**once it lands**, so the pointer does not outlive the gap.',
      'A `docs/`-prefixed branch (the diff is Markdown-only).',
    );
    expect(firstPostMergeCriterion(md)).toEqual({ phrase: 'once it lands', criterionIndex: 5 });
  });

  it('reports the FIRST offender — gate 14 cuts there, and the rest inherit it', () => {
    const md = withCriteria(
      'the version bump lands in `package.json`',
      'the tag `cli-v0.1.1` is pushed once this lands',
      'the digests of the published image are transcribed',
    );
    expect(firstPostMergeCriterion(md)).toEqual({ phrase: 'once this lands', criterionIndex: 2 });
  });

  it('sees THROUGH inline markup — backticks and bold, as the corpus actually writes it', () => {
    expect(firstPostMergeCriterion(withCriteria('the row exists on `main`'))).toEqual({
      phrase: 'on main',
      criterionIndex: 1,
    });
    expect(firstPostMergeCriterion(withCriteria('the file is **merged to `main`**'))).toEqual({
      phrase: 'merged to main',
      criterionIndex: 1,
    });
  });

  it('attributes a phrase on a CONTINUATION line to the bullet it wraps from', () => {
    const md = [
      '## Acceptance criteria',
      '',
      '- the workflow file is added',
      '- the release lane is green, and the artifact is verifiable',
      '  once it lands',
      '  - a nested note, still criterion 2',
    ].join('\n');
    expect(firstPostMergeCriterion(md)).toEqual({ phrase: 'once it lands', criterionIndex: 2 });
  });

  it('counts NUMBERED criteria the same way as bulleted ones', () => {
    const md = ['## Acceptance criteria', '', '1. first', '2. the published image is pulled'].join(
      '\n',
    );
    expect(firstPostMergeCriterion(md)).toEqual({ phrase: 'the published', criterionIndex: 2 });
  });

  it('DEGRADES to nothing when the body has no acceptance-criteria heading', () => {
    // The inversion of the reference scan's fallback, and deliberate: the
    // phrases are legitimate in a narrative and are a defect only in a criterion.
    const md = 'This card exists so that, once this lands, the next one can start.';
    expect(firstPostMergeCriterion(md)).toBeNull();
  });

  it('does NOT fire on the same words OUTSIDE the acceptance-criteria section', () => {
    const md = [
      'Once it lands, the follow-on card becomes ready.',
      '',
      '## Acceptance criteria',
      '',
      '- the endpoint returns 200',
      '',
      '## Context refs',
      '',
      '- the published spec at `docs/api.md`',
    ].join('\n');
    expect(firstPostMergeCriterion(md)).toBeNull();
  });

  it('does not fire on a word-boundary near-miss', () => {
    expect(firstPostMergeCriterion(withCriteria('the companion maintainer signs off'))).toBeNull();
    expect(firstPostMergeCriterion(withCriteria('the domain is `mainframe.example`'))).toBeNull();
  });

  it('prose under the heading that is not a bullet is not a criterion', () => {
    const md = ['## Acceptance criteria', '', 'All of these hold once it lands:', ''].join('\n');
    expect(firstPostMergeCriterion(md)).toBeNull();
  });

  it('an empty / null / undefined body yields nothing', () => {
    expect(firstPostMergeCriterion(null)).toBeNull();
    expect(firstPostMergeCriterion(undefined)).toBeNull();
    expect(firstPostMergeCriterion('')).toBeNull();
  });
});

describe("isOrderingCheckExempt — the rule's own remedy, read back as a predicate", () => {
  it("exempts the release trio's CUT leg — `deploy` / `human`, which is DEFINED by needing the merge", () => {
    expect(isOrderingCheckExempt('deploy', 'human')).toBe(true);
    expect(isOrderingCheckExempt('deploy', 'coding_agent')).toBe(true);
    expect(isOrderingCheckExempt('manual', 'human')).toBe(true);
  });

  it('exempts nothing else — an untyped card is not exempt', () => {
    expect(isOrderingCheckExempt('code', 'coding_agent')).toBe(false);
    expect(isOrderingCheckExempt('decision', 'coding_agent')).toBe(false);
    expect(isOrderingCheckExempt(null, null)).toBe(false);
    expect(isOrderingCheckExempt(undefined, undefined)).toBe(false);
  });
});
