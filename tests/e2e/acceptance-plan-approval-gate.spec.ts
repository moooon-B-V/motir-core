// Acceptance E2E — approving a plan is an APPROVAL GATE (Subtask MOTIR-6041,
// Story MOTIR-6012; `docs/decisions/approval-gates.md` §11.3–§11.5c).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A member asks for a plan from a card and is told it is being written, so they
// leave. The plan finishes and is WAITING in To approve, in plain words and in the
// tab's count. The row takes them back to the PLANNING SURFACE at that plan's
// conversation — not to an approval overlay — with the plan on the canvas and its
// two verbs, Decline and Approve (there is no Request changes). While the planner
// writes a new version the row says *Being rewritten* and the verbs are unavailable;
// once it finishes the SAME row decides again, and Approve lands the cards.
//
// The unrecorded tests cover the rest of the card: Decline from the surface; the
// stale refusal when the plan changed under the reader; a reader who may see and
// not decide; and a plan with NO conversation, whose row opens its plan page.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + the motir-ai JOBS mock
// under the routes), the lane where the planning surface mounts at all. The mock
// settles a plan job with nothing proposed, so a run is FINISHED by the shipped
// services a real run's handler calls (`addProposals` → `markPlanned`,
// `finishSessionPlan`) — and `markPlanned` is what RAISES the gate. A REWRITE is the
// shipped revision lease (`acquireRevisionLease` → `addProposals({ revision })` →
// `releaseRevisionLease`), the same calls the planner's revision makes, so the hold
// and the stale stamp are real rows, never stubbed refusals.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a row, a
// `waitForURL`, the decide route's response, or a committed read. The planning
// surface does not poll a plan it is not writing, so a seam's write is observed
// through a fresh read of the page (a navigation), never by waiting for a repaint.
// `beat()` / the chapter hold are PACING only, each after the assertion that proved
// the state.
import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { finishSessionPlan, latestPlanningSession } from './_helpers/planChangeConversation';
import { plansService } from '@/lib/services/plansService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const gate = en.approvalGate.planApproval;
const surface = gate.surface;

/** The planner's own revision — Motir AI, so the hold names no harness. */
const MOTIR_AI_REVISION = { source: 'native' as const, harness: null, model: null };

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const reviewBlock = (page: Page) => rail(page).getByTestId('plan-change-review');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

const approvalRows = (page: Page) =>
  page.getByRole('table', { name: en.workbench.tabs.toApprove }).getByTestId(/^approval-row-/);
const planRow = (page: Page, text: string) => approvalRows(page).filter({ hasText: text });
const reviewButton = (row: Locator) =>
  row.getByRole('button', { name: en.workbench.approvals.review, exact: true });
/** The row's own door — the stretched link a plain click opens the surface from. */
const rowDoor = (row: Locator) => row.getByRole('link', { name: /^Review plan — / });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], submitted: [] }, null, 2));
}

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** Open *Plan with AI* from the card, and prove the surface MOUNTED first. */
async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Ask from a CARD — the anchored door appends AND submits a plan run in one call;
 *  its 200 is the authoritative "the session holds this turn". */
async function askFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
  await expect(rail(page).getByText(text)).toBeVisible();
}

async function closeSurface(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

async function openToApprove(page: Page): Promise<void> {
  await page.goto('/workbench?tab=approvals');
  await expect(page.getByRole('link', { name: /To approve/ })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
}

/** The row opens the PLANNING SURFACE at the plan's conversation — and only it:
 *  the one dialog on the page is the planning workspace, never the approval overlay. */
async function landOnSurface(page: Page, sessionId: string): Promise<void> {
  await page.waitForURL(
    (url) =>
      url.searchParams.get('planSession') === sessionId &&
      url.searchParams.get('planVia') === 'approvals',
  );
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByRole('dialog')).toHaveCount(1);
}

/** The surface has RENDERED the plan for review — the canvas bar is up and names the
 *  proposal count read from the plan — before anything inside it is asserted. The
 *  proposals are root-level cards, off the anchor's canvas level, so the bar's count
 *  (`barCounts`, rendered from the review read) is the plan's rendered signal. */
async function planRendered(page: Page, added: number): Promise<void> {
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(bar(page)).toContainText(`${added} added`);
}

const decideResponse = (page: Page, planId: string, action: 'approve' | 'decline') =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/plans/${planId}/${action}` &&
      r.request().method() === 'POST',
  );

// ── Seams ────────────────────────────────────────────────────────────────────

interface Ctx {
  userId: string;
  workspaceId: string;
}

/** The planner writes a NEW VERSION of the plan: it takes the revision lease. */
async function startRewrite(planId: string, ctx: Ctx): Promise<void> {
  await plansService.acquireRevisionLease(planId, ctx, MOTIR_AI_REVISION);
}

/** …proposes inside the lease, and lets go — the rewrite has finished. */
async function finishRewrite(planId: string, ctx: Ctx, title: string): Promise<void> {
  await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    ctx,
    { revision: true },
  );
  await plansService.releaseRevisionLease(planId, ctx, MOTIR_AI_REVISION);
}

const planStatus = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;

const itemNamed = (title: string) =>
  adminDb.workItem.findFirst({ where: { title }, select: { identifier: true } });

/** Ask from a card and let the run finish: a `planned` plan on a conversation, its
 *  gate raised and routed to the member who asked. */
async function seedAskedPlan(
  page: Page,
  email: string,
  cardKey: string,
  ask: string,
  proposal: string,
): Promise<{ planId: string; sessionId: string; ctx: Ctx }> {
  await openFromCard(page, cardKey);
  await askFromCard(page, ask);
  const session = await latestPlanningSession(email);
  await closeSurface(page);
  const planId = await finishSessionPlan(session.id, proposal);
  return {
    planId,
    sessionId: session.id,
    ctx: { userId: session.createdById, workspaceId: session.workspaceId },
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a finished plan waits in To approve, is held while it is rewritten, and Approve lands its cards', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6012');

  const email = `plan-gate-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Split this story so the canvas seam can ship on its own.';
  const FIRST = 'Ship the canvas seam first';
  const REWRITTEN = 'Thread the seam through the host';
  let sessionId = '';
  let planId = '';
  let ctx: Ctx = { userId: '', workspaceId: '' };
  /** The gate's row — the SAME row must be held and then decide (§11.5c). */
  let rowTestId = '';

  await chapter('Ask for a plan from a card, then leave while it is written', async () => {
    await openFromCard(page, seed.storyKey);
    await askFromCard(page, ASK);
    const session = await latestPlanningSession(email);
    sessionId = session.id;
    ctx = { userId: session.createdById, workspaceId: session.workspaceId };
    await beat();
    await closeSurface(page);
  });

  await chapter('The plan finished — it is waiting in To approve', async () => {
    planId = await finishSessionPlan(sessionId, FIRST);
    await openToApprove(page);
    const row = planRow(page, seed.storyKey);
    await expect(row).toBeVisible();
    rowTestId = (await row.getAttribute('data-testid'))!;
    await expect(row).toContainText(new RegExp(`Plan for\\s*${seed.storyTitle}`));
    await expect(row).toContainText('1 proposed item · written by Motir AI');
    await expect(page.getByRole('link', { name: /To approve/ })).toContainText('1');
    await beat();
  });

  await chapter('The row opens the planning surface, with the plan to decide', async () => {
    await reviewButton(planRow(page, seed.storyKey)).click();
    await landOnSurface(page, sessionId);
    await planRendered(page, 1);
    await expect(rail(page).getByTestId('planning-reopened-from-approvals')).toContainText(
      'Reopened from To approve',
    );
    await expect(bar(page)).toContainText(surface.consequence);
    await expect(verb(bar(page), surface.decline)).toBeEnabled();
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await expect(verb(reviewBlock(page), surface.approve)).toBeEnabled();
    // Two verbs, and no third.
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(0);
    await beat();
  });

  await chapter('While the planner rewrites it, it is held — and still listed', async () => {
    await startRewrite(planId, ctx);
    await openToApprove(page);
    const row = planRow(page, seed.storyKey);
    await expect(row).toHaveAttribute('data-testid', rowTestId);
    await expect(row).toContainText(gate.row.rewriting);
    await expect(reviewButton(row)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /To approve/ })).toContainText('1');
    await beat();

    // The row still opens the surface — to watch, not to decide.
    // Pressed at its leading edge: the details and the title sit ABOVE the stretched
    // door (`z-10`, the title being the target's quick view), so its centre is covered.
    await rowDoor(row).click({ position: { x: 6, y: 6 } });
    await landOnSurface(page, sessionId);
    await planRendered(page, 1);
    await expect(bar(page)).toContainText(surface.held);
    await expect(verb(bar(page), surface.approve)).toBeDisabled();
    await expect(verb(bar(page), surface.decline)).toBeDisabled();
    await expect(verb(reviewBlock(page), surface.approve)).toBeDisabled();
    await beat();
  });

  await chapter('The rewrite finished — the same row decides again', async () => {
    await finishRewrite(planId, ctx, REWRITTEN);
    await openToApprove(page);
    const row = planRow(page, seed.storyKey);
    await expect(row).toHaveAttribute('data-testid', rowTestId);
    await expect(row).toContainText('2 proposed items · ');
    await expect(row).not.toContainText(gate.row.rewriting);
    await reviewButton(row).click();
    await landOnSurface(page, sessionId);
    await planRendered(page, 2);
    await expect(bar(page)).toContainText(surface.consequence);
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
  });

  await chapter('Approve — the cards land in the backlog', async () => {
    const approved = decideResponse(page, planId, 'approve');
    await verb(bar(page), surface.approve).click();
    expect((await approved).status()).toBe(200);
    await expect(rail(page).getByText(/Added 2 work items/)).toBeVisible();
    expect(await planStatus(planId)).toBe('approved');
    const landed = await itemNamed(REWRITTEN);
    expect(landed).not.toBeNull();
    expect(await itemNamed(FIRST)).not.toBeNull();
    await beat();

    await openToApprove(page);
    await expect(planRow(page, seed.storyKey)).toHaveCount(0);
    await page.goto(`/items/${landed!.identifier}`);
    await expect(page.getByRole('heading', { name: REWRITTEN })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
  });
});

test('Decline on the planning surface ends a second plan and it leaves To approve', async ({
  page,
}) => {
  const email = `plan-gate-decline-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const PROPOSAL = 'Move the host seam behind a flag';
  const plan = await seedAskedPlan(page, email, seed.subtaskKey, 'Plan the host seam.', PROPOSAL);

  await openToApprove(page);
  await reviewButton(planRow(page, seed.subtaskKey)).click();
  await landOnSurface(page, plan.sessionId);
  await planRendered(page, 1);

  await verb(bar(page), surface.decline).click();
  const band = workspace(page).getByTestId('plan-decline-confirm').first();
  await expect(band).toContainText(gate.declineConfirm.title);
  await band.getByLabel(gate.declineConfirm.label).fill('Not this sprint.');
  const declined = decideResponse(page, plan.planId, 'decline');
  await verb(band, gate.declineConfirm.proceed).click();
  expect((await declined).status()).toBe(200);
  await expect(rail(page).getByTestId('plan-declined-marker')).toHaveText(surface.declined);
  expect(await planStatus(plan.planId)).toBe('declined');
  expect(await itemNamed(PROPOSAL)).toBeNull();

  await openToApprove(page);
  await expect(planRow(page, seed.subtaskKey)).toHaveCount(0);
});

test('a plan that changed while it was read is refused as stale, and decides on the new version', async ({
  page,
}) => {
  const email = `plan-gate-stale-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const FIRST = 'Ship the canvas seam first';
  const LATE = 'Added while you were reading';
  const plan = await seedAskedPlan(page, email, seed.storyKey, 'Plan the canvas seam.', FIRST);

  await openToApprove(page);
  await reviewButton(planRow(page, seed.storyKey)).click();
  await landOnSurface(page, plan.sessionId);
  await planRendered(page, 1);

  // A rewrite lands between reading the plan and pressing.
  await startRewrite(plan.planId, plan.ctx);
  await finishRewrite(plan.planId, plan.ctx, LATE);

  const refused = decideResponse(page, plan.planId, 'approve');
  await verb(bar(page), surface.approve).click();
  const refusal = await refused;
  expect(refusal.status()).toBe(409);
  expect(await refusal.json()).toMatchObject({ code: 'APPROVAL_GATE_STALE_SUBJECT' });
  await expect(workspace(page).getByTestId('plan-decide-stale').first()).toContainText(
    surface.stale.title,
  );
  expect(await planStatus(plan.planId)).toBe('planned');
  // The canvas re-read the new version, and the verbs are live against it.
  await expect(bar(page)).toContainText('2 added');

  const approved = decideResponse(page, plan.planId, 'approve');
  await verb(bar(page), surface.approve).click();
  expect((await approved).status()).toBe(200);
  expect(await planStatus(plan.planId)).toBe('approved');
  expect(await itemNamed(LATE)).not.toBeNull();
});

test('a reader who may not decide sees the plan and no verbs; a plan with no conversation opens its plan page', async ({
  page,
}) => {
  const email = `plan-gate-reader-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const FIRST = 'Ship the canvas seam first';
  const plan = await seedAskedPlan(page, email, seed.storyKey, 'Plan the canvas seam.', FIRST);

  // Where the owner's row lands — the address a reader opens the same surface at.
  await openToApprove(page);
  await reviewButton(planRow(page, seed.storyKey)).click();
  await landOnSurface(page, plan.sessionId);
  await planRendered(page, 1);
  const surfaceUrl = page.url();

  // ── A plan with NO conversation: its row opens the plan page, with both verbs. ──
  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  const loose = await plansService.createPlan(
    project.id,
    { title: 'Telemetry baseline' },
    plan.ctx,
  );
  await plansService.addProposals(
    loose.id,
    [{ op: 'add', proposedFields: { title: 'Record the first baseline', kind: 'task' } }],
    plan.ctx,
  );
  await plansService.markPlanned(loose.id, plan.ctx);
  // ⚠️ AMENDED by Story MOTIR-6043 · MOTIR-6045. This case used to rest on
  // `createPlan` producing a plan whose session held no TURNS, which §11.5b then
  // sent to the plan page. The turns reading is overturned
  // (`docs/decisions/mcp-authored-plan-review.md`) and the predicate is now the
  // session's EXISTENCE, so that plan opens the SURFACE like any other — the case
  // this test is about needs a plan with no session AT ALL.
  //
  // `Plan.sessionId` is *"NULLABLE AT THE DATABASE only so a build predating this
  // column can still write a plan during a rollout"* (`prisma/schema.prisma`) and
  // every author path sets it, so this state has no shipped producer to drive:
  // clearing the column IS that rollout, simulated. The same seed, with the same
  // reasoning, is `tests/integration/planning/planRowDestinationGate.test.ts`.
  await adminDb.plan.update({ where: { id: loose.id }, data: { sessionId: null } });

  await openToApprove(page);
  const looseRow = planRow(page, 'Telemetry baseline');
  await expect(looseRow).toBeVisible();
  await reviewButton(looseRow).click();
  await page.waitForURL(`**/plans/${loose.id}`);
  // The plan page's own verbs: *Approve — add 1 item to your backlog* and *Decline*.
  const pageApprove = page.getByRole('button', { name: /^Approve — add 1 item/ });
  await expect(pageApprove).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByRole('button', { name: surface.decline, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(0);
  await expect(workspace(page)).toHaveCount(0);
  const approved = decideResponse(page, loose.id, 'approve');
  await pageApprove.click();
  expect((await approved).status()).toBe(200);
  expect(await planStatus(loose.id)).toBe('approved');

  // ── A browse-only member: the same surface, the question, and no verbs. ──
  const viewerEmail = `plan-gate-viewer-${Date.now()}@example.com`;
  const viewer = await usersService.createUser({
    email: viewerEmail,
    password: PLANNING_ANCHOR_PASSWORD,
    name: 'Read Only',
  });
  await adminDb.workspaceMembership.create({
    data: {
      userId: viewer.id,
      workspaceId: plan.ctx.workspaceId,
      role: 'member',
      activeProjectId: project.id,
    },
  });
  await projectMembersService.addMember({
    key: seed.projectKey,
    actorUserId: plan.ctx.userId,
    ctx: plan.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });

  await page.context().clearCookies();
  await signIn(page, viewerEmail, PLANNING_ANCHOR_PASSWORD);
  await page.goto(surfaceUrl);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await planRendered(page, 1);
  await expect(bar(page).getByTestId('plan-decide-see-only')).toContainText(
    surface.seeOnly.replace('{name}', 'Planning Anchor Owner'),
  );
  await expect(verb(bar(page), surface.approve)).toHaveCount(0);
  await expect(verb(bar(page), surface.decline)).toHaveCount(0);
  await expect(verb(reviewBlock(page), surface.approve)).toHaveCount(0);
  expect(await planStatus(plan.planId)).toBe('planned');
});
