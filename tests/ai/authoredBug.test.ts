import { describe, expect, it } from 'vitest';
import {
  AUTHORED_DESCRIPTION_MAX,
  AUTHORED_EXPLANATION_MAX,
  CANDIDATE_MECHANISMS_DISCLAIMER,
  CANDIDATE_MECHANISMS_HEADING,
  InvalidAuthoredBugError,
  UNRESOLVED_REFS_STATEMENT,
  describedForWrite,
  parseAuthoredBug,
} from '@/lib/ai/authoredBug';

// The `author_bug` answer as motir-core accepts it (Story MOTIR-4930 · Subtask
// MOTIR-5851): PARSED, never cast, because the answer is untrusted here too.

const DESCRIPTION = [
  'The CSV export throws `TypeError` from `toCsv`.',
  '',
  '## Acceptance criteria',
  '',
  '- Exporting a board with an empty column succeeds.',
  '',
  '## Context refs',
  '',
  '- `lib/services/exportService.ts`',
].join('\n');

const GOOD = {
  descriptionMd: DESCRIPTION,
  explanationMd: 'Nobody can export a board with an empty column; 17 failures since yesterday.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 45,
  difficulty: 'medium',
  contextRefs: ['lib/services/exportService.ts'],
  candidateMechanisms: [],
  grounded: true,
  groundingReason: 'indexed',
};

describe('parseAuthoredBug', () => {
  it('accepts a well-formed answer, field for field', () => {
    expect(parseAuthoredBug(GOOD)).toEqual(GOOD);
  });

  it.each([
    ['type', 'bugfix'],
    ['executor', 'robot'],
    ['storyPoints', 4],
    ['storyPoints', 8],
    ['difficulty', 'extreme'],
    ['difficulty', 3],
    ['estimateMinutes', 0],
    ['estimateMinutes', 12.5],
    ['estimateMinutes', 100_000],
    ['descriptionMd', ''],
    ['descriptionMd', 'x'.repeat(AUTHORED_DESCRIPTION_MAX + 1)],
    ['explanationMd', '   '],
    ['explanationMd', 'x'.repeat(AUTHORED_EXPLANATION_MAX + 1)],
    ['candidateMechanisms', ['exactly one']],
    ['candidateMechanisms', 'not a list'],
    ['contextRefs', [1]],
    ['grounded', 'yes'],
  ])('refuses %s = %j, naming the field', (field, value) => {
    const run = () => parseAuthoredBug({ ...GOOD, [field]: value });
    expect(run).toThrow(InvalidAuthoredBugError);
    expect(run).toThrow(new RegExp(`at ${field}`));
  });

  it.each(['trivial', 'low', 'medium', 'high'] as const)(
    'accepts difficulty %s and returns it',
    (difficulty) => {
      expect(parseAuthoredBug({ ...GOOD, difficulty }).difficulty).toBe(difficulty);
    },
  );

  it('an ABSENT difficulty validates as null — rollout tolerance for a motir-ai build that predates it', () => {
    const { difficulty: _omit, ...withoutDifficulty } = GOOD;
    void _omit;
    expect(parseAuthoredBug(withoutDifficulty)).toEqual({ ...GOOD, difficulty: null });
  });

  it('an unknown difficulty is refused with the SAME error shape an unknown storyPoints gets', () => {
    const refusal = (field: string, value: unknown) => {
      try {
        parseAuthoredBug({ ...GOOD, [field]: value });
      } catch (err) {
        return err;
      }
      throw new Error(`${field} = ${String(value)} was accepted`);
    };
    const bad = refusal('difficulty', 'extreme') as InvalidAuthoredBugError;
    const points = refusal('storyPoints', 4) as InvalidAuthoredBugError;
    for (const err of [bad, points]) {
      expect(err).toBeInstanceOf(InvalidAuthoredBugError);
      expect(err.code).toBe('INVALID_AUTHORED_BUG');
      expect(err.name).toBe('InvalidAuthoredBugError');
    }
    expect(bad.field).toBe('difficulty');
    expect(bad.message).toBe(
      'author_bug answer refused at difficulty: must be one of trivial | low | medium | high',
    );
    expect(points.message).toBe(
      'author_bug answer refused at storyPoints: must be one of 1 | 2 | 3 | 5',
    );
  });

  it('refuses a description without the two required sections', () => {
    expect(() =>
      parseAuthoredBug({ ...GOOD, descriptionMd: 'Broken.\n\n## Context refs\n\n- a.ts' }),
    ).toThrow(/Acceptance criteria/);
    expect(() =>
      parseAuthoredBug({
        ...GOOD,
        descriptionMd: 'Broken.\n\n## Acceptance criteria\n\nNo bullet here.\n\n## Context refs',
      }),
    ).toThrow(/Acceptance criteria/);
    expect(() =>
      parseAuthoredBug({ ...GOOD, descriptionMd: 'Broken.\n\n## Acceptance criteria\n\n- ok' }),
    ).toThrow(/Context refs/);
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 'answer', 7, []]) {
      expect(() => parseAuthoredBug(raw)).toThrow(InvalidAuthoredBugError);
    }
  });

  it('an unknown grounding reason reads as null rather than refusing the answer', () => {
    expect(parseAuthoredBug({ ...GOOD, groundingReason: 'mystery' }).groundingReason).toBeNull();
  });
});

describe('describedForWrite — the two statements are guaranteed, never doubled', () => {
  it('a well-formed grounded answer with no mechanisms is written unchanged', () => {
    expect(describedForWrite(parseAuthoredBug(GOOD))).toBe(DESCRIPTION);
  });

  it('mechanisms that arrived WITHOUT their heading are folded in above the refs, with the not-established sentence', () => {
    const md = describedForWrite(
      parseAuthoredBug({
        ...GOOD,
        candidateMechanisms: ['The column may be null.', 'The row may be deleted.'],
      }),
    );
    const heading = md.indexOf(CANDIDATE_MECHANISMS_HEADING);
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(md.indexOf('## Context refs'));
    expect(md).toContain(CANDIDATE_MECHANISMS_DISCLAIMER);
    expect(md).toContain('- The column may be null.');
  });

  it('mechanisms that arrived WITH their heading are not added twice', () => {
    const withBlock = DESCRIPTION.replace(
      '## Context refs',
      `${CANDIDATE_MECHANISMS_HEADING}\n\nNone of these is established.\n\n- a\n- b\n\n## Context refs`,
    );
    const md = describedForWrite(
      parseAuthoredBug({ ...GOOD, descriptionMd: withBlock, candidateMechanisms: ['a', 'b'] }),
    );
    expect(md.split(CANDIDATE_MECHANISMS_HEADING)).toHaveLength(2);
  });

  it('an UNGROUNDED answer whose refs section does not say so gets the statement', () => {
    const md = describedForWrite(
      parseAuthoredBug({ ...GOOD, grounded: false, groundingReason: 'not_indexed' }),
    );
    expect(md.slice(md.indexOf('## Context refs'))).toContain(UNRESOLVED_REFS_STATEMENT);
  });

  it('an ungrounded answer that already says so is left alone', () => {
    const said = DESCRIPTION.replace(
      '## Context refs\n',
      "## Context refs\n\n- Context refs could not be resolved: the project's code has not been indexed yet.\n",
    );
    const md = describedForWrite(
      parseAuthoredBug({ ...GOOD, descriptionMd: said, grounded: false }),
    );
    expect(md).toBe(said);
    expect(md).not.toContain(UNRESOLVED_REFS_STATEMENT);
  });
});
