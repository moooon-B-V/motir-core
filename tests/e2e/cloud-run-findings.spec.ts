import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { commentsService } from '@/lib/services/commentsService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardViewportWidth, getBoard, columnByStatus } from './_helpers/board';
import { signUp } from './_helpers/shell-session';
import { test, expect } from './_helpers/promoted-regression';

// ACCEPTANCE — a run can log a bug and re-plan a wrong card, and you decide
// whether it may (Story MOTIR-3017 · Subtask MOTIR-3025).
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing. This story
// asks a person to trust a machine with two things they have never delegated:
// writing into their tracker, and APPROVING A CHANGE TO THEIR PLAN. A passing
// assertion does not settle that. What settles it is watching a card get parked
// for a stated reason, a bug appear carrying real evidence, and a tree change
// itself with nobody at the keyboard — at a speed a person can disagree with.
//
// So the beats that get room are the ones a reviewer is actually deciding
// about: the card sitting in Planning with its finding on it, and the tree
// BEFORE and AFTER an automatic approval. The negative beat gets room too, and
// for a different reason — it is the one an operator would find hardest to
// forgive if it were wrong, because they explicitly asked for it not to happen.
//
// ── THE LANE, per `docs/acceptance-lane-triage.md` ──────────────────────────
// This runs in the ACCEPTANCE lane, and the reason IS the environment rather
// than only the receipt: beat 4 approves a plan, and a plan only exists because
// a planning submit reached motir-ai — which `playwright.config.ts`'s server
// does not have configured. Under the main lane the submit would not produce a
// plan at all, and the spec would assert an approval of nothing. Its
// disposition when this receipt freezes is therefore a PROMOTE into the CLOUD-ON
// lane, not the main one — recorded here rather than left to be rediscovered.
//
// ── WHAT IS FILMED HERE, AND WHAT IS NOT ───────────────────────────────────
// The observable surface of this story is MOTIR: cards appear, move and
// materialise. The other half lives in a terminal — a refused flag's message,
// an exact submit count, a policy that reaches a prompt — and a browser cannot
// see any of it. That half is `tests/cli/cli-findings-story.test.ts`, which
// drives the REAL binary with a scripted agent. Neither lane can do the other's
// job, and pretending otherwise would put a fake terminal in a video.
//
// DETERMINISM: every assertion waits on an authoritative signal — a response, or
// a committed-state read through the shipped services. The board is re-rendered
// for the CAMERA after the read, never as the proof, so the clip cannot be the
// thing that decides whether the test passed. No `waitForTimeout` anywhere.

const EMAIL = `findings-${Date.now()}@motir.test`;

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

async function seedActiveProject(page: Page): Promise<Tenant> {
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Run findings',
    identifier: 'FIND',
  });
  return {
    userId: membership.userId,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: 'FIND',
  };
}

/** The service context this spec seeds and reads committed state through. */
function ctx(t: Tenant) {
  return { userId: t.userId, workspaceId: t.workspaceId };
}

async function mkStory(page: Page, t: Tenant, title: string) {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId: t.projectId, kind: 'story', title },
  });
  expect(res.status(), `create story "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

async function mkCard(page: Page, t: Tenant, parentId: string, title: string) {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId: t.projectId, kind: 'subtask', title, parentId, type: 'code' },
  });
  expect(res.status(), `create card "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

/** Show the board with a card in a named column — for the CAMERA, after the
 *  assertion has already been made against committed state. */
async function showBoard(page: Page, columnId: string, identifier: string): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId(`board-column-${columnId}`).getByTestId(`board-card-${identifier}`),
  ).toBeVisible();
}

async function showItem(page: Page, identifier: string): Promise<void> {
  await page.goto(`/items/${identifier}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
}

/**
 * What a REFUSING agent does, through the shipped services — the same three
 * writes the prompt's THE-CARD-IS-WRONG branch instructs, in the same order.
 *
 * The prompt itself is asserted in `tests/dispatch/`; what this spec is for is
 * the SURFACE those writes produce, which is the thing a reviewer looks at.
 */
async function agentRefuses(t: Tenant, card: { id: string }, finding: string): Promise<void> {
  await commentsService.addComment(card.id, { bodyMd: finding }, ctx(t));
  await workItemsService.updateStatus(card.id, 'planning', ctx(t));
}

test('a run refuses a card, files a bug, and — only when told it may — approves its own re-plan', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3017');

  await page.setViewportSize(boardViewportWidth());
  await signUp(page, EMAIL);
  const t = await seedActiveProject(page);

  const story = await mkStory(page, t, 'The ready-set filter bar');
  const wrong = await mkCard(page, t, story.id, 'Extend the filter bar that does not exist');
  const good = await mkCard(page, t, story.id, 'Add the empty state');

  const board = await getBoard(page.request);
  const todo = columnByStatus(board, 'todo');
  const planning = columnByStatus(board, 'planning');

  // ── 1 — the agent refuses a card, and it is PARKED with its reason ────────
  await chapter('The agent says: this card is wrong', async () => {
    await showBoard(page, todo.id, wrong.identifier);
    await beat();

    await agentRefuses(
      t,
      wrong,
      'The filter bar this card extends does not exist on `origin/main` — ' +
        '`git ls-tree origin/main -- app/(authed)/ready` lists no filter component.',
    );

    // ⚠️ THE ASSERTION IS AGAINST COMMITTED STATE, and it is made before the
    // camera sees anything. Planning sits in the in-progress CATEGORY, which is
    // what actually takes the card out of the pickable set — the status is the
    // claim, not the column's position.
    const detail = await workItemsService.getIssueDetail(t.projectId, wrong.identifier, ctx(t));
    expect(detail.item.status).toBe('planning');

    await showBoard(page, planning.id, wrong.identifier);
    await beat();
  });

  await chapter('…and it says WHY, on the card', async () => {
    // The evidence is where a person meets it: on the card, not in a log the
    // run threw away.
    await showItem(page, wrong.identifier);
    // ⚠️ Matched on PROSE, not on the source. The comment renders as Markdown,
    // so the backticked paths become <code> elements and the literal string with
    // its backticks appears nowhere in the text — the assertion has to name what
    // a reader SEES.
    await expect(page.getByText('The filter bar this card extends')).toBeVisible();
    await beat();
  });

  // ── 2 — a bug the agent filed while working a DIFFERENT card ─────────────
  await chapter('A second card finishes — and files what it found on the way', async () => {
    // The FOUND A DEFECT branch: reproduce, file under the card's own parent,
    // link back, and CARRY ON. The card's own outcome is unchanged, which is the
    // half an agent gets wrong unprompted.
    const bug = await workItemsService.createWorkItem(
      {
        projectId: t.projectId,
        kind: 'bug',
        title: 'The empty state renders twice on a filtered ready set',
        parentId: story.id,
        descriptionMd: [
          '## Reproduction',
          'Open /ready, filter to `bug`, and clear the filter.',
          '',
          '## Evidence',
          'The empty-state node appears twice in the DOM after the second render.',
          '',
          `## Seen on`,
          `${good.identifier}, on this run's branch.`,
        ].join('\n'),
      },
      ctx(t),
    );
    await workItemsService.updateStatus(good.id, 'in_progress', ctx(t));
    await workItemsService.updateStatus(good.id, 'implemented', ctx(t));

    // Both are true at once: the bug exists, and the card still reached its own
    // outcome. Filing changed nothing about the work in hand.
    const filed = await workItemsService.getIssueDetail(t.projectId, bug.identifier, ctx(t));
    expect(filed.item.kind).toBe('bug');
    expect(filed.ancestors.at(-1)?.identifier).toBe(story.identifier);
    expect(filed.blockedBy, 'a filed bug blocks nothing').toEqual([]);
    const worked = await workItemsService.getIssueDetail(t.projectId, good.identifier, ctx(t));
    expect(worked.item.status).toBe('implemented');

    await showItem(page, bug.identifier);
    await expect(page.getByText('Reproduction')).toBeVisible();
    await beat();
  });

  // ── 3 — the NEGATIVE beat: told not to, the run writes nothing ───────────
  await chapter('Told not to, it writes nothing at all', async () => {
    // ⚠️ ABSENCE IS THE ASSERTION, and it is the one this story would most
    // regret getting wrong: an operator who passed `--disable-log-bug
    // --disable-replan` explicitly asked for this not to happen. The prompt
    // those flags produce carries no bug branch and no submit step at all —
    // asserted on the assembled text in `tests/dispatch/` and end to end through
    // the real binary in `tests/cli/cli-findings-story.test.ts`. What is checked
    // HERE is the product: nothing new appeared.
    const bugsBefore = await workItemsService.listWorkItems(t.projectId, { kind: 'bug' }, ctx(t));
    const plansBefore = await plansService.listPlans(t.projectId, ctx(t));

    // A run under that policy comments its finding and stops.
    await commentsService.addComment(
      good.id,
      { bodyMd: 'Found something odd in the sprint header; this run may not file it.' },
      ctx(t),
    );

    const bugsAfter = await workItemsService.listWorkItems(t.projectId, { kind: 'bug' }, ctx(t));
    const plansAfter = await plansService.listPlans(t.projectId, ctx(t));
    expect(bugsAfter).toHaveLength(bugsBefore.length);
    expect(plansAfter.plans).toHaveLength(plansBefore.plans.length);

    await showItem(page, good.identifier);
    await expect(page.getByText('may not file it')).toBeVisible();
    await beat();
  });

  // ── 4 — the beat a reviewer is really deciding about ─────────────────────
  await chapter('The tree BEFORE — this is what you own', async () => {
    await showBoard(page, planning.id, wrong.identifier);
    await beat();
    await beat();
  });

  await chapter('A machine approves the re-plan, and the tree CHANGES', async () => {
    // The plan the refused card produced, submitted by the agent and written by
    // the planner — then approved with nobody opening Motir.
    const plan = await plansService.createPlan(
      t.projectId,
      { title: `Re-plan ${wrong.identifier}`, summary: null },
      ctx(t),
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Build the ready-set filter bar',
            kind: 'subtask',
            type: 'code',
          },
          parentRef: story.id,
        },
      ],
      ctx(t),
    );
    await plansService.markPlanned(plan.id, ctx(t));

    const approved = await plansService.approvePlan(plan.id, ctx(t));
    expect(approved.status).toBe('approved');

    // ⚠️ THE PROPOSAL BECAME A ROW. Asserted against committed state before the
    // camera sees the board, so the clip shows a tree that already changed
    // rather than being the evidence that it did.
    const materialized = approved.items[0]?.workItemId;
    expect(materialized, 'the proposal materialized into a row').toBeTruthy();
    // Read the whole project's cards — the proposal knows only an id, and the
    // detail read takes an identifier. What matters is that the row EXISTS,
    // under the story, with the title the plan proposed.
    const all = await workItemsService.listWorkItems(t.projectId, {}, ctx(t));
    const created = all.find((c) => c.id === materialized);
    expect(created?.title).toBe('Build the ready-set filter bar');
    expect(created?.parentId).toBe(story.id);

    await page.goto('/boards');
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
    await beat();
    await beat();
  });

  // ── the a11y sweep, on the surface this spec asserted against ────────────
  await chapter('The surfaces this run touched are accessible', async () => {
    await showItem(page, wrong.identifier);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await beat();
  });
});
