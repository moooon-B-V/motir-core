import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';
import { SPLIT_MIN_CONTAINER_PX } from '@/lib/planning/railWidth';

// ── BELOW `md` THE PLAN PAGE'S CANVAS STILL HAS A HEIGHT (Bug MOTIR-6281) ─────
//
// The plan page (`/plans/<id>`) mounts `PlanningWorkspace`'s FIXED frame, the
// one the resizable split (MOTIR-6250) deliberately left alone. Below Tailwind's
// `md` that frame is one column, canvas first and review rail below it —
// MOTIR-6249's §7 stack. As shipped the stack had no row template, so its two
// IMPLICIT `auto` rows were sized from their content: the canvas's drawing area
// is `min-h-0 flex-1` and contributes only its chrome, the rail has real content
// height, and `auto` tracks share only the FREE space. Measured on the base
// commit at 767×720 with no extra content at all: rows `44px 541px`, the
// `planning-canvas` viewport 0px tall. This is the same defect MOTIR-6276 fixed on
// the resizable frame, reached without a long transcript — the rail as it arrives
// is already enough.
//
// `toBeVisible()` cannot see it: the nodes are laid out, merely CLIPPED by a box
// with no height. So the proof is geometry — the canvas viewport's own box, and a
// node of the arrival level inside it — read from the elements.

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A canvas node's drawn card, by the id `planReviewService` keys it by. */
const nodeBox = (page: Page, nodeId: string) =>
  page.locator(`[data-node-id="${nodeId}"] > div`).first();

test('below the split breakpoint the plan page stacks and its canvas keeps a real height', async ({
  page,
}) => {
  const seed = await seedPlanShapes('plan-detail-narrow@example.com');
  // One pixel under the breakpoint the product itself uses. Read from the
  // module, never typed.
  const narrow = { width: SPLIT_MIN_CONTAINER_PX - 1, height: 720 };
  await page.setViewportSize(narrow);
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  // Shape two opens on the canvas, at the level holding the story it modifies.
  await page.goto(`/plans/${seed.two.planId}`);
  // Scoped to the LIVE page body: a page-rooted strict locator can also match a
  // streamed-out or SSR-staged copy of the same node (MOTIR-5037's guard).
  const main = page.getByRole('main');
  const viewport = main.getByTestId('planning-canvas');
  const arrivalNode = nodeBox(page, seed.two.modified.id);
  await expect(arrivalNode).toBeAttached();

  // ── The canvas's drawing area has a height, and the arrival level is IN it ──
  await expect
    .poll(async () => (await viewport.boundingBox())?.height ?? 0, {
      message: 'the stacked plan-page canvas viewport has a non-zero height',
    })
    .toBeGreaterThan(0);
  const canvasBox = (await viewport.boundingBox())!;
  const nodeRect = (await arrivalNode.boundingBox())!;
  const midX = nodeRect.x + nodeRect.width / 2;
  const midY = nodeRect.y + nodeRect.height / 2;
  expect(midX).toBeGreaterThanOrEqual(canvasBox.x);
  expect(midX).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
  expect(midY).toBeGreaterThanOrEqual(canvasBox.y);
  expect(midY).toBeLessThanOrEqual(canvasBox.y + canvasBox.height);

  // ── Still the design's stack: canvas first, the rail below, both full width ─
  const frame = main.getByTestId('planning-workspace-frame');
  const stacked = await frame.evaluate((el) => {
    const f = el.getBoundingClientRect();
    const c = el.children[0]!.getBoundingClientRect();
    const r = el.children[1]!.getBoundingClientRect();
    return {
      frame: f.width,
      canvas: c.width,
      rail: r.width,
      canvasBottom: c.bottom,
      railTop: r.top,
    };
  });
  expect(stacked.railTop).toBeGreaterThanOrEqual(stacked.canvasBottom - 1);
  expect(Math.abs(stacked.canvas - stacked.frame)).toBeLessThanOrEqual(1);
  expect(Math.abs(stacked.rail - stacked.frame)).toBeLessThanOrEqual(1);

  // ── The rail is still reachable, and so is the decision it carries ─────────
  const approve = page.getByRole('button', { name: /^Approve/ });
  await approve.scrollIntoViewIfNeeded();
  await expect(approve).toBeInViewport();

  // ── At the breakpoint the frame is the unchanged two-column track ──────────
  await page.setViewportSize({ width: SPLIT_MIN_CONTAINER_PX, height: narrow.height });
  const split = await frame.evaluate((el) => {
    const c = el.children[0]!.getBoundingClientRect();
    const r = el.children[1]!.getBoundingClientRect();
    return {
      canvasRight: c.right,
      railLeft: r.left,
      canvasTop: c.top,
      railTop: r.top,
      rail: r.width,
    };
  });
  expect(Math.abs(split.railLeft - split.canvasRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(split.railTop - split.canvasTop)).toBeLessThanOrEqual(1);
  // `22rem` at the root's 16px — the fixed column, not the resizable one.
  expect(Math.round(split.rail)).toBe(352);
});
