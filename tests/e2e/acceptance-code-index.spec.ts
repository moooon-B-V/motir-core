// ACCEPTANCE RECEIPT — the BYOK code-index loop (Story MOTIR-1754 · MOTIR-1771).
//
// ⚠️ THIS IS A RECEIPT, NOT A REGRESSION TEST, and the two are not reasoned
// about the same way (`docs/decisions/acceptance-receipt-lifecycle.md`). It
// exists to record ONE watchable run of the story working, which a person then
// approves. Its regression twin is `code-index-freshness.spec.ts`, which drives
// the same states as seven independent cases in the bulk lane and is where a
// future assertion belongs.
//
// So this file is paced for a HUMAN, not for test speed. The twin does the whole
// story in seventeen seconds across seven sign-ups; a run that flashes through
// six states is not a receipt anyone can review.
//
// ⚠️ WHAT THE VIEWER IS BEING ASKED TO BELIEVE. The story's promise is not a
// feature — it is that a SILENT degradation became visible. A plan built without
// the code looks exactly like one built with it, and every chapter below is one
// state a person could previously not tell apart from another:
//
//   · a repository with no graph vs. one with a stale graph — both used to
//     answer every tool call identically;
//   · a graph that is behind vs. one that is behind AND NOT COMING BACK — the
//     difference that sat only in a dead-letter queue nobody reads;
//   · and, throughout, that none of it GATES planning. The story ships a signal,
//     not a lock, which is the one thing a viewer should watch for.
//
// ⚠️ NOTHING ABOUT THE VERDICT IS STUBBED. MOTIR-4724 moved every freshness fact
// into motir-core's own columns, so each state below is reached by seeding those
// columns and letting the shipped derivation run. The card planned to intercept
// motir-ai's status route; there is no such route to intercept any more, which
// makes this a stronger receipt than it was written to be.

import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import {
  E2E_INDEX_REPOS,
  indexRepoRef,
  recordIndexSucceeded,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const REPO = E2E_INDEX_REPOS[0]!;
const REPO_REF = indexRepoRef(REPO);
const EMAIL = 'acceptance-code-index@example.com';

/**
 * The planning workspace, by the locator the overlay's own acceptance spec uses.
 *
 * ⚠️ IT OPENS AS A DIALOG ON A HOST PAGE, which is why "planning proceeds" is
 * asserted on this and not on a heading: `/planning` redirects to
 * `<host>?plan=…` and the workspace mounts over it, so the page's own `h1`
 * belongs to the host and says nothing about whether planning is available.
 */
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('the code index speaks: connected → indexed → stale after a push → not updating', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // ⚠️ WITHOUT THIS THE CLIP CANNOT BE PUBLISHED TO THE STORY AT ALL. It names
  // the story the receipt belongs to, and the server resolves a subtask key up
  // to its story — so it is the STORY that is named here, not this card.
  acceptanceStory('MOTIR-1754');

  await signUp(page, EMAIL);
  const local = EMAIL.split('@')[0]!;
  const user = await db.user.findFirstOrThrow({ where: { email: EMAIL } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });

  const rows = page.getByRole('list', { name: /repositories this project/i });

  await chapter('The project has no code, and the Codebase room says so', async () => {
    // The state every project starts in. It is NOT a failure and the copy does
    // not read as one — it names where a repository is configured.
    await page.goto('/code');
    await expect(page.getByRole('heading', { name: 'Codebase', level: 1 })).toBeVisible();
    await expect(page.getByText('No repositories yet')).toBeVisible();
    await beat();
  });

  await chapter('Planning proceeds anyway — the story ships a signal, not a lock', async () => {
    // ⚠️ THE ASSERTION THE WHOLE STORY TURNS ON, and it is shown FIRST so a
    // viewer meets it before the warnings rather than after. Every state that
    // follows degrades what a session KNOWS; none of them may stop it planning.
    // A pause that silently withheld the graph would re-create the code-blind
    // failure this story exists to end.
    //
    // ⚠️ THE WORKSPACE DIALOG, NOT AN `h1`. `/planning` is a pure REDIRECT
    // (MOTIR-4732's forward for old links) — it has no heading of its own and
    // forwards to a host page with the planning overlay opened on it. Asserting
    // a level-1 heading here passed by accident against whatever the forward
    // landed on, and stopped passing the moment the project had a repository and
    // the overlay had a verdict to resolve first.
    await page.goto('/planning');
    await expect(workspace(page)).toBeVisible();
    await beat();
  });

  // Connect a repository, and give the project its first graph.
  await seedConnectedRepos(ws.id, [REPO]);
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: ws.id, owner: REPO.owner, name: REPO.name },
  });
  const created = await projectRepoSetService.addRow(
    project.id,
    { role: 'web', name: REPO.name },
    { userId: user.id, workspaceId: ws.id },
  );
  await adminDb.projectRepo.update({
    where: { id: created.id },
    data: { githubRepoId: repo.id },
  });

  await chapter('Connected, but never indexed — its own state, not "stale"', async () => {
    // ⚠️ THE FIRST THING A PERSON COULD NOT PREVIOUSLY TELL APART. A repository
    // with no graph and one with an out-of-date graph both answered every tool
    // call. Conflating them here would tell somebody to wait for a rebuild of
    // something that was never built.
    await adminDb.githubRepo.update({
      where: { id: repo.id },
      data: { indexedHeadSha: 'a1b2c3d', defaultBranchHeadSha: 'e4f5a6b' },
    });
    await page.goto('/code');
    await expect(rows.getByText(REPO_REF)).toBeVisible();
    await expect(rows.getByText('Never indexed')).toBeVisible();
    await beat();
  });

  await chapter('The graph is built, and the row reads Indexed', async () => {
    // ⚠️ `Indexed`, NOT `Current` — and the difference is a real population
    // rather than a pedantic one. `Current` would claim the graph MATCHES your
    // code; `Indexed` claims only that a graph exists and nothing has said it is
    // behind. A repository nobody pushes never acquires a head sha at all, and
    // would have claimed currency for ever.
    await recordIndexSucceeded(ws.id, REPO_REF);
    await adminDb.githubRepo.update({
      where: { id: repo.id },
      data: { indexedHeadSha: 'a1b2c3d', defaultBranchHeadSha: 'a1b2c3d' },
    });
    await page.goto('/code');
    await expect(rows.getByText('Indexed')).toBeVisible();
    await expect(rows.getByText(/commits behind/)).toHaveCount(0);
    await beat();
  });

  await chapter('Somebody pushes, and the row says how far behind — in COMMITS', async () => {
    // ⚠️ DRIFT, NEVER AN AGE, and the two disagree about the answer. A graph
    // built three weeks ago on a repository nobody has pushed to is CURRENT; one
    // built two hours ago on a repository that took 300 commits since is badly
    // stale. An age-led verdict gets both of those backwards.
    await adminDb.githubRepo.update({
      where: { id: repo.id },
      data: {
        defaultBranchHeadSha: 'e4f5a6b',
        commitsBehind: 312,
        commitsBehindBaseSha: 'a1b2c3d',
        commitsBehindHeadSha: 'e4f5a6b',
      },
    });
    await page.goto('/code');
    await expect(rows.getByText('Stale')).toBeVisible();
    await expect(rows.getByText('312 commits behind')).toBeVisible();
    await beat();
  });

  await chapter('And when the refresh is DEAD, it stops promising to fix itself', async () => {
    // ⚠️ THE STATE THIS STORY WAS SPLIT OUT FOR (MOTIR-2105). A stale graph
    // whose refresh dead-lettered and one with a refresh merely queued were the
    // same thing to every product surface — both `Stale`, both still answering,
    // and only one of them ever getting better. 35 dead-letters accumulated over
    // 48 hours and nobody noticed, because the one surface that knew was a
    // job-runs tab where that volume reads as background.
    //
    // The copy PROMISES NOTHING: no "catching up", no "shortly", no "check
    // back". A refresh can be paused, failing, or impossible for the provider,
    // so a stale repository may sit stale for ever.
    const dead = await adminDb.jobRun.create({
      data: {
        workspaceId: ws.id,
        functionId: 'system.code-graph-refresh',
        eventName: 'code-graph/index.requested',
        eventId: `evt-dead-${Date.now()}`,
        lane: 'inngest',
        attempt: 1,
        status: 'failed',
      },
    });
    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { indexingRunId: dead.id } });

    await page.goto('/code');
    await expect(rows.getByText('This index is not updating.')).toBeVisible();
    await expect(page.getByText(/catching up|shortly|check back|will resolve/i)).toHaveCount(0);
    await beat();
  });

  await chapter('Planning still proceeds — nothing here was ever a gate', async () => {
    // The bookend, and the reason it is worth two chapters: the viewer has just
    // watched five warnings appear, and the thing to be convinced of is that not
    // one of them stopped the product working.
    await page.goto('/planning');
    await expect(workspace(page)).toBeVisible();
    await beat();
  });
});
