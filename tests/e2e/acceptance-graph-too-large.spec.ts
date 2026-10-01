// ACCEPTANCE RECEIPT — a repository whose graph is too large (Story MOTIR-7092 ·
// MOTIR-7134).
//
// ⚠️ THIS IS A RECEIPT, NOT A REGRESSION TEST
// (`docs/decisions/acceptance-receipt-lifecycle.md`). It records ONE watchable
// run of the story's verification recipe — arrive at /code, read why the
// repository stopped updating, see it return to normal — paced for a person to
// read. Its regression twin is `graph-too-large.spec.ts`, which drives every
// state (the drift beside it, never indexed, planning unblocked, Chinese) as
// independent cases in the bulk lane, and is where a future assertion belongs.
//
// ⚠️ WHAT THE VIEWER IS BEING ASKED TO BELIEVE. Before this story a repository
// that had outgrown Motir looked exactly like any other dead refresh: `Stale`,
// "This index is not updating.", and nothing a person could act on. The receipt
// shows the one sentence that replaces it — the size, the limit, and the change
// in their own repository that brings it back — and that the line clears itself
// once the repository indexes again.
//
// ⚠️ NOTHING ABOUT THE VERDICT IS STUBBED: the state is the real
// `GithubRepo.indexRefused*` columns MOTIR-7130's settle writes, rendered by the
// shipped row. Recovery makes the two writes an indexed run makes (the ledger row
// and `settleIndexingRepo`'s settle + clear) — see the twin's header for why the
// card's `recordIndexSucceeded` alone is not that.

import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  E2E_INDEX_REPOS,
  indexRepoRef,
  recordIndexSucceeded,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const REPO = E2E_INDEX_REPOS[0]!;
const REPO_REF = indexRepoRef(REPO);
const EMAIL = 'acceptance-graph-too-large@example.com';
const GIB = 1024 ** 3;

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

const rows = (page: Page) => page.getByRole('list', { name: /repositories this project/i });
const repoRow = (page: Page) => rows(page).getByRole('listitem').filter({ hasText: REPO_REF });

test('a repository too large to index says why on /code, then returns to normal after it indexes', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The STORY the receipt belongs to — the server resolves a subtask key up to it.
  acceptanceStory('MOTIR-7092');

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

  // A connected repository with a graph that has since fallen behind, whose last
  // index was refused for size: what MOTIR-7130 leaves on the row.
  await seedConnectedRepos(ws.id, [REPO]);
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: ws.id, owner: REPO.owner, name: REPO.name },
  });
  const created = await projectRepoSetService.addRow(
    project.id,
    { role: 'web', name: REPO.name },
    { userId: user.id, workspaceId: ws.id },
  );
  await adminDb.projectRepo.update({ where: { id: created.id }, data: { githubRepoId: repo.id } });
  await recordIndexSucceeded(ws.id, REPO_REF);
  const refused = await adminDb.jobRun.create({
    data: {
      workspaceId: ws.id,
      functionId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      eventId: `evt-refused-${Date.now()}`,
      lane: 'inngest',
      attempt: 1,
      status: 'failed',
    },
  });
  await adminDb.githubRepo.update({
    where: { id: repo.id },
    data: {
      indexedHeadSha: 'a1b2c3d',
      defaultBranchHeadSha: 'e4f5a6b',
      indexingRunId: refused.id,
      indexRefusedSizeBytes: BigInt(1_503_238_553),
      indexRefusedCapBytes: BigInt(GIB),
      indexRefusedAt: new Date(),
    },
  });

  await chapter('Open the project’s Codebase page from the sidebar', async () => {
    // The access path the design draws: the one primary Codebase row, which opens
    // on Repositories.
    await page.goto('/dashboard');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Codebase', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Codebase', level: 1 })).toBeVisible();
    await expect(repoRow(page)).toBeVisible();
    await beat();
  });

  await chapter(
    'The row says the graph is too large — the size, the limit, and what to do',
    async () => {
      // ⚠️ ONE warning, the specific one. The refused run also failed, which used
      // to read only as "This index is not updating." — the sentence a person
      // could do nothing with. It is replaced, not joined.
      const row = repoRow(page);
      await expect(
        row.getByText(
          'The last index was refused: the code graph was 1.4 GiB, and the supported maximum is 1 GiB.',
        ),
      ).toBeVisible();
      await expect(
        row.getByText(/Motir keeps planning against the last code graph it indexed\./),
      ).toBeVisible();
      await expect(row.locator('code', { hasText: 'codegraph.json' })).toBeVisible();
      await expect(row.getByText(/or contact Motir\./)).toBeVisible();
      await expect(row.getByText('This index is not updating.')).toHaveCount(0);
      // Long enough to read three sentences.
      await beat();
      await beat();
    },
  );

  await chapter(
    'The repository is brought under the limit and indexes — the row returns to normal',
    async () => {
      // The two writes an indexed run makes: the succeeded ledger row, and the
      // settle that stamps the head and CLEARS the refusal (MOTIR-7130).
      await recordIndexSucceeded(ws.id, REPO_REF);
      await withSystemContext(async (tx) => {
        await githubRepoRepository.markIndexSettled(REPO_REF, { headSha: 'e4f5a6b' }, tx);
        await githubRepoRepository.clearIndexRefusal(REPO_REF, tx);
      });
      await page.reload();
      const row = repoRow(page);
      await expect(row.getByText('Indexed', { exact: true })).toBeVisible();
      await expect(row.getByText(/The last index was refused/)).toHaveCount(0);
      await beat();
    },
  );
});
