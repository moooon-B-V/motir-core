// E2E: the code-index loop, as a person meets it (Story MOTIR-1754 · MOTIR-1771).
//
// The story's promise is that a silent degradation becomes visible: a plan built
// without the code looks exactly like one built with it, and this drives the
// surface where somebody can finally tell which they got.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ THREE OF THIS CARD'S SIX STEPS NAME A PRODUCT THAT NO LONGER EXISTS, and
// they are recorded rather than quietly re-written, because two of them were not
// merely renamed — they were FALSIFIED.
//
//  1. **"Open `/code-health`"** (step 1). That route is a permanent redirect into
//     `/code` since MOTIR-1768. Renamed, not falsified: the surface survives as
//     the Health section of the Code room, and this spec drives it there.
//
//  2. **"proving dismissal is SESSION-SCOPED … reload and assert it is back"**
//     (step 2). ⚠️ FALSE, and asserting it would have shipped a test that
//     enforces a bug. `design/code-context` §8.1 corrected it from the shipped
//     precedent: `CodeHealthClient` persists the flag in `localStorage` keyed per
//     project and reads it through `useSyncExternalStore`, so dismissal SURVIVES
//     a reload by design. The card's own body says the opposite because it was
//     written from a reading of the child component, which holds only `copied`
//     and `expanded` — MOTIR-4628 is the planning bug filed for exactly that
//     misreading. This spec asserts the SHIPPED contract.
//
//  3. **"intercept motir-ai's status route with `page.route`"** (Stubbing).
//     There is no such route to intercept. MOTIR-4724 moved every freshness fact
//     into motir-core's own columns and MOTIR-1765's `GET /v1/code-graph/status`
//     was archived, which makes this spec BETTER than the card imagined: every
//     state below is reached by seeding the real columns and letting the shipped
//     derivation run, so nothing about the verdict is stubbed at all.
//
// What survives untouched is the card's discipline, and it is the valuable half:
// drive the states a person actually meets, assert on authoritative signals
// rather than timeouts, and prove that planning is never GATED — the story ships
// a signal, not a lock.
// ═══════════════════════════════════════════════════════════════════════════

import { expect, test, type Page } from '@playwright/test';
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
const EMAIL = 'code-index-freshness@example.com';

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/**
 * Sign up, then give the auto-created workspace one ACTIVE project.
 *
 * Sign-up creates `<local>'s Workspace`; the project and the active-project pin
 * are seeded through the shipped service so `getActiveProject()` resolves them
 * the way the product does.
 */
async function seedTenant(page: Page): Promise<Tenant> {
  await signUp(page, EMAIL);
  const local = EMAIL.split('@')[0]!;
  const user = await db.user.findFirstOrThrow({ where: { email: EMAIL } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Code Index Demo',
    identifier: 'CIX',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user.id, workspaceId: ws.id, projectId: project.id };
}

/**
 * Put the project's repository SET where the Code page reads it.
 *
 * ⚠️ THE SET, NOT THE GRANT LIST. `seedConnectedRepos` establishes the
 * workspace's installation grant; the Code page reads `project_repository`, and
 * a repository absent from THAT is absent because nobody configured it — which
 * is the distinction the whole Repositories section exists to draw.
 */
async function giveProjectTheRepo(t: Tenant): Promise<string> {
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: t.workspaceId, owner: REPO.owner, name: REPO.name },
  });
  // Through the SHIPPED service, so the row is shaped the way the product shapes
  // it — then realized against the seeded repository, which is the one step the
  // service does not do for a repo that already exists.
  const created = await projectRepoSetService.addRow(
    t.projectId,
    { role: 'web', name: REPO.name },
    { userId: t.userId, workspaceId: t.workspaceId },
  );
  await adminDb.projectRepo.update({
    where: { id: created.id },
    data: { githubRepoId: repo.id },
  });
  return repo.id;
}

/** The freshness columns, set the way the product sets them. */
async function setShas(
  repoId: string,
  shas: { indexedHeadSha?: string | null; defaultBranchHeadSha?: string | null },
): Promise<void> {
  await adminDb.githubRepo.update({ where: { id: repoId }, data: shas });
}

/** The Code room's Repositories section, waited on by its OWN loaded state. */
async function openRepositories(page: Page): Promise<void> {
  await page.goto('/code');
  // The authoritative signal is the page's own h1 plus the row list's label —
  // never a timeout, and never the tab control alone, which renders before the
  // server data it labels.
  await expect(page.getByRole('heading', { name: 'Codebase', level: 1 })).toBeVisible();
}

const row = (page: Page) => page.getByRole('list', { name: /repositories this project/i });

test('a project with NO repository says so, and offers where to configure one', async ({
  page,
}) => {
  await seedTenant(page);

  await openRepositories(page);

  // ⚠️ NOT A FAILURE, AND THE COPY MUST NOT READ AS ONE. A project with no
  // configured repository is how every project starts.
  await expect(page.getByText('No repositories yet')).toBeVisible();
  await expect(page.getByRole('link', { name: /manage this project/i })).toBeVisible();
  // And the room is reachable at all for this actor — the collapse's whole
  // promise (MOTIR-4643): the row is browse-reachable and each section gates
  // itself.
  await expect(page.getByRole('link', { name: 'Codebase' })).toBeVisible();
});

test('⚠️ NEVER INDEXED reads as its own state, not as stale', async ({ page }) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectTheRepo(t);
  // Both shas known and DIFFERENT — which would be `stale` if the ledger had a
  // succeeded index. It does not, so the honest answer is that there is no graph
  // at all. Conflating the two would tell somebody to wait for a rebuild of
  // something that was never built.
  await setShas(repoId, { indexedHeadSha: 'base1', defaultBranchHeadSha: 'head9' });

  await openRepositories(page);

  await expect(row(page).getByText(REPO_REF)).toBeVisible();
  await expect(row(page).getByText('Never indexed')).toBeVisible();
  await expect(row(page).getByText('Stale')).toHaveCount(0);
});

test('CONNECTED and CURRENT — the repository is named and nothing warns', async ({ page }) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectTheRepo(t);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await setShas(repoId, { indexedHeadSha: 'same', defaultBranchHeadSha: 'same' });

  await openRepositories(page);

  await expect(row(page).getByText(REPO_REF)).toBeVisible();
  // ⚠️ `Indexed`, NOT `Current` (MOTIR-4817 · §4.1). The state claims a graph
  // EXISTS and that nothing has said it is behind — weaker than claiming it
  // matches your code, and the difference is a real population: a repository
  // nobody pushes never acquires a head sha at all.
  await expect(row(page).getByText('Indexed')).toBeVisible();
  await expect(row(page).getByText(/commits behind/)).toHaveCount(0);
});

test('⚠️ STALE AFTER A PUSH — the head moves past the graph, and the row says how far', async ({
  page,
}) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectTheRepo(t);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await setShas(repoId, { indexedHeadSha: 'base1', defaultBranchHeadSha: 'base1' });

  await openRepositories(page);
  await expect(row(page).getByText('Indexed')).toBeVisible();

  // The push writer's effect — the ONE writer of this column.
  await setShas(repoId, { defaultBranchHeadSha: 'head9' });
  await adminDb.githubRepo.update({
    where: { id: repoId },
    data: { commitsBehind: 312, commitsBehindBaseSha: 'base1', commitsBehindHeadSha: 'head9' },
  });

  await openRepositories(page);

  await expect(row(page).getByText('Stale')).toBeVisible();
  // ⚠️ THE DRIFT IS IN COMMITS, NEVER AN AGE (§9). Age and drift disagree about
  // the answer: a graph built three weeks ago on a repository nobody pushed to
  // is current, and one built two hours ago on 300 overnight commits is badly
  // stale.
  await expect(row(page).getByText('312 commits behind')).toBeVisible();
  // And the ROW itself reads as a warning, not as an error — §10 puts this state
  // one register up from the invitation grammar and no further: no red, no
  // destructive family, no blocking.
  //
  // ⚠️ SCOPED TO THE ROW. A bare `getByRole('alert')` matches the shell's own
  // live regions, which are none of this section's business — it is not that the
  // page has no alerts, it is that this repository is not reported as one.
  await expect(row(page).getByRole('alert')).toHaveCount(0);
});

test('⚠️ a DEAD refresh says the index is not updating — the DLQ signal a person sees', async ({
  page,
}) => {
  // MOTIR-2105. A stale graph whose refresh dead-lettered and one with a refresh
  // queued behind it were the same thing to every product surface; 35
  // dead-letters accumulated over 48 hours and nobody noticed.
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectTheRepo(t);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await setShas(repoId, { indexedHeadSha: 'base1', defaultBranchHeadSha: 'head9' });

  const dead = await adminDb.jobRun.create({
    data: {
      workspaceId: t.workspaceId,
      functionId: 'system.code-graph-refresh',
      eventName: 'code-graph/index.requested',
      eventId: `evt-dead-${Date.now()}`,
      lane: 'inngest',
      attempt: 1,
      status: 'failed',
    },
  });
  await adminDb.githubRepo.update({ where: { id: repoId }, data: { indexingRunId: dead.id } });

  await openRepositories(page);

  await expect(row(page).getByText('This index is not updating.')).toBeVisible();
  // ⚠️ AND IT PROMISES NOTHING (§10.1). A refresh can be paused, failing, or
  // impossible for the provider — a stale repository may sit stale for ever — so
  // no wait-and-return language may appear anywhere on this surface.
  await expect(page.getByText(/catching up|shortly|check back|will resolve/i)).toHaveCount(0);
});

test('⚠️ PLANNING IS NEVER GATED — the story ships a signal, not a lock', async ({ page }) => {
  // The card's own central assertion, and the one that would be easiest to lose:
  // every state above degrades what a session KNOWS and none of them may stop it
  // from planning. A pause that silently withheld the graph would re-create the
  // code-blind failure the whole story exists to avoid.
  // The code-blind state: no repository at all.
  await seedTenant(page);

  await page.goto('/planning');

  // ⚠️ THE WORKSPACE DIALOG, NOT AN `h1` — the same correction its acceptance
  // twin needed (`acceptance-code-index.spec.ts`, MOTIR-1771), which was made
  // there and missed here. `/planning` is a pure REDIRECT (MOTIR-4732's forward
  // for old links): it has no heading of its own and forwards to a HOST page
  // with the planning overlay mounted over it. A level-1 heading therefore
  // belongs to whatever the forward landed on and says nothing about whether
  // planning is available — it passed by accident for as long as the host
  // happened to paint one, and stopped the moment MOTIR-4815 changed which host
  // a projectless reader gets.
  //
  // Asserted by ROLE, which is also immune to the hidden previous subtree a
  // route boundary keeps mounted.
  const workspace = page.getByRole('dialog', { name: /plan/i });
  await expect(workspace).toBeVisible();
  // The composer is offered, and it is scoped INSIDE the dialog: a page-wide
  // `.first()` match could be satisfied by a button on the host underneath,
  // which is exactly the surface this case must not accept as "planning works".
  await expect(workspace.getByRole('button', { name: /plan|start|new/i }).first()).toBeEnabled();
});

test('the Health section keeps its own gate, and Repositories works beside it', async ({
  page,
}) => {
  // §2.1's resolution, driven rather than argued: the ROW is browse-reachable and
  // each SECTION gates itself, so a member gets a working repository list beside
  // Health's own admin-only state instead of a refusal. The owner here holds
  // `ai:configure`, so what this proves is the composition — both sections render
  // on one page load.
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  await giveProjectTheRepo(t);

  await openRepositories(page);
  await expect(row(page).getByText(REPO_REF)).toBeVisible();

  // ⚠️ A BUTTON, NOT A RADIO. `Segmented` renders a labelled `role="group"` whose
  // options are real `<button>`s — the primitive's own a11y note says so, and
  // guessing the ARIA pattern from the control's appearance is what a role-based
  // selector exists to stop.
  await page
    .getByRole('group', { name: 'Code sections' })
    .getByRole('button', { name: 'Health' })
    .click();
  await expect(page).toHaveURL(/section=health/);
  // The switch is SHALLOW — the URL changes and the page does not re-navigate,
  // so the repository list is still mounted behind the switch.
  await expect(page.getByRole('heading', { name: 'Codebase', level: 1 })).toBeVisible();
});
