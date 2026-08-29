import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3770 — THE CI FEEDBACK COMMENT REACHES EVERY DELIVERED CARD
// (`docs/decisions/ci-feedback-comment-per-card.md`).
//
// ── Why this file exists beside `githubCiFeedback.test.ts` ────────────────────
// That file is MOTIR-894 + MOTIR-2946's: it fixes the comment's identity at
// `(change request, head sha)` and every one of its fixtures links ONE card, so
// every assertion in it passes whether the comment reaches one delivered card or
// all of them. The defect lives entirely at N > 1, which is the shape
// `link_pull_request`'s delivery SET made ordinary (`motir auto`, and any sweep
// finishing two cards) — so it needs fixtures that link TWO.
//
// ⚠️ AND THE HEADLINE ASSERTION IS *EDITED IN PLACE, ALL OF THEM* (AC 2), not
// merely *posted, all of them*. Posting N comments is what a naive array column
// buys; keeping N LIVE ids so each later conclusion at the same commit rewrites
// its own is the property the storage was chosen for, and the one a dangling id
// silently loses. The deletion case (AC 3) is the same property from the other
// side: the id must be live or it must be GONE, never stale.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-per-card';
const REPO_PROVIDER_ID = '9413';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function openPr(number: number, headRef: string) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      // Names NOTHING. The association is the LINK (MOTIR-3674).
      title: 'A sweep',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

async function makeCard(s: Scenario, title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  return item;
}

/** `link_pull_request`'s own service door — one call PER (card, pull request),
 *  which is exactly what a `motir auto` run makes for each card of its run. */
async function link(s: Scenario, workItemId: string, opts: { number: number; headRef: string }) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: s.project.id,
      owner: 'moooon',
      name: 'motir-core',
      number: opts.number,
      headRef: opts.headRef,
      baseRef: 'main',
      title: null,
    },
    s.ctx,
  );
}

const ci = (opts: {
  conclusion: string | null;
  status?: string;
  headSha: string;
  prNumbers: number[];
  name?: string;
}) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name ?? 'build',
      check_suite: { head_branch: null },
      pull_requests: opts.prNumbers.map((n) => ({ number: n })),
    },
  });

async function commentsOn(workItemId: string) {
  return adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a terminal conclusion comments on EVERY delivered card (MOTIR-3770 AC 1)', () => {
  const BRANCH = 'motir/auto-run-91';

  it('posts the feedback comment on BOTH cards of a two-card delivery', async () => {
    const s = await makeScenario('two-cards@example.com');
    const cards = [await makeCard(s, 'card one'), await makeCard(s, 'card two')];
    await openPr(901, BRANCH);
    for (const card of cards) await link(s, card.id, { number: 901, headRef: BRANCH });

    const res = await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [901] });
    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });

    // The defect, as an assertion: BEFORE this card the second element of this
    // loop was an empty array while its `ciState` read `passing`.
    for (const card of cards) {
      const comments = await commentsOn(card.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.bodyMd).toContain('CI passing');
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
      expect(row.ciState).toBe('passing');
    }

    // One row per (change request, head commit, card) — the coordinate the
    // superseded scalar could not carry.
    const recorded = await adminDb.githubCiFeedbackComment.findMany({
      where: { commitSha: 'sha-a' },
    });
    expect(recorded).toHaveLength(2);
    expect(new Set(recorded.map((r) => r.workItemId))).toEqual(new Set(cards.map((c) => c.id)));
  });

  it('EDITS every one of them in place on a later conclusion at the SAME head sha (AC 2)', async () => {
    // The property a scalar cannot express and a dangling-id array silently
    // loses: N ids, all live, each rewritten by the next verdict at this commit.
    const s = await makeScenario('edit-both@example.com');
    const cards = [await makeCard(s, 'card one'), await makeCard(s, 'card two')];
    await openPr(902, BRANCH);
    for (const card of cards) await link(s, card.id, { number: 902, headRef: BRANCH });

    await ci({ conclusion: 'success', headSha: 'sha-b', prNumbers: [902], name: 'lint' });
    const first = await Promise.all(cards.map((c) => commentsOn(c.id)));
    expect(first.map((cs) => cs.length)).toEqual([1, 1]);

    // A SECOND check at the same commit concludes red. The aggregate over the
    // commit's set is now failing, and both comments must say so.
    const res = await ci({
      conclusion: 'failure',
      headSha: 'sha-b',
      prNumbers: [902],
      name: 'e2e',
    });
    expect(res).toMatchObject({ outcome: 'failed', ciState: 'failing' });

    for (const [i, card] of cards.entries()) {
      const after = await commentsOn(card.id);
      expect(after).toHaveLength(1); // edited, NOT a second comment
      expect(after[0]!.id).toBe(first[i]![0]!.id);
      expect(after[0]!.bodyMd).toContain('CI failed');
      expect(after[0]!.bodyMd).toContain('`e2e`');
    }
  });

  it('keeps the comment KEY unchanged — many checks at one commit, one comment per card; a NEW commit starts its own (AC 4)', async () => {
    // MOTIR-2946's ~34-comments-per-item defect stays fixed at N cards: the key
    // gained a coordinate, it did not get finer in the ones it already had.
    const s = await makeScenario('key-unchanged@example.com');
    const cards = [await makeCard(s, 'card one'), await makeCard(s, 'card two')];
    await openPr(903, BRANCH);
    for (const card of cards) await link(s, card.id, { number: 903, headRef: BRANCH });

    for (const name of ['lint', 'build', 'typecheck', 'vitest', 'e2e']) {
      await ci({ conclusion: 'success', headSha: 'sha-c', prNumbers: [903], name });
    }
    for (const card of cards) {
      const comments = await commentsOn(card.id);
      expect(comments).toHaveLength(1); // 5 checks → 1 comment, per card
      expect(comments[0]!.bodyMd).toBe(
        '✅ **CI passing** — all 5 checks succeeded on the linked pull request. This work is verified.',
      );
    }

    // A new head commit is a new comment — per card, as it always was per change
    // request.
    await ci({ conclusion: 'failure', headSha: 'sha-d', prNumbers: [903], name: 'lint' });
    for (const card of cards) {
      const bodies = (await commentsOn(card.id)).map((c) => c.bodyMd);
      expect(bodies).toHaveLength(2);
      expect(bodies.filter((b) => b.includes('CI passing'))).toHaveLength(1);
      expect(bodies.filter((b) => b.includes('CI failed'))).toHaveLength(1);
    }
  });
});

describe('a DELETED comment does not turn the next delivery into a throw (MOTIR-3770 AC 3)', () => {
  const BRANCH = 'motir/auto-run-92';

  it('cascades the recorded id away and posts a fresh comment, while the sibling is edited', async () => {
    // The argument against the rejected `text[]` shape, as a fixture. The ids this
    // path edits must be LIVE: a person deleting a feedback comment must take its
    // record with it, or the next terminal conclusion throws INSIDE the delivery's
    // transaction and the host retries that webhook for ever.
    const s = await makeScenario('deleted@example.com');
    const cards = [await makeCard(s, 'card one'), await makeCard(s, 'card two')];
    await openPr(904, BRANCH);
    for (const card of cards) await link(s, card.id, { number: 904, headRef: BRANCH });

    await ci({ conclusion: 'success', headSha: 'sha-e', prNumbers: [904], name: 'lint' });
    const [firstBefore, secondBefore] = await Promise.all(cards.map((c) => commentsOn(c.id)));
    expect(await adminDb.githubCiFeedbackComment.count({ where: { commitSha: 'sha-e' } })).toBe(2);

    // A person deletes the FIRST card's comment.
    await adminDb.comment.delete({ where: { id: firstBefore![0]!.id } });

    // The record goes with it (FK cascade), and nothing else held the id: the
    // superseded `github_check_run.feedback_comment_id` mirror was retired by
    // MOTIR-3863, so there is no second place for a stale one to survive. The
    // check ROWS are untouched — this cascade is about the comment, not the check.
    expect(await adminDb.githubCiFeedbackComment.count({ where: { commitSha: 'sha-e' } })).toBe(1);
    const checkRows = await adminDb.githubCheckRun.findMany({ where: { commitSha: 'sha-e' } });
    expect(checkRows.length).toBeGreaterThan(0);

    // A later conclusion at the SAME commit RESOLVES rather than throwing.
    const res = await ci({
      conclusion: 'failure',
      headSha: 'sha-e',
      prNumbers: [904],
      name: 'e2e',
    });
    expect(res).toMatchObject({ outcome: 'failed', ciState: 'failing' });

    // Card one gets a FRESH comment (the deleted one is gone, so it has exactly
    // one again); card two's is edited in place.
    const firstAfter = await commentsOn(cards[0]!.id);
    expect(firstAfter).toHaveLength(1);
    expect(firstAfter[0]!.id).not.toBe(firstBefore![0]!.id);
    expect(firstAfter[0]!.bodyMd).toContain('CI failed');

    const secondAfter = await commentsOn(cards[1]!.id);
    expect(secondAfter).toHaveLength(1);
    expect(secondAfter[0]!.id).toBe(secondBefore![0]!.id);
    expect(secondAfter[0]!.bodyMd).toContain('CI failed');
  });
});

describe('a ONE-card delivery is unchanged, and a session pull request still comments on nothing (MOTIR-3770 AC 5)', () => {
  it('posts exactly one comment, and NO LONGER writes the legacy mirror column', async () => {
    // ⚠️ THIS ASSERTION IS INVERTED FROM WHAT IT SAID UNTIL MOTIR-3863, AND THE
    // INVERSION IS THE CARD. The mirror existed for an instance running the
    // PREVIOUS build during the EXPAND's deploy window: left null, that instance
    // found no comment and opened a SECOND one on a card this build had just
    // commented on. MOTIR-3818 verified the EXPAND is on every machine, so no
    // such instance exists — and the column is now written by nothing, which is
    // the precondition MOTIR-3803 needs before it may drop it.
    const s = await makeScenario('one-card@example.com');
    const card = await makeCard(s, 'the only card');
    await openPr(905, 'subtask/MOTIR-1-solo');
    await link(s, card.id, { number: 905, headRef: 'subtask/MOTIR-1-solo' });

    await ci({ conclusion: 'success', headSha: 'sha-f', prNumbers: [905] });

    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(1);
    const rows = await adminDb.githubCheckRun.findMany({ where: { commitSha: 'sha-f' } });
    expect(rows).toHaveLength(1);
    // ⚠️ THE MIRROR IS GONE ENTIRELY (MOTIR-3803). This used to raw-SELECT
    // `github_check_run.feedback_comment_id` and assert the delivery left it
    // NULL — the property the SCHEMA-ONLY phase needed before the column could be
    // dropped. The CONTRACT phase has since dropped it, so the strongest form of
    // that assertion is now that the column does not exist at all: nothing can
    // hold a second, stale answer because there is no longer anywhere to hold one.
    const mirror = await adminDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'github_check_run'
        AND column_name = 'feedback_comment_id'
    `;
    expect(mirror).toEqual([]);
    expect(
      await adminDb.githubCiFeedbackComment.findMany({ where: { commitSha: 'sha-f' } }),
    ).toMatchObject([{ workItemId: card.id, commentId: comments[0]!.id }]);
  });

  it('no longer ADOPTS off the legacy column — with no per-card record it posts a fresh comment', async () => {
    // ⚠️ ALSO INVERTED BY MOTIR-3863, and this is the last reader the card moved.
    // The fallback existed for a `(change request, head commit)` whose first
    // verdict was written by a build that had only the scalar. That population is
    // closed from both ends: the EXPAND migration BACKFILLED every such row into
    // `github_ci_feedback_comment` (reading the card off the COMMENT, not off a
    // link column), and MOTIR-3818 verified the per-card build is on every
    // machine, so no instance writes the column any more either.
    //
    // The fixture strips the per-card row — which no longer models anything that
    // can happen, and is now simply "the record is missing". The behaviour that
    // follows is the SAME one the deleted-comment case above produces: a fresh
    // comment. That is the cost of the retirement, stated as an assertion rather
    // than left to be discovered: `github_ci_feedback_comment` is now the only
    // record, so losing a row loses the comment's identity.
    const s = await makeScenario('adopt@example.com');
    const card = await makeCard(s, 'the only card');
    await openPr(906, 'subtask/MOTIR-2-solo');
    await link(s, card.id, { number: 906, headRef: 'subtask/MOTIR-2-solo' });

    await ci({ conclusion: 'success', headSha: 'sha-g', prNumbers: [906], name: 'lint' });
    const before = await commentsOn(card.id);
    expect(before).toHaveLength(1);
    await adminDb.githubCiFeedbackComment.deleteMany({ where: { commitSha: 'sha-g' } });

    const res = await ci({
      conclusion: 'failure',
      headSha: 'sha-g',
      prNumbers: [906],
      name: 'e2e',
    });
    expect(res).toMatchObject({ outcome: 'failed' });

    const after = await commentsOn(card.id);
    expect(after).toHaveLength(2); // a FRESH comment — the fallback is gone
    expect(after.map((c) => c.id)).toContain(before[0]!.id);
    expect(after[1]!.id).not.toBe(before[0]!.id);
    expect(after[1]!.bodyMd).toContain('CI failed');
    // …and the fresh one is recorded, so the next conclusion edits it in place.
    expect(
      await adminDb.githubCiFeedbackComment.findMany({ where: { commitSha: 'sha-g' } }),
    ).toMatchObject([{ workItemId: card.id, commentId: after[1]!.id }]);
  });

  it('a SESSION pull request still posts none — its cards are reached by the promotion', async () => {
    const s = await makeScenario('session@example.com');
    const card = await makeCard(s, 'on the branch');
    const branch = 'motir/session-run-7';
    await openPr(907, branch);
    // No link. The card is joined to the pull request only by its session branch,
    // which is the arm that carries no cards for the COMMENT to hang on.
    await adminDb.workItem.update({ where: { id: card.id }, data: { sessionBranch: branch } });

    const res = await ci({ conclusion: 'success', headSha: 'sha-h', prNumbers: [907] });
    expect(res).toMatchObject({ outcome: 'no_work_item' });

    expect(await commentsOn(card.id)).toHaveLength(0);
    expect(await adminDb.githubCiFeedbackComment.count({ where: { commitSha: 'sha-h' } })).toBe(0);
  });
});
