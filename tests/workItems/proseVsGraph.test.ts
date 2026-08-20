import { describe, expect, it } from 'vitest';
import {
  ESTIMATION_GATE_ESTIMATE_MINUTES,
  ESTIMATION_GATE_STORY_POINTS,
  MAX_SUBSUMPTION_QUERY_PATHS,
  POST_MERGE_CRITERION_PHRASES,
  SUBSUMPTION_EXEMPT_PHRASES,
  acceptanceCriteriaSpan,
  bodyFilePaths,
  bodyReferenceSeverities,
  criterionRepoPaths,
  firstPostMergeCriterion,
  firstRepoStraddleCriterion,
  hasCriterionPathTokens,
  isOrderingCheckExempt,
  isSubsumptionCheckExempt,
  overGateSizing,
  resolvePathRepo,
  selfBlockingDesignCriteria,
  type RepoCandidate,
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

// ─────────────────────────────────────────────────────────────────────────────
// THE REPO-STRADDLE CHECK (MOTIR-2177) — gate 1's repo column, mechanized as a
// CONTRADICTION rather than a count.
// ─────────────────────────────────────────────────────────────────────────────

/** The workspace's connected repos, in the shape the resolver takes. */
const REPOS: RepoCandidate[] = [
  { name: 'motir-core', repoRef: 'moooon-B-V/motir-core' },
  { name: 'motir-ai', repoRef: 'moooon-B-V/motir-ai' },
  { name: 'motir-gateway', repoRef: 'moooon-B-V/motir-gateway' },
];

describe('resolvePathRepo — a path-like token to a repo NAME', () => {
  it('resolves the BARE-NAME form from the first segment', () => {
    expect(resolvePathRepo('motir-ai/src/services/codeRepoService.ts', REPOS)).toBe('motir-ai');
    expect(resolvePathRepo('motir-core/lib/dto/workItems.ts', REPOS)).toBe('motir-core');
  });

  it('resolves the `owner/name` form from the first TWO segments', () => {
    expect(resolvePathRepo('moooon-B-V/motir-ai/src/index.ts', REPOS)).toBe('motir-ai');
    // `owner/name` with no path after it is still the repo.
    expect(resolvePathRepo('moooon-B-V/motir-gateway', REPOS)).toBe('motir-gateway');
  });

  it('matches case-insensitively and returns the CANDIDATE casing', () => {
    // A git host's repo names are case-insensitive, so a criterion that
    // capitalizes differently names the same checkout — but the value the
    // finding reports must be the one `targetRepo` stores, or the two disagree.
    expect(resolvePathRepo('MOTIR-AI/src/x.ts', REPOS)).toBe('motir-ai');
    expect(resolvePathRepo('moooon-b-v/Motir-Core/lib/x.ts', REPOS)).toBe('motir-core');
  });

  it('prefers the `owner/name` reading over a bare first segment that collides', () => {
    const colliding: RepoCandidate[] = [
      { name: 'motir-core', repoRef: 'acme/motir-core' },
      { name: 'acme', repoRef: 'other/acme' },
    ];
    expect(resolvePathRepo('acme/motir-core/lib/x.ts', colliding)).toBe('motir-core');
  });

  it('a token that resolves to NOTHING is body text — null, never an error', () => {
    expect(resolvePathRepo('packages/cli/src/index.ts', REPOS)).toBeNull();
    expect(resolvePathRepo('docs/decisions/code-graph.md', REPOS)).toBeNull();
    expect(resolvePathRepo('https://ghcr.io/token', REPOS)).toBeNull();
    expect(resolvePathRepo('and/or', REPOS)).toBeNull();
  });

  it('a token with NO slash is null even when it exactly NAMES a repo', () => {
    // The bare-SYMBOL form this check does not cover — see the module note.
    // Treating it as a path would fire on every card that says "motir-ai".
    expect(resolvePathRepo('motir-ai', REPOS)).toBeNull();
    expect(resolvePathRepo('SHARED_PLANNING_RULES', REPOS)).toBeNull();
  });

  it('an EMPTY candidate set resolves nothing', () => {
    expect(resolvePathRepo('motir-ai/src/x.ts', [])).toBeNull();
  });
});

describe('criterionRepoPaths — the repo column, per criterion', () => {
  it('attributes each path to its criterion and drops unresolvable ones', () => {
    const md = withCriteria(
      'the DTO in `lib/dto/workItems.ts` gains a field',
      'the mirror in `motir-ai/src/planning/rules.ts` reads it',
      'the docs at `docs/decisions/x.md` are updated',
      'the gateway path `motir-gateway/relay/billing/ratio/model.go` is untouched',
    );
    expect(criterionRepoPaths(md, REPOS)).toEqual([
      { path: 'motir-ai/src/planning/rules.ts', repo: 'motir-ai', criterionIndex: 2 },
      {
        path: 'motir-gateway/relay/billing/ratio/model.go',
        repo: 'motir-gateway',
        criterionIndex: 4,
      },
    ]);
  });

  it('scans the AC span ONLY — a path in the narrative or Context refs is not a criterion', () => {
    const md = [
      'This card touches `motir-ai/src/planner.ts` conceptually.',
      '',
      '## Acceptance criteria',
      '',
      '- the route returns 200',
      '',
      '## Context refs',
      '',
      '- `motir-ai/src/services/x.ts` — the consumer',
    ].join('\n');
    expect(criterionRepoPaths(md, REPOS)).toEqual([]);
  });

  it('attributes a path on a CONTINUATION line to the bullet it wraps from', () => {
    const md = [
      '## Acceptance criteria',
      '',
      '- the first criterion',
      '- the second criterion, whose deliverable is',
      '  `motir-ai/src/x.ts`',
    ].join('\n');
    expect(criterionRepoPaths(md, REPOS)).toEqual([
      { path: 'motir-ai/src/x.ts', repo: 'motir-ai', criterionIndex: 2 },
    ]);
  });

  it('yields nothing for an empty body, a body with no AC heading, or no candidates', () => {
    expect(criterionRepoPaths(null, REPOS)).toEqual([]);
    expect(criterionRepoPaths('', REPOS)).toEqual([]);
    expect(criterionRepoPaths('Prose naming `motir-ai/src/x.ts`.', REPOS)).toEqual([]);
    expect(criterionRepoPaths(withCriteria('`motir-ai/src/x.ts` changes'), [])).toEqual([]);
  });
});

describe('hasCriterionPathTokens — the pre-check that saves the repo read', () => {
  it('is TRUE when a criterion carries any path-like token, resolvable or not', () => {
    // Deliberately over-inclusive: it cannot know which prefixes resolve, and
    // its only job is deciding whether the connected-repo read is worth making.
    expect(hasCriterionPathTokens(withCriteria('`docs/decisions/x.md` is written'))).toBe(true);
    expect(hasCriterionPathTokens(withCriteria('`motir-ai/src/x.ts` changes'))).toBe(true);
  });

  it('is FALSE for a body with no path in its criteria', () => {
    expect(hasCriterionPathTokens(withCriteria('the endpoint returns 200'))).toBe(false);
    expect(hasCriterionPathTokens('Prose naming `motir-ai/src/x.ts` and no AC heading.')).toBe(
      false,
    );
    expect(hasCriterionPathTokens(null)).toBe(false);
    expect(hasCriterionPathTokens('')).toBe(false);
  });

  it('does not carry regex state between calls', () => {
    // A `g`-flagged regex reused across `test()` calls advances `lastIndex` and
    // returns false every other time. The guard is a separate non-global copy.
    const md = withCriteria('`motir-ai/src/x.ts` changes');
    expect([1, 2, 3, 4].map(() => hasCriterionPathTokens(md))).toEqual([true, true, true, true]);
  });
});

describe('firstRepoStraddleCriterion — gate 1, as a CONTRADICTION', () => {
  it('MOTIR-2162 REGRESSION: pinned motir-core, criteria naming motir-ai — names the FIRST', () => {
    // The shape MOTIR-2164 recorded: the card pinned `motir-core` while two of
    // its criteria were discharged in `motir-ai`.
    const md = withCriteria(
      '`motir-core/docs/decisions/code-graph-index-fleet.md` gains an offboarding section.',
      "`motir-ai/src/services/codeRepoService.ts`'s header block points at the decision.",
      '`motir-ai/tests/codeRepoService.test.ts` covers the new branch.',
    );
    expect(firstRepoStraddleCriterion(md, ['motir-core'], REPOS)).toEqual({
      path: 'motir-ai/src/services/codeRepoService.ts',
      repo: 'motir-ai',
      criterionIndex: 2,
      reason: 'contradiction',
    });
  });

  it('does NOT fire when every resolvable path is in the PINNED repo', () => {
    const md = withCriteria(
      '`motir-core/lib/workItems/proseVsGraph.ts` exports the resolver',
      '`motir-core/tests/workItems/proseVsGraph.test.ts` covers both forms',
      'the docs at `docs/decisions/x.md` are untouched',
    );
    expect(firstRepoStraddleCriterion(md, ['motir-core'], REPOS)).toBeNull();
  });

  it('compares the pin case-insensitively', () => {
    const md = withCriteria('`MOTIR-CORE/lib/x.ts` changes');
    expect(firstRepoStraddleCriterion(md, ['motir-core'], REPOS)).toBeNull();
  });

  it('UNPINNED with two or more distinct repos fires with the `unpinnable` reason', () => {
    // Gate 1: "`targetRepo: null` on a card whose deliverables you can ENUMERATE
    // is not 'not yet pinned': check whether it is UNPINNABLE." The reported
    // path is where the SECOND repo enters — the point the split becomes visible.
    const md = withCriteria(
      '`motir-core/lib/services/x.ts` submits the job',
      '`motir-core/tests/x.test.ts` covers it',
      '`motir-ai/src/jobs/x.ts` executes it',
    );
    expect(firstRepoStraddleCriterion(md, [], REPOS)).toEqual({
      path: 'motir-ai/src/jobs/x.ts',
      repo: 'motir-ai',
      criterionIndex: 3,
      reason: 'unpinnable',
    });
  });

  it('UNPINNED with exactly ONE repo emits nothing — that card is merely unpinned', () => {
    const md = withCriteria(
      '`motir-core/lib/services/x.ts` changes',
      '`motir-core/tests/x.test.ts` covers it',
    );
    expect(firstRepoStraddleCriterion(md, [], REPOS)).toBeNull();
  });

  it('a BOUNDARY-CONTRACT card DOES fire — an ACCEPTED false positive, recorded here', () => {
    // A producer plus its mirrored consumer is legitimately ONE card shipping
    // TWO coordinated PRs (`plan-rules.md`, the two-PRs-one-card rule), and this
    // check cannot tell it from a straddle: both name two repos in the criteria.
    //
    // The behaviour is a DECISION, not a gap — the advisory never blocks, the
    // shape is rare, and one line of output is the whole cost. It is also why
    // this check is the first to withdraw if advisory fatigue shows. This test
    // exists so that a future reader finds the trade-off written down instead of
    // discovering it as a surprise and "fixing" it.
    const md = withCriteria(
      '`motir-core/lib/dto/planning.ts` gains the producer field',
      'the consumer mirror in `motir-ai/src/contracts/planning.ts` reads it defensively, so ' +
        'either merge order is safe',
    );
    expect(firstRepoStraddleCriterion(md, ['motir-core'], REPOS)).toEqual({
      path: 'motir-ai/src/contracts/planning.ts',
      repo: 'motir-ai',
      criterionIndex: 2,
      reason: 'contradiction',
    });
  });

  it('the BARE-SYMBOL tell is invisible — MOTIR-1983 would NOT be caught', () => {
    // The other stated blind spot, pinned as behaviour: MOTIR-1983's whole
    // self-declaration was `SHARED_PLANNING_RULES` (a motir-ai symbol) inside a
    // parenthetical. Mapping a symbol to a repo needs an index this check does
    // not have; gate 1's prose remains the only cover for it.
    const md = withCriteria(
      "a repeat-defect trigger is added to `plan-rules.md`'s per-card gate checklist " +
        '(and mirrored into `SHARED_PLANNING_RULES` — a planning RULE has two homes)',
    );
    expect(firstRepoStraddleCriterion(md, ['motir-core'], REPOS)).toBeNull();
  });

  it('emits nothing with no candidates, no AC heading, or an empty body', () => {
    const md = withCriteria('`motir-ai/src/x.ts` changes');
    expect(firstRepoStraddleCriterion(md, ['motir-core'], [])).toBeNull();
    expect(firstRepoStraddleCriterion('Prose only.', ['motir-core'], REPOS)).toBeNull();
    expect(firstRepoStraddleCriterion(null, ['motir-core'], REPOS)).toBeNull();
    expect(firstRepoStraddleCriterion('', [], REPOS)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SUBSUMPTION CHECK's pure half (MOTIR-2903) — which paths a body names,
// and whether the card has opted out.
// ─────────────────────────────────────────────────────────────────────────────

describe('bodyFilePaths — the paths a card names', () => {
  it('scans the WHOLE body, not the acceptance criteria — the canonical fixture depends on it', () => {
    // MOTIR-2757's shape, reduced: the only path in its acceptance-criteria span
    // is a test file with no commits since it was filed, while the path the
    // sweep actually took sits in its CONTEXT REFS. An AC-scoped scan returns
    // the wrong one, which is the measurement that made criterion 2's original
    // "every path its acceptance criteria name" fire on nothing.
    const md = [
      "`workflowsService`'s three read methods read on the `db` singleton.",
      '',
      '## Acceptance criteria',
      '',
      '- `tests/permissions/userlessTenantRead.test.ts` covers the bound path.',
      '',
      '## Context refs',
      '',
      '- `lib/services/workflowsService.ts` — the read surface.',
    ].join('\n');

    expect(bodyFilePaths(md)).toEqual([
      'tests/permissions/userlessTenantRead.test.ts',
      'lib/services/workflowsService.ts',
    ]);
  });

  it('keeps document order, dedupes, and strips backticks and a trailing line reference', () => {
    const md = [
      'See `docs/rls-runtime-role-inventory.md:274` and, 245 lines later,',
      '`docs/rls-runtime-role-inventory.md:519` — one file, both halves.',
      'The channel is **lib/services/proseGraphAdvisoryService.ts**.',
    ].join('\n');

    expect(bodyFilePaths(md)).toEqual([
      'docs/rls-runtime-role-inventory.md',
      'lib/services/proseGraphAdvisoryService.ts',
    ]);
  });

  it('drops a token whose last segment has no extension — URLs and bare owner/repo pairs', () => {
    // These are the shapes that make a naive "two segments and a slash" rule
    // useless: every card in this corpus links a pull request and names a repo.
    const md = [
      'Filed as https://github.com/moooon-B-V/motir-meta/pull/211, published to',
      'https://app.motir.co/api/mcp, in the moooon-B-V/motir-core repo.',
      'The registry probe is `https://ghcr.io/token?scope=repository:x/y:pull`.',
      'The one real path is `lib/db.ts`.',
    ].join('\n');

    expect(bodyFilePaths(md)).toEqual(['lib/db.ts']);
  });

  it('keeps a path that ends a sentence, where the token regex swallows the full stop', () => {
    expect(bodyFilePaths('The change lands in `lib/github/pullRequestFiles.ts`.')).toEqual([
      'lib/github/pullRequestFiles.ts',
    ]);
  });

  it('caps at MAX_SUBSUMPTION_QUERY_PATHS and takes the FIRST ones in document order', () => {
    const md = Array.from(
      { length: MAX_SUBSUMPTION_QUERY_PATHS + 25 },
      (_, i) => `- \`lib/generated/f-${i}.ts\``,
    ).join('\n');
    const paths = bodyFilePaths(md);

    expect(paths).toHaveLength(MAX_SUBSUMPTION_QUERY_PATHS);
    expect(paths[0]).toBe('lib/generated/f-0.ts');
    expect(paths.at(-1)).toBe(`lib/generated/f-${MAX_SUBSUMPTION_QUERY_PATHS - 1}.ts`);
  });

  it('returns nothing for an empty, null or path-free body', () => {
    expect(bodyFilePaths(null)).toEqual([]);
    expect(bodyFilePaths('')).toEqual([]);
    expect(bodyFilePaths('Prose with no path in it at all.')).toEqual([]);
  });
});

describe('isSubsumptionCheckExempt — the named opt-out (criterion 5)', () => {
  it('exempts a card that DECLARES itself a boundary contract, in any of the pinned phrasings', () => {
    for (const phrase of SUBSUMPTION_EXEMPT_PHRASES) {
      expect(isSubsumptionCheckExempt(`This is a ${phrase} card: producer plus mirror.`)).toBe(
        true,
      );
    }
  });

  it('is case- and wrap-insensitive, because the corpus writes it both ways', () => {
    expect(isSubsumptionCheckExempt('A Boundary\nContract card.')).toBe(true);
    expect(isSubsumptionCheckExempt('TWO-PRS-ONE-CARD, deliberately.')).toBe(true);
  });

  it('does NOT exempt a card that merely shares paths with a sibling — silence is not an exclusion', () => {
    // The rule this pins is `run.md`'s: an absent edge and a considered
    // exclusion are the same absent edge, so the only honest mute is an
    // assertion the author writes down.
    const md = [
      'This card and MOTIR-9999 both touch `lib/services/x.ts`.',
      '',
      '## Acceptance criteria',
      '',
      '- The service is bound.',
    ].join('\n');

    expect(isSubsumptionCheckExempt(md)).toBe(false);
    expect(isSubsumptionCheckExempt(null)).toBe(false);
    expect(isSubsumptionCheckExempt('')).toBe(false);
  });

  it('does not fire on a phrase embedded in a longer word', () => {
    expect(isSubsumptionCheckExempt('the boundary contracts of the module')).toBe(false);
  });
});

describe('overGateSizing — THE ESTIMATION GATE, as two integers and an enum', () => {
  /** A card the gate has nothing to say about, so each case varies ONE thing. */
  const rightSized = {
    executor: 'coding_agent',
    hasChildren: false,
    storyPoints: 3,
    estimateMinutes: 45,
  } as const;

  it('says nothing about a right-sized card — the direction that can go quiet', () => {
    // Listed first deliberately: a check is only worth having if it is silent on
    // the ordinary card, and a guard whose negative branch was never observed is
    // a tautology.
    expect(overGateSizing(rightSized)).toBeNull();
  });

  it('reports the POINTS ceiling on its own, AT the threshold and not below it', () => {
    expect(overGateSizing({ ...rightSized, storyPoints: ESTIMATION_GATE_STORY_POINTS })).toEqual({
      threshold: 'story_points',
      storyPoints: 13,
      estimateMinutes: 45,
    });
    // 13 is the SPLIT SIGNAL itself, so the comparison is `>=`. The value below
    // it is the largest legal size and must stay silent.
    expect(
      overGateSizing({ ...rightSized, storyPoints: ESTIMATION_GATE_STORY_POINTS - 1 }),
    ).toBeNull();
  });

  it('reports the MINUTES ceiling on its own, ABOVE it and not on it', () => {
    expect(
      overGateSizing({ ...rightSized, estimateMinutes: ESTIMATION_GATE_ESTIMATE_MINUTES + 1 }),
    ).toEqual({ threshold: 'estimate_minutes', storyPoints: 3, estimateMinutes: 61 });
    // 60 is the CEILING — "must be ≤ 60 minutes" — so a card sitting exactly on
    // it is inside the gate. The two thresholds are deliberately not the same
    // comparison, and this pins which is which.
    expect(
      overGateSizing({ ...rightSized, estimateMinutes: ESTIMATION_GATE_ESTIMATE_MINUTES }),
    ).toBeNull();
  });

  it('a card over BOTH is ONE finding that names both — MOTIR-3068, verbatim', () => {
    // The fixture the whole check exists for: `storyPoints: 13`,
    // `estimateMinutes: 600`, `executor: coding_agent`, childless — which
    // `validate_work_item` answered `valid: true` with nothing in `advisories`
    // (`notes.html` #323, the FOURTH prose discharge of this gate).
    expect(overGateSizing({ ...rightSized, storyPoints: 13, estimateMinutes: 600 })).toEqual({
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    });
  });

  it('EXEMPTS a human executor — its minutes are human work, not agent run time', () => {
    expect(
      overGateSizing({ ...rightSized, executor: 'human', storyPoints: 13, estimateMinutes: 600 }),
    ).toBeNull();
    // A `manual` card takes `executor: 'human'` from the type→executor default
    // map, so testing the executor covers the type; an untyped card carrying no
    // executor at all is not yet subject to the rule, so it is silent too.
    expect(
      overGateSizing({ ...rightSized, executor: null, storyPoints: 13, estimateMinutes: 600 }),
    ).toBeNull();
    expect(overGateSizing({ ...rightSized, executor: undefined, storyPoints: 21 })).toBeNull();
  });

  it('EXEMPTS a card with children, whatever its own columns hold', () => {
    // POSITION, not kind: a container is sized by rollup, so its own columns
    // describe a subtree rather than a run. The mirror case — a childless `bug`
    // — is the MOTIR-3068 fixture above, and it fires.
    expect(
      overGateSizing({ ...rightSized, hasChildren: true, storyPoints: 13, estimateMinutes: 600 }),
    ).toBeNull();
  });

  it('treats an unestimated column as unestimated, never as zero or as over', () => {
    // The gate's "every leaf MUST carry a non-null estimate" limb is a DIFFERENT
    // finding this check deliberately does not make: a null crosses no ceiling,
    // and it must not suppress the other column either.
    expect(overGateSizing({ ...rightSized, storyPoints: null, estimateMinutes: null })).toBeNull();
    expect(overGateSizing({ ...rightSized, storyPoints: null, estimateMinutes: 600 })).toEqual({
      threshold: 'estimate_minutes',
      storyPoints: null,
      estimateMinutes: 600,
    });
    expect(overGateSizing({ ...rightSized, storyPoints: 13, estimateMinutes: null })).toEqual({
      threshold: 'story_points',
      storyPoints: 13,
      estimateMinutes: null,
    });
  });

  it('pins the two thresholds against the gate the planner writes down', () => {
    // A drift guard in the same spirit as POST_MERGE_CRITERION_PHRASES' — these
    // two numbers are quoted from `plan-rules/kind-leaf-deepen.md` (the `13+`
    // split signal, the ≤ 60-minute run ceiling), so a silent edit here is a red
    // test rather than a check that quietly stops matching the rule.
    expect(ESTIMATION_GATE_STORY_POINTS).toBe(13);
    expect(ESTIMATION_GATE_ESTIMATE_MINUTES).toBe(60);
  });
});

describe('selfBlockingDesignCriteria — a card that is its OWN design blocker (MOTIR-3178)', () => {
  /**
   * The FIXTURE, and it is a **RECONSTRUCTION** — labelled as one here because it
   * cannot be anything else.
   *
   * MOTIR-3158 asked for MOTIR-3154's criteria set "as authored on 2026-08-19 —
   * the seven-criterion leaf". That text no longer exists anywhere and cannot be
   * quoted: `get_work_item_activity` records a `descriptionMd` edit at
   * 2026-08-19T20:53:52.716Z (its re-plan's `modify`, fifteen minutes after
   * MOTIR-3158 was filed), and the tenant retains no prior body — activity parts
   * carry `from`/`to` for `status`, `priority` and links only. `notes.html` #329
   * and the `motir run MOTIR-3154` comment both PARAPHRASE criteria 1 / 4 / 5;
   * neither quotes the set.
   *
   * So this is rebuilt from the table in MOTIR-3178's own body, which is its
   * durable source. It is SYNTHETIC on purpose — it consumes nothing MOTIR-3154
   * produces, so it cannot rot when that card is re-scoped again.
   */
  const RECONSTRUCTED_MOTIR_3154 = [
    '## Acceptance criteria',
    '',
    '1. a `design/ai-planning/` three-file amendment — the accepted and declined node',
    '   treatments, plus an explicit re-decision of what the plan-detail canvas pane holds',
    '   after approve',
    '2. decline no longer deletes the proposal rows',
    '3. approve leaves the pane on the plan rather than handing it to the establish step',
    '4. the plan-detail canvas draws a DECIDED plan — one node per approved `add`, in the',
    '   treatment the design decides',
    '5. the planning-workspace canvas KEEPS its decided overlay',
  ].join('\n');

  it('fires on the reconstructed MOTIR-3154 set, naming criteria 1 and 4', () => {
    // The whole finding in one assertion: criterion 1's deliverable is the
    // drawing, criterion 4's is the surface built against it, and they are on one
    // card. `readiness.ready` was `true`, `openBlockers` `[]` and
    // `validate_work_item` `valid: true` on exactly this shape.
    expect(selfBlockingDesignCriteria(RECONSTRUCTED_MOTIR_3154)).toEqual({
      designCriterionIndex: 1,
      surfaceCriterionIndex: 4,
    });
  });

  it('says nothing when the criteria name a DESIGN ASSET only — the quiet direction', () => {
    // A pure design card: it draws, and nothing here builds. This is the ordinary
    // `type: design` subtask the gate WANTS, so silence is the correct answer and
    // is asserted rather than assumed.
    const designOnly = [
      '## Acceptance criteria',
      '',
      '1. `design/ai-planning/plan-canvas.mock.html` is built from the real design system',
      '2. `design/ai-planning/design-notes.md` names the composing primitives and the access path',
      '3. the same-basename `.png` export is regenerated from the mock',
    ].join('\n');
    expect(selfBlockingDesignCriteria(designOnly)).toBeNull();
  });

  it('says nothing when the criteria name a RENDERED SURFACE only — the other quiet direction', () => {
    // The ordinary UI code card: it builds against a drawing somebody else
    // approved. Nothing here produces an asset, so there is no inversion.
    const surfaceOnly = [
      '## Acceptance criteria',
      '',
      '1. the plan-detail canvas draws one node per approved `add`',
      '2. `app/(authed)/plans/[id]/page.tsx` renders the decided overlay',
      '3. the empty state shows the establish prompt',
    ].join('\n');
    expect(selfBlockingDesignCriteria(surfaceOnly)).toBeNull();
  });

  it('says nothing on a design card that describes what its OWN drawing shows — the near-miss', () => {
    // The false positive the predicate must not have, and the reason a
    // design-asset criterion is NEVER also read as the surface criterion: a
    // drawing's whole job is to describe a surface, so a `design` card's criteria
    // are full of surface nouns and render verbs. Both roles landing on the SAME
    // criterion is one card doing one thing.
    const nearMiss = [
      '## Acceptance criteria',
      '',
      '1. `design/ai-planning/design-notes.md` records the accepted and declined treatments',
      '2. the `design/ai-planning/plan-canvas.png` export shows the canvas with a decided plan',
      '   and the picker open',
    ].join('\n');
    expect(selfBlockingDesignCriteria(nearMiss)).toBeNull();
  });

  it('attributes a wrapped criterion to the bullet it wraps from, like the other two checks', () => {
    // Same attribution contract as `firstPostMergeCriterion` /
    // `criterionRepoPaths`, so a card carrying several findings can be read
    // against ONE numbering. Here the asset path is on the bullet and the surface
    // clause is two lines below its own.
    const wrapped = [
      '## Acceptance criteria',
      '',
      '- a `design/work-items/detail.mock.html` amendment covering the relationships panel,',
      '  with its `design-notes.md` naming the primitives',
      '- the detail route renders that panel',
      '  in the treatment the drawing decides',
    ].join('\n');
    expect(selfBlockingDesignCriteria(wrapped)).toEqual({
      designCriterionIndex: 1,
      surfaceCriterionIndex: 2,
    });
  });

  it('reads the ACCEPTANCE-CRITERIA span only, and degrades to silence without one', () => {
    // The same heuristic contract `firstPostMergeCriterion` has, and the same
    // inversion: no AC heading means nothing is emitted, because both phrases are
    // perfectly legitimate in a body's narrative. A card's explanation saying "we
    // will amend design/x/ and then the panel renders it" is describing a plan,
    // not asking to be closed against one.
    const noHeading = [
      'The card amends `design/ai-planning/design-notes.md`.',
      '',
      '- and then the canvas renders the decided plan',
    ].join('\n');
    expect(selfBlockingDesignCriteria(noHeading)).toBeNull();
    expect(selfBlockingDesignCriteria(null)).toBeNull();
    expect(selfBlockingDesignCriteria('')).toBeNull();
  });

  it('does not read the word "design" as a design ASSET — consuming a drawing is the other half', () => {
    // The tell is the shape of the DELIVERABLE, never the word. A criterion
    // saying "in the treatment the design decides" is the CONSUMER; reading it as
    // a producer would make every well-written UI card its own design blocker.
    const consumesOnly = [
      '## Acceptance criteria',
      '',
      '1. the design system primitives are reused rather than hand-rolled',
      '2. the plan-detail canvas draws the decided plan in the treatment the design decides',
    ].join('\n');
    expect(selfBlockingDesignCriteria(consumesOnly)).toBeNull();
  });

  it('reports the FIRST criterion of each role when several qualify', () => {
    const many = [
      '## Acceptance criteria',
      '',
      '1. the service returns the projected rows',
      '2. `design/ai-planning/design-notes.md` records the node treatments',
      '3. `design/ai-planning/plan-canvas.mock.html` is built from the real design system',
      '4. the plan-detail canvas draws one node per approved `add`',
      '5. the planning-workspace canvas renders the decided overlay',
    ].join('\n');
    expect(selfBlockingDesignCriteria(many)).toEqual({
      designCriterionIndex: 2,
      surfaceCriterionIndex: 4,
    });
  });
});
