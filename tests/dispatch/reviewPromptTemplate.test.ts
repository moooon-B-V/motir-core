import { describe, expect, it } from 'vitest';
import {
  assembleReviewPrompt,
  capConvention,
  CONVENTION_ABSENT_LINE,
  CONVENTION_SHORTENED_LINE,
  REVIEW_CONVENTION_MAX_CHARS,
  type ReviewPromptInput,
} from '@/lib/dispatch/reviewPromptTemplate';

// THE REVIEW PROMPT's assembler (Story MOTIR-1626 · MOTIR-6821; `hosted-agent-run.md`
// §8.2–§8.4). PURE — so the whole text is pinned by a snapshot, and the properties the card
// names are asserted beside it, so a snapshot update cannot quietly drop one.

const TWO_REPOSITORY_CARD: ReviewPromptInput = {
  key: 'ACME-7',
  title: 'Show the widget count in the header and the API',
  projectName: 'Acme',
  descriptionMd: [
    'The header shows how many widgets the workspace holds, read from the API.',
    '',
    '## Acceptance criteria',
    '',
    '- `GET /api/widgets/count` answers `{ count }`.',
    '- The header renders the count; a zero renders `0`, never blank.',
    '',
    '## Context refs',
    '',
    '- `app/header.tsx` — the header.',
  ].join('\n'),
  explanationMd: 'People keep asking how many widgets they have.',
  howToTestMd: '1. Open `/`.\n2. The header reads **Widgets: 0**.',
  subjectVersion: 'moooon/acme-api#12@aaa111,moooon/acme-web#34@bbb222',
  pullRequests: [
    {
      repository: 'moooon/acme-api',
      number: 12,
      headSha: 'aaa111',
      baseBranch: 'main',
      headBranch: 'subtask/ACME-7-api',
      title: 'The count endpoint',
      url: 'https://github.com/moooon/acme-api/pull/12',
    },
    {
      repository: 'moooon/acme-web',
      number: 34,
      headSha: 'bbb222',
      baseBranch: 'develop',
      headBranch: 'subtask/ACME-7-web',
      title: 'The header count',
      url: 'https://github.com/moooon/acme-web/pull/34',
    },
  ],
};

describe('assembleReviewPrompt', () => {
  it('a two-repository card: both PRs at their reviewed heads, criteria, How to test, limits, verdict', () => {
    const { prompt } = assembleReviewPrompt(TWO_REPOSITORY_CARD);
    expect(prompt).toMatchSnapshot();

    // The card — both bodies, the criteria under their own heading (not twice).
    expect(prompt).toContain('The header shows how many widgets the workspace holds');
    expect(prompt).toContain('People keep asking how many widgets they have.');
    expect(prompt).toContain('ACCEPTANCE CRITERIA');
    expect(prompt.match(/`GET \/api\/widgets\/count` answers/g)).toHaveLength(1);
    expect(prompt).toContain('The header reads **Widgets: 0**.');
    // ONE review over both pull requests, each at its reviewed head and its own base.
    expect(prompt).toContain('2 pull requests, ONE review over all of them');
    expect(prompt).toContain('moooon/acme-api #12');
    expect(prompt).toContain('reviewed head: aaa111');
    expect(prompt).toContain('git diff origin/main...aaa111');
    expect(prompt).toContain('moooon/acme-web #34');
    expect(prompt).toContain('reviewed head: bbb222');
    expect(prompt).toContain('git diff origin/develop...bbb222');
    // Read-only.
    expect(prompt).toContain('Push NOTHING');
    expect(prompt).toContain('Post NOTHING to GitHub');
    // The verdict's exact shape, naming the version back.
    expect(prompt).toContain('POST /api/v1/work-items/ACME-7/agent-review');
    expect(prompt).toContain(
      '"subjectVersion": "moooon/acme-api#12@aaa111,moooon/acme-web#34@bbb222"',
    );
    expect(prompt).toContain('"verdict": "pass" | "changes_requested"');
    expect(prompt).toContain('at most 500 characters');
    expect(prompt).toContain('FILE and LINE');
    // No convention file named unconditionally (§8.5 is MOTIR-6904's).
    expect(prompt).not.toMatch(/CLAUDE\.md|AGENTS\.md/);
  });

  it('is deterministic', () => {
    expect(assembleReviewPrompt(TWO_REPOSITORY_CARD)).toEqual(
      assembleReviewPrompt(TWO_REPOSITORY_CARD),
    );
  });

  it('says so, rather than inventing, when the card has no criteria and no How to test', () => {
    const { prompt } = assembleReviewPrompt({
      ...TWO_REPOSITORY_CARD,
      descriptionMd: null,
      explanationMd: null,
      howToTestMd: null,
      subjectVersion: 'moooon/acme-api#12@aaa111',
      pullRequests: [{ ...TWO_REPOSITORY_CARD.pullRequests[0]!, baseBranch: null }],
    });
    expect(prompt).toContain('(The card has no description.)');
    expect(prompt).toContain('(The card names none.');
    expect(prompt).toContain('Do not treat its absence as a finding.');
    expect(prompt).toContain('THE CODE — one pull request');
    expect(prompt).toContain('git diff origin/<its base branch>...aaa111');
  });

  it('renders no CODING CONVENTIONS section when no conventions are passed', () => {
    const { prompt } = assembleReviewPrompt({ ...TWO_REPOSITORY_CARD, conventions: [] });
    expect(prompt).toBe(assembleReviewPrompt(TWO_REPOSITORY_CARD).prompt);
    expect(prompt).not.toContain('CODING CONVENTIONS');
  });
});

// THE CODING CONVENTIONS (MOTIR-6904; `hosted-agent-run.md` §8.5).
describe('assembleReviewPrompt — CODING CONVENTIONS', () => {
  const WITH_CONVENTIONS: ReviewPromptInput = {
    ...TWO_REPOSITORY_CARD,
    conventions: [
      {
        repoKey: 'moooon/acme-api',
        state: 'present',
        version: 3,
        contentMd: '# House rules\n\n- Route → Service → Repository.\n- Errors are typed.',
      },
      { repoKey: 'moooon/acme-web', state: 'absent' },
    ],
  };

  it('a two-repository card, one present and one absent: both entries and the instruction block', () => {
    const { prompt } = assembleReviewPrompt(WITH_CONVENTIONS);
    expect(prompt).toMatchSnapshot();

    expect(prompt).toContain('CODING CONVENTIONS');
    expect(prompt).toContain("moooon/acme-api — Motir's coding convention, version 3");
    expect(prompt).toContain('    - Route → Service → Repository.');
    expect(prompt).toContain(`  moooon/acme-web\n    ${CONVENTION_ABSENT_LINE}`);
    // The instruction block.
    expect(prompt).toContain('standard for the code the pull request CHANGES');
    expect(prompt).toContain('QUOTES the rule it breaks');
    expect(prompt).toContain('the card wins');
    expect(prompt).toContain('Code the pull request did not touch is never a finding.');
    expect(prompt).toContain(
      'A missing convention is never a reason to return `changes_requested`.',
    );
    // After the code, before HOW TO REVIEW.
    const at = prompt.indexOf('CODING CONVENTIONS');
    expect(at).toBeGreaterThan(prompt.indexOf('reviewed head: bbb222'));
    expect(at).toBeLessThan(prompt.indexOf('HOW TO REVIEW'));
    // No UNCONDITIONAL CLAUDE.md / AGENTS.md line: every mention is the conditional one.
    const mentions = prompt.split('\n').filter((line) => /CLAUDE\.md|AGENTS\.md/.test(line));
    expect(mentions).toEqual([
      '  - If a repository’s checkout has a CLAUDE.md or AGENTS.md at its root, read it as',
    ]);
  });

  it('is deterministic with conventions', () => {
    expect(assembleReviewPrompt(WITH_CONVENTIONS)).toEqual(assembleReviewPrompt(WITH_CONVENTIONS));
  });

  it('a convention AT the cap is rendered whole', () => {
    // 119 lines of 100 characters (99 + newline) = 11 900, then a 100-character last line.
    const exact = `${Array.from({ length: 119 }, () => 'x'.repeat(99)).join('\n')}\n${'y'.repeat(100)}`;
    expect(exact).toHaveLength(REVIEW_CONVENTION_MAX_CHARS);
    expect(capConvention(exact)).toEqual({ text: exact, shortened: false });
  });

  it('a convention ONE character over the cap is cut at the last line boundary under it', () => {
    // 119 lines of 100 characters (99 + newline) = 11 900, then a 101-character last line:
    // 12 001 characters in all.
    const body = Array.from(
      { length: 119 },
      (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(96)}`,
    );
    const over = `${body.join('\n')}\n${'z'.repeat(101)}`;
    expect(over).toHaveLength(REVIEW_CONVENTION_MAX_CHARS + 1);

    const { text, shortened } = capConvention(over);
    expect(shortened).toBe(true);
    expect(text).toBe(`${body.join('\n')}\n${CONVENTION_SHORTENED_LINE}`);
    expect(text).not.toContain('z');

    const { prompt } = assembleReviewPrompt({
      ...TWO_REPOSITORY_CARD,
      conventions: [{ repoKey: 'moooon/acme-api', state: 'present', version: 1, contentMd: over }],
    });
    expect(prompt).toContain(`    ${CONVENTION_SHORTENED_LINE}`);
    expect(prompt).toContain('Code Health, /code');
    expect(prompt).not.toContain('zzz');
  });
});
