import { describe, expect, it } from 'vitest';
import { assembleReviewPrompt, type ReviewPromptInput } from '@/lib/dispatch/reviewPromptTemplate';

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

  it('joins MOTIR-6904’s convention block verbatim after the code, and nothing when absent', () => {
    const block = 'CODING CONVENTIONS\n\n  moooon/acme-web: components are function components.';
    const withBlock = assembleReviewPrompt({
      ...TWO_REPOSITORY_CARD,
      conventionSection: block,
    }).prompt;
    expect(withBlock).toContain(block);
    expect(withBlock.indexOf(block)).toBeGreaterThan(withBlock.indexOf('reviewed head: bbb222'));
    expect(withBlock.indexOf(block)).toBeLessThan(withBlock.indexOf('HOW TO REVIEW'));
    expect(assembleReviewPrompt(TWO_REPOSITORY_CARD).prompt).not.toContain('CODING CONVENTIONS');
  });
});
