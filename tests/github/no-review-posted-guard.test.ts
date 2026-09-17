import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ONE-DIRECTIONAL — MOTIR POSTS NO REVIEW TO GITHUB (Story MOTIR-4910 · MOTIR-5600;
// `docs/decisions/approval-gates.md` § 8 FOURTH AMENDMENT, decision 9).
//
// The sync reads GitHub's reviews and writes NOTHING back. That is a product promise about
// somebody else's repository — a customer's review history is theirs, and a Motir press is
// not a review by the person whose installation token Motir holds.
//
// ⚠️ IT IS ASSERTED BY AN ABSENCE, WHICH IS WHY IT NEEDS A GUARD AT ALL. Every other rule in
// this story has a row, a status or a rendered string to assert. This one has none: the way
// it breaks is that somebody ADDS a call, and nothing anywhere goes red. A structural scan
// over the tree is the only thing that can fail on that.
//
// This is the STATIC half. The runtime half — a synced approval making zero requests to any
// `/reviews` path while its merge requests ARE made — lives in the story gate, because it
// needs a MockAgent and a database.

const ROOTS = ['lib', 'app'] as const;

/**
 * The ways a review gets POSTED to GitHub, as a caller would actually write them.
 *
 * REST is the pull-request reviews collection; Octokit spells the same thing two ways. The
 * patterns are deliberately about the CALL rather than the noun: `pulls/{n}/reviews` appears
 * in this very file and in the fixtures, and a guard that fired on the word would be
 * un-greenable without weakening it.
 */
const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  {
    // A REST write to the reviews collection — `POST .../pulls/123/reviews`, however the URL
    // is assembled, as long as the method and the path are in the same statement.
    pattern: /method:\s*['"]POST['"][\s\S]{0,400}?\/pulls\/[^'"`\s]*\/reviews/,
    what: 'a POST to a pull request’s reviews collection',
  },
  {
    pattern: /\/pulls\/[^'"`\s]*\/reviews[\s\S]{0,400}?method:\s*['"]POST['"]/,
    what: 'a POST to a pull request’s reviews collection',
  },
  { pattern: /pulls\.createReview\b/, what: 'octokit `pulls.createReview`' },
  { pattern: /pulls\.submitReview\b/, what: 'octokit `pulls.submitReview`' },
  { pattern: /pulls\.createReviewComment\b/, what: 'octokit `pulls.createReviewComment`' },
  { pattern: /pulls\.dismissReview\b/, what: 'octokit `pulls.dismissReview`' },
];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(full)) out.push(full);
    }
  };
  walk(join(process.cwd(), root));
  return out;
}

describe('Motir posts NO review to GitHub (MOTIR-5600, decision 9)', () => {
  it('finds no review-posting call anywhere in lib/ or app/', () => {
    const offences: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, 'utf8');
        for (const { pattern, what } of FORBIDDEN) {
          if (pattern.test(source)) {
            offences.push(`${relative(process.cwd(), file)} — ${what}`);
          }
        }
      }
    }

    expect(
      offences,
      'Motir must never write into a customer’s review history ' +
        '(`docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 9). ' +
        'The GitHub review sync is one-directional: it READS reviews and writes nothing back. ' +
        'If a new feature genuinely needs to post one, that is an amendment to the record ' +
        'before it is a line of code.',
    ).toEqual([]);
  });

  it('WOULD FAIL on a module that posts one — the guard is proven, not assumed', () => {
    // ⚠️ THE SELF-CHECK. A scan enforced at zero is indistinguishable from a scan whose
    // patterns match nothing, and the second one passes for ever while the rule rots. So the
    // patterns are run against source that SHOULD trip them, in memory — nothing is written
    // to the tree, because a scratch file under `lib/` would make the test above red for
    // everyone else the moment it raced.
    const wouldOffend = [
      `await octokit.pulls.createReview({ owner, repo, pull_number: 7, event: 'APPROVE' });`,
      `await fetch(url, { method: 'POST' }); // ${'/repos/o/n/pulls/7/reviews'}`,
      `await githubFetch(\`\${GITHUB_API}/repos/\${owner}/\${name}/pulls/\${number}/reviews\`, {
         method: 'POST',
       });`,
    ];

    for (const sample of wouldOffend) {
      expect(
        FORBIDDEN.some(({ pattern }) => pattern.test(sample)),
        `the guard did not catch: ${sample}`,
      ).toBe(true);
    }

    // And it does NOT fire on the reads the sync legitimately makes.
    const legitimate = [
      `const res = await fetch(\`\${GITHUB_API}/repos/\${owner}/\${repo}/collaborators/\${username}/permission\`);`,
      `await octokit.pulls.get({ owner, repo, pull_number });`,
      `method: 'PUT', // the merge`,
    ];
    for (const sample of legitimate) {
      expect(
        FORBIDDEN.some(({ pattern }) => pattern.test(sample)),
        `the guard wrongly fired on: ${sample}`,
      ).toBe(false);
    }
  });
});
