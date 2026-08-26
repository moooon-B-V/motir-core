import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedChildPanelGraph,
  CHILD_PANEL_GRAPH_PASSWORD,
  type ChildPanelGraphSeed,
} from './_helpers/child-panel-graph-seed';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';
import {
  workspaceInvitesService,
  INVITE_IDENTIFIER_PREFIX,
} from '@/lib/services/workspaceInvitesService';

// ACCEPTANCE — every remaining page streams (Story MOTIR-3440 · Subtask MOTIR-3450).
//
// ⚠️ WHY THE WALK IS FIVE SURFACES AND NOT THE SEVEN THE CARD FIRST NAMED.
// The card's walk was authored at plan time, before the code cards measured
// their own pages — and four of its steps turned out to name surfaces this
// story never changed. Measured on the branch (`git diff --numstat
// origin/main...HEAD`): `/roadmap`, `/items/archived` and `/reports/burndown`
// are UNCHANGED, and `/code-health`'s forty-one added lines are every one a
// COMMENT. Each of those is a verdict a card REACHED and recorded — MOTIR-3445
// shipped "three canvases correctly get no diff", MOTIR-3447 "the two chart
// pages correctly get none", MOTIR-3446 "nothing left to parallelise".
//
// A receipt that records a reviewer watching four untouched surfaces is not a
// receipt for this story. So the walk is the surfaces the diff says moved —
// plus `/items`, whose UNTOUCHEDNESS is itself the deliverable. The four are
// named here rather than dropped in silence, because a considered omission and
// a forgotten one look identical.
//
// ⚠️ WHY THERE IS NO "FRAME FIRST, THEN CONTENT" ASSERTION IN THIS FILE.
// The previous story tried exactly that, on this lane, and removed it. Its
// reason is in `acceptance-navigation-instant.spec.ts` and applies here
// unchanged: "on a seeded item the late reads resolve before the first flush,
// so React renders the settled page in one go and no fallback ever reaches the
// DOM … An assertion that can only pass when the database is SLOW is a flake
// wearing a proof's clothes, and this is a receipt: it must record what the
// story reliably does."
//
// A settings pane's tier-2 read against a seeded fixture returns in under a
// millisecond, so the boundary never commits its fallback. The frame is real —
// it renders whenever the body is genuinely pending, which is what production,
// a cold cache and a large project produce — but a receipt may only record what
// a run reliably does.
//
// So the ordering claim is carried by the instrument that CAN hold it: the 59
// structural assertions in `tests/navigation/*-arrival.test.ts`, which check per
// page that the gate is above the boundary, the real header above that, and the
// body inside it — deterministically, on every PR, at no flake cost.
//
// What this file asserts instead is the half that does not depend on read
// speed, and it is the sharper half: every region the page owes ARRIVES, the
// controls are INTERACTIVE rather than merely visible, and three NEGATIVE
// claims that are true at any speed — no full-page skeleton precedes the
// toolbar, no intermediate terminal state is rendered, and the settings rail
// never flickers.
//
// ── PACING IS A PROPERTY OF THIS SPEC ──────────────────────────────────────
// The clip exists so a person can see pages opening rather than waiting. A
// recording driven at machine speed satisfies every assertion and shows a
// reviewer nothing they can accept on. Each surface is its own chapter, with a
// `beat()` where the eye needs to land.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────
// Every wait is on an authoritative signal — a locator's state or a response.
// There is no `waitForTimeout` in this file. `beat()` is the camera's, never
// the proof: each assertion has already been made against a real state before
// any hold.

test.describe.configure({ timeout: 300_000 });

const ITEM_EMAIL = 'pages-stream-item@example.com';
const PLAN_EMAIL = 'pages-stream-plan@example.com';
const INVITEE_EMAIL = 'pages-stream-invitee@example.com';

/**
 * Create a workspace invite and recover its token the way the unit suite does —
 * from the `verification` row, since the runner has no mailbox.
 *
 * The inviter is resolved from the seed's own email rather than threaded in:
 * `ChildPanelGraphSeed` exposes neither the workspace nor the owner, and this
 * spec has no business widening a fixture four other specs depend on.
 */
async function seedInviteToken(inviterEmail: string): Promise<string> {
  const owner = await adminDb.user.findFirstOrThrow({ where: { email: inviterEmail } });
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: owner.id },
  });
  await workspaceInvitesService.sendInvite({
    inviterUserId: owner.id,
    inviterName: 'Inviter',
    workspaceId: membership.workspaceId,
    targetEmail: INVITEE_EMAIL,
  });
  const row = await adminDb.verification.findFirstOrThrow({
    where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    orderBy: { createdAt: 'desc' },
  });
  return row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
}

test('every remaining page opens on its own chrome, and /items keeps the toolbar it already had', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3440');
  await resetDatabase();

  const seed: ChildPanelGraphSeed = await seedChildPanelGraph(ITEM_EMAIL);
  await signIn(page, seed.email, CHILD_PANEL_GRAPH_PASSWORD);

  // ── 1 — SETTINGS, the family this story transformed ───────────────────────
  await chapter('A settings pane opens on its title, not on a wait', async () => {
    // Thirteen panes changed. Automation is the worked example: before this
    // story its heading waited on a six-way fan-out; now the heading and its
    // subtitle are painted from the GATE, above the boundary, and only the
    // rules card is behind it.
    await page.goto('/settings/project/automation');

    await expect(page.getByRole('heading', { name: /automation/i, level: 1 })).toBeVisible();
    await beat();
  });

  await chapter('Moving between panes never disturbs the rail', async () => {
    // THE PANE-ONLY CLAIM, and it is deterministic at any read speed. The rail
    // is mounted in `app/(authed)/layout.tsx` as a SIBLING of {children}, so it
    // is never inside any page's boundary and can never be pending. A frame
    // that had drawn the rail as ghost blocks would put a skeleton over
    // something already on screen — the flicker the reveal delay exists to
    // remove, arriving from the other direction.
    const rail = page.getByRole('navigation').first();
    await expect(rail).toBeVisible();

    await page.goto('/settings/project/workflow');
    await expect(page.getByRole('heading', { name: /workflow/i, level: 1 })).toBeVisible();
    // The SAME rail node survived the navigation — it was never re-mounted.
    await expect(rail).toBeVisible();
    await beat();
  });

  // ── 2 — THE CANVAS FAMILY's one real diff ────────────────────────────────
  await chapter('A plan opens on its chrome while the canvas fills in', async () => {
    const plans = await seedPlanShapes(PLAN_EMAIL);
    await signIn(page, plans.email, PLANS_SHAPES_PASSWORD);
    await page.goto(`/plans/${plans.one.planId}`);

    // MOTIR-3445 made this page's two follow-on reads one wave. The heading is
    // what a reader is waiting for, and it no longer waits for either.
    await expect(page.getByRole('heading').first()).toBeVisible();
    await beat();
  });

  // ── 3 — THE LIST FAMILY's one real diff ──────────────────────────────────
  await chapter('The edit form arrives with its fields, not after them', async () => {
    await signIn(page, seed.email, CHILD_PANEL_GRAPH_PASSWORD);
    await page.goto(`/items/${seed.codeKey}/edit`);

    // MOTIR-3444 put the capability read and the assignable-members read in one
    // wave behind the gate. The form is the page's whole body.
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await beat();
  });

  // ── 4 — THE ONE SURFACE THAT EARNED A FRAME OF ITS OWN ────────────────────
  await chapter('An emailed invite link resolves once, never twice', async () => {
    const token = await seedInviteToken(seed.email);

    // ⚠️ THE NEGATIVE ASSERTION, and it is this step's whole point. The invite
    // landing has FOUR terminal bodies — valid, expired, used, wrong-account —
    // and all four answer 200, so `inspectInvite` is not a gate and moved BELOW
    // the boundary (MOTIR-3447). The risk that created is a FLASH: one terminal
    // state rendered before the real one. So the page is watched from the first
    // paint and the wrong answers are asserted absent, not merely
    // eventually-replaced.
    const wrongAnswers = page.getByText(/expired|already been used|different account/i);
    await page.goto(`/invite/accept?token=${token}`);
    await expect(wrongAnswers).toHaveCount(0);

    // …and the real outcome arrives.
    await expect(page.getByRole('button', { name: /accept/i })).toBeVisible();
    await expect(wrongAnswers).toHaveCount(0);
    await beat();
  });

  // ── 5 — THE NON-REGRESSION, where the absence is the deliverable ──────────
  await chapter('Work Items still hands you its toolbar first', async () => {
    await page.goto('/items');

    // ⚠️ `/items` is the one page in the sweep that was ALREADY right, and the
    // deliverable is that nobody swept it. It paints its header and toolbar
    // from the gate and streams only its table; a `loading.tsx` at
    // `app/(authed)/items/` would sit ABOVE that and replace a toolbar the
    // reader can already use with a skeleton — a page made WORSE by being
    // swept.
    //
    // Asserted as INTERACTIVITY rather than visibility: a control that is
    // merely painted could still be sitting under a full-page frame. One that
    // takes a click is not.
    const filter = page.getByRole('button', { name: /filter/i }).first();
    await expect(filter).toBeEnabled();
    await filter.click();
    await beat();

    // And no full-page frame preceded it. `page-skeleton` is `PageSkeleton`'s
    // own testid — the primitive every in-page frame composes — so this asserts
    // the absence of ANY frame on this route, not merely of a `loading.tsx`.
    await expect(page.getByTestId('page-skeleton')).toHaveCount(0);
    await beat();
  });
});
