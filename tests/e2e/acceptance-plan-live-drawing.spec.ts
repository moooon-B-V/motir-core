import { writeFileSync } from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect, FIRST_PAINT_MS, BEAT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import { seedLiveDrawing, LIVE_DRAWING_PASSWORD } from './_helpers/live-drawing-seed';
import type { LiveDrawingSeed } from './_helpers/live-drawing-seed';
import { agentSession, AGENT_HARNESS, AGENT_MODEL } from './_helpers/agent-authored-plan-seed';
import { plansService } from '@/lib/services/plansService';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import en from '@/messages/en.json';

// MOTIR-6302 — the live-drawing E2E + ACCEPTANCE VIDEO for MOTIR-6158.
//
// The story's claim, in a real browser: a plan is DRAWN AS IT IS WRITTEN. Cards
// arrive on the level they belong to, each with the arrow it brings; a rewire
// draws its new arrow in; a withdrawn card leaves and takes its arrows; the
// hand-over into the proposed plan moves nothing; an arrival on another level
// counts without moving the reader; and an agent writing over MCP fills the same
// pane — Canvas and List — without a reload.
//
// ── Why this cannot be a lower tier ─────────────────────────────────────────
// Motion, the reduced-motion media query and a browser's poll timing exist only
// in a browser. MOTIR-6301 proves the model is drawn identically live and
// proposed; this proves a person can WATCH it happen.
//
// ── What is real, and what is not ───────────────────────────────────────────
// The live read is the REAL `GET /api/plans/[id]` poll — never intercepted, or
// the spec would assert its own harness. The MCP plan is written through the
// real MCP SDK against this lane's `/api/mcp` with a minted token — no stub.
// The hosted plan is written through the shipped `plansService`, one batch at a
// time (the sanctioned setup reach `plans-review-seed.ts` uses), because the
// lane's motir-ai mock proposes nothing.
//
// ONE browser seam is held: the hosted run's JOB STREAM. The anchored door
// (`POST …/ai/plan`) runs for real and opens the `generating` plan, but in this
// lane its job settles at once — and a settled run stops watching its plan
// (`endLive`), which would end the live pane before anything was written. So the
// stream is held open while the plan is written, exactly as a real planner's run
// is open while it writes, and released once the plan is closed.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Every arrival is awaited on its authoritative signals: the card's node in the
// DOM, and the `data-motion` it carried, recorded by an in-page MutationObserver
// (a node's `enter` mark lives for one play, so it is RECORDED, not polled for).
// Only THEN does the recording pause, for a viewer: `arrivalPause()` holds at
// least two poll intervals plus the entrance, so each card and its arrow are
// seen landing. Pacing, never waiting — remove every hold and every assertion is
// unchanged (`acceptance-video.ts` § Pacing).

const planReview = en.planReview;
const surface = en.approvalGate.planApproval.surface;

/** Part XXIII's entrance: `--transition-slow` (≤ 320ms in every theme) plus the
 *  stagger cap (160ms). */
const ENTRANCE_MS = 480;
/** The hold after an arrival — at least 2 × POLL_MS plus the entrance. */
const ARRIVAL_HOLD_MS = 2 * POLL_MS + ENTRANCE_MS;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
const liveState = (page: Page) => workspace(page).getByTestId('plan-live-state');
const viewButton = (page: Page, name: string) =>
  workspace(page)
    .getByRole('group', { name: planReview.viewSwitchAria })
    .getByRole('button', { name, exact: true });
const list = (page: Page) => workspace(page).getByTestId('plan-proposal-list');
const nodeLayer = (page: Page) => workspace(page).getByTestId('canvas-world');
const edges = (page: Page) => workspace(page).locator('[data-testid="canvas-edges"] path');
const node = (page: Page, title: string) =>
  nodeLayer(page).locator('[data-node-id]').filter({ hasText: title });
const arrivals = (page: Page) => workspace(page).getByTestId('canvas-arrivals-offer');
const noTurnsNote = (page: Page) => rail(page).getByTestId('planning-mcp-no-turns');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const overlayOpen = (url: URL) => url.searchParams.has('plan');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });

// ── The motion record ────────────────────────────────────────────────────────

interface MotionEvent {
  /** `node` = a card on the node layer; `edge` = an arrow on the edge layers. */
  layer: 'node' | 'edge';
  motion: string;
  /** The card's text when it was marked — how a card is named across ids. */
  text: string;
}

/**
 * Record every `data-motion` mark the canvas puts on a node or an arrow.
 *
 * A mark lives for exactly one play (a few hundred ms), and a new card carries
 * its `enter` from its FIRST render — so it is observed at insertion as well as
 * on attribute change, and kept, rather than polled for and missed.
 */
const MOTION_RECORDER = () => {
  const w = window as unknown as { __motion: MotionEvent[] };
  w.__motion = [];
  const note = (el: Element) => {
    const motion = el.getAttribute('data-motion');
    if (!motion) return;
    const layer = el.hasAttribute('data-node-id') ? 'node' : el.tagName === 'path' ? 'edge' : null;
    if (!layer) return;
    w.__motion.push({ layer, motion, text: (el.textContent ?? '').slice(0, 200) });
  };
  const scan = (root: Node) => {
    if (!(root instanceof Element)) return;
    note(root);
    root.querySelectorAll('[data-motion]').forEach(note);
  };
  const start = () =>
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') note(r.target as Element);
        else r.addedNodes.forEach(scan);
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-motion'],
    });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
};

const motionLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motion?: MotionEvent[] }).__motion ?? []);

const marked = async (page: Page, layer: 'node' | 'edge', motion: string, text?: string) =>
  (await motionLog(page)).filter(
    (e) => e.layer === layer && e.motion === motion && (!text || e.text.includes(text)),
  ).length;

// ── Steps ────────────────────────────────────────────────────────────────────

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

/**
 * Hold the hosted run's job stream OPEN until `release()` — the run is writing.
 * On release it ends as a real stream does (`done`), and the run settles through
 * its shipped tail.
 */
async function holdRunStream(page: Page): Promise<{ release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/work-items/*/ai/plan/*/stream', async (route: Route) => {
    await released;
    await route
      .fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: done\ndata: {}\n\n',
      })
      .catch(() => {
        /* the page moved on — nothing is waiting for this stream any more */
      });
  });
  return { release };
}

async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Ask from the CARD; the door's 200 is "the session holds this turn and its
 *  plan is open". Returns that `generating` plan's id. */
async function askFromCard(page: Page, email: string, text: string): Promise<string> {
  const answered = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await composer(page).press('Enter');
  expect((await answered).status()).toBe(200);
  const session = await latestPlanningSession(email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  expect(plan.status).toBe('generating');
  return plan.id;
}

/** The pane is LIVE: the shared views are mounted, marked *Being written*. */
async function paneIsLive(page: Page): Promise<void> {
  await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(liveState(page)).toContainText(planReview.liveWriting);
  await viewButton(page, planReview.viewCanvas).click();
  // The canvas, not its node layer: `canvas-world` is a 0×0 transformed origin
  // whose cards are absolutely placed, so it never reads as visible itself.
  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
}

/** A card ARRIVED: its node is on the level, and it played its entrance. */
async function arrived(page: Page, title: string, opts: { motion?: boolean } = {}): Promise<void> {
  await expect(node(page, title)).toHaveCount(1, { timeout: 4 * POLL_MS });
  await expect(node(page, title)).toBeVisible();
  if (opts.motion !== false) {
    await expect
      .poll(() => marked(page, 'node', 'enter', title), { timeout: 4 * POLL_MS })
      .toBeGreaterThan(0);
  }
}

async function edgeCountIs(page: Page, n: number): Promise<void> {
  await expect.poll(() => edges(page).count(), { timeout: 4 * POLL_MS }).toBe(n);
}

/** Each card's box, by title — the "nothing moved" measure. */
async function boxes(page: Page, titles: readonly string[]): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const title of titles) {
    const b = await node(page, title).boundingBox();
    expect(b, `${title} has a box`).not.toBeNull();
    out[title] = [b!.x, b!.y, b!.width, b!.height];
  }
  return out;
}

function expectSameBoxes(before: Record<string, number[]>, after: Record<string, number[]>) {
  for (const [title, box] of Object.entries(before)) {
    const now = after[title]!;
    box.forEach((v, i) => {
      expect(Math.abs(now[i]! - v), `${title} box[${i}] moved`).toBeLessThanOrEqual(1);
    });
  }
}

// The hosted plan's cards.
const A = 'Lift the shared views';
const B = 'Mount them on the surface';
const C = 'Walk it in a browser';
const ELSEWHERE = 'Tidy the Plans row';
// The agent's cards.
const MCP_TITLE = 'Agent plan — live drawing follow-ups';
const E = 'Poll the plan while it is written';
const F = 'Count arrivals on other levels';
const G = 'Announce each batch once';
const H = 'Speak the List in the present tense';

test.describe.configure({ timeout: 420_000 });

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  resetJobsFixture();
  await page.addInitScript(MOTION_RECORDER);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a plan is drawn as it is written — by Motir AI, then by an agent over MCP', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6158');
  /** The viewer's pause after an arrival — on top of the signal wait, never instead. */
  const arrivalPause = async () => {
    await beat();
    await new Promise((resolve) => setTimeout(resolve, ARRIVAL_HOLD_MS - BEAT_MS));
  };

  const email = `live-drawing-${Date.now()}@example.com`;
  const seed: LiveDrawingSeed = await seedLiveDrawing(email);
  const { ctx } = seed;
  await stubAiAccess(page);
  const stream = await holdRunStream(page);
  await signIn(page, email, LIVE_DRAWING_PASSWORD);

  let planId = '';
  const ids: Record<string, string> = {};

  await chapter('Ask Motir AI to plan this story — the pane goes live', async () => {
    await openFromCard(page, seed.storyKey);
    planId = await askFromCard(page, email, 'Split the live-drawing work into buildable cards.');
    await paneIsLive(page);
    // The level the reader stood on: the story's own finished card is already here.
    await expect(node(page, seed.doneTitle)).toBeVisible();
    await edgeCountIs(page, 0);
    await beat();
  });

  await chapter('Case 1 — the first card arrives inside the story', async () => {
    const r = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: A, kind: 'subtask' }, parentRef: seed.storyId }],
      ctx,
    );
    ids[A] = r.appendedItemIds[0]!;
    await arrived(page, A);
    await edgeCountIs(page, 0);
    await arrivalPause();
  });

  await chapter('Case 1 — the second card arrives with its arrow', async () => {
    const r = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: B, kind: 'subtask' },
          parentRef: seed.storyId,
          blockedByRefs: [`planItem:${ids[A]}`],
        },
      ],
      ctx,
    );
    ids[B] = r.appendedItemIds[0]!;
    await arrived(page, B);
    // The arrow lands WITH the blocked card, and draws in.
    await edgeCountIs(page, 1);
    await expect.poll(() => marked(page, 'edge', 'enter'), { timeout: 4 * POLL_MS }).toBe(1);
    await arrivalPause();
  });

  await chapter('Case 1 — the third card arrives', async () => {
    const r = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: C, kind: 'subtask' }, parentRef: seed.storyId }],
      ctx,
    );
    ids[C] = r.appendedItemIds[0]!;
    await arrived(page, C);
    await edgeCountIs(page, 1);
    await expect(liveState(page)).toContainText(planReview.liveWriting);
    await arrivalPause();
  });

  await chapter('Case 2 — a rewire: the third card now depends on the first', async () => {
    const enteredBefore = await marked(page, 'edge', 'enter');
    await plansService.correctProposal(
      planId,
      ids[C]!,
      { blockedByRefs: [`planItem:${ids[A]}`] },
      ctx,
    );
    await edgeCountIs(page, 2);
    await expect
      .poll(() => marked(page, 'edge', 'enter'), { timeout: 4 * POLL_MS })
      .toBeGreaterThan(enteredBefore);
    await arrivalPause();
  });

  await chapter('Case 2 — a withdrawal: the card leaves, taking its arrow', async () => {
    await plansService.withdrawProposal(planId, ids[B]!, ctx);
    // The CARD fades out (Part XXIII §23.3, EXIT: `opacity 1 → 0`, `scale(0.96)`):
    // the node retained for its exit must still carry the card that is leaving —
    // an empty retained box fades nothing a person can see.
    await expect
      .poll(() => marked(page, 'node', 'exit', B), {
        timeout: 4 * POLL_MS,
        message: `the retained exit node carries the leaving card "${B}"`,
      })
      .toBeGreaterThan(0);
    await expect(node(page, B)).toHaveCount(0);
    await edgeCountIs(page, 1);
    await arrivalPause();
  });

  await chapter('Case 7 — a card lands under another story: counted, not followed', async () => {
    const before = await boxes(page, [A, C, seed.doneTitle]);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: ELSEWHERE, kind: 'subtask' },
          parentRef: seed.elsewhereId,
        },
      ],
      ctx,
    );
    // The level indicator counts it, naming where it landed…
    await expect(arrivals(page)).toBeVisible({ timeout: 4 * POLL_MS });
    await expect(arrivals(page)).toContainText(`1 new in ${seed.elsewhereKey}`);
    // …and the reader was NOT moved: same level, same cards, same places.
    await expect(node(page, ELSEWHERE)).toHaveCount(0);
    expectSameBoxes(before, await boxes(page, [A, C, seed.doneTitle]));
    await arrivalPause();
  });

  await chapter('Case 1 — the plan is closed: the bar appears, and nothing moves', async () => {
    const before = await boxes(page, [A, C, seed.doneTitle]);
    const edgesBefore = await edges(page).count();
    await plansService.markPlanned(planId, ctx);
    // The bar arrives with the hand-over, and the live marker leaves.
    await expect(bar(page)).toBeVisible({ timeout: 4 * POLL_MS });
    await expect(liveState(page)).toHaveCount(0);
    // The run ends as a real one does, once it has written its plan — until then
    // the bar holds its verbs ("writing a new version"), which is the shipped gate.
    stream.release();
    await expect(verb(bar(page), surface.approve)).toBeEnabled({ timeout: 4 * POLL_MS });
    await expect(bar(page)).toContainText(surface.consequence);
    expectSameBoxes(before, await boxes(page, [A, C, seed.doneTitle]));
    expect(await edges(page).count()).toBe(edgesBefore);
    await beat();
  });

  await chapter('Case 6 — the finished card looks as it does on the roadmap', async () => {
    const done = node(page, seed.doneTitle);
    await expect(done).toBeVisible();
    await expect(done.getByTestId('plan-item-lock-hatch')).toHaveCount(0);
    await expect(done.locator('[data-locked="true"]')).toHaveCount(0);
    await beat();
  });

  await chapter('Case 6 — approve: the approved card carries one outcome spine', async () => {
    const decided = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
    );
    await verb(bar(page), surface.approve).click();
    expect((await decided).ok()).toBe(true);
    await expect
      .poll(async () => (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status, {
        timeout: 20_000,
      })
      .toBe('approved');
    await expect(node(page, A).locator('[data-testid$="outcome-spine"]')).toHaveCount(1);
    await expect(node(page, seed.doneTitle).getByTestId('plan-item-lock-hatch')).toHaveCount(0);
    await beat();
  });

  // ── The agent ──────────────────────────────────────────────────────────────

  const agent = await agentSession(seed.token, baseURL!);
  let mcpPlanId = '';
  const mcpIds: Record<string, string> = {};
  const addOverMcp = async (proposals: unknown[]): Promise<string[]> => {
    const r = (await agent.callTool({
      name: ADD_PLAN_ITEMS_TOOL_NAME,
      arguments: { planId: mcpPlanId, proposals },
    })) as CallToolResult;
    if (r.isError) throw new Error(`add_plan_items refused: ${JSON.stringify(r.content)}`);
    return (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
  };

  try {
    await chapter(
      'Case 3 — an agent opens a plan over MCP; the reviewer opens it from Plans',
      async () => {
        const created = (await agent.callTool({
          name: CREATE_PLAN_TOOL_NAME,
          arguments: {
            projectKey: seed.projectKey,
            title: MCP_TITLE,
            summary: MCP_TITLE,
            plannedWithHarness: AGENT_HARNESS,
            plannedWithModel: AGENT_MODEL,
          },
        })) as CallToolResult;
        if (created.isError)
          throw new Error(`create_plan refused: ${JSON.stringify(created.content)}`);
        mcpPlanId = (created.structuredContent as unknown as { id: string }).id;

        await page.goto('/plans');
        await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        const row = sessionsList(page).getByRole('listitem').filter({ hasText: MCP_TITLE });
        await row.getByRole('link', { name: MCP_TITLE }).click();
        await page.waitForURL((url) => url.searchParams.has('planSession'));
        await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

        // The rail names the harness the conversation happened in, and still takes a turn.
        await expect(noTurnsNote(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(noTurnsNote(page)).toContainText(AGENT_HARNESS);
        await expect(composer(page)).toBeEnabled();
        await paneIsLive(page);
        await beat();
      },
    );

    await chapter('Case 3 — the agent’s first card arrives, without a reload', async () => {
      await page.evaluate(() => {
        (window as unknown as { __noReload: boolean }).__noReload = true;
      });
      const [e] = await addOverMcp([
        { op: 'add', proposedFields: { title: E, kind: 'subtask' }, parentRef: seed.storyKey },
      ]);
      mcpIds[E] = e!;
      // A session opened from Plans stands at the ROOT; the plan's FIRST proposal
      // carries the canvas to the level it lands on, once (§23.8). A level opened
      // already populated plays nothing, so this card is asserted by presence.
      await arrived(page, E, { motion: false });
      await arrivalPause();
    });

    let edgeBase = 0;
    await chapter('Case 3 — the next two cards arrive, one with its arrow', async () => {
      edgeBase = await edges(page).count();
      const [f, g] = await addOverMcp([
        {
          op: 'add',
          proposedFields: { title: F, kind: 'subtask' },
          parentRef: seed.storyKey,
          blockedByRefs: [`planItem:${mcpIds[E]}`],
        },
        { op: 'add', proposedFields: { title: G, kind: 'subtask' }, parentRef: seed.storyKey },
      ]);
      mcpIds[F] = f!;
      mcpIds[G] = g!;
      await arrived(page, F);
      await arrived(page, G);
      await edgeCountIs(page, edgeBase + 1);
      await arrivalPause();
    });

    await chapter('Case 3 — the agent rewires a card: its arrow moves', async () => {
      const exitsBefore = await marked(page, 'edge', 'exit');
      const entersBefore = await marked(page, 'edge', 'enter');
      const r = (await agent.callTool({
        name: UPDATE_PLAN_PROPOSAL_TOOL_NAME,
        arguments: {
          planId: mcpPlanId,
          planItemId: mcpIds[F],
          blockedByRefs: [`planItem:${mcpIds[G]}`],
        },
      })) as CallToolResult;
      if (r.isError) throw new Error(`update_plan_proposal refused: ${JSON.stringify(r.content)}`);
      await expect
        .poll(() => marked(page, 'edge', 'exit'), { timeout: 4 * POLL_MS })
        .toBeGreaterThan(exitsBefore);
      await expect
        .poll(() => marked(page, 'edge', 'enter'), { timeout: 4 * POLL_MS })
        .toBeGreaterThan(entersBefore);
      await edgeCountIs(page, edgeBase + 1);
      await arrivalPause();
    });

    await chapter('Case 4 — List, live: a row appears as the agent writes it', async () => {
      await viewButton(page, planReview.viewList).click();
      await expect(list(page)).toBeVisible();
      for (const title of [E, F, G]) {
        await expect(list(page).getByText(title, { exact: false }).first()).toBeVisible();
      }
      await expect(list(page).getByText(H, { exact: false })).toHaveCount(0);
      await beat();
      await addOverMcp([
        { op: 'add', proposedFields: { title: H, kind: 'subtask' }, parentRef: seed.storyKey },
      ]);
      await expect(list(page).getByText(H, { exact: false }).first()).toBeVisible({
        timeout: 4 * POLL_MS,
      });
      await expect(liveState(page)).toContainText(planReview.liveWriting);
      // Nothing was reloaded: the marker set before the agent wrote is still here.
      expect(
        await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
      ).toBe(true);
      await arrivalPause();
    });
  } finally {
    await agent.close();
  }
});

// ── UNRECORDED — reduced motion ──────────────────────────────────────────────

test('under reduced motion every card and arrow still arrives, and nothing animates', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const email = `live-drawing-rm-${Date.now()}@example.com`;
  const seed = await seedLiveDrawing(email);
  const { ctx } = seed;
  await stubAiAccess(page);
  const stream = await holdRunStream(page);
  await signIn(page, email, LIVE_DRAWING_PASSWORD);

  await openFromCard(page, seed.storyKey);
  const planId = await askFromCard(
    page,
    email,
    'Split the live-drawing work into buildable cards.',
  );
  await paneIsLive(page);

  const runningOnNodeLayer = () =>
    nodeLayer(page).evaluate(
      (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
    );

  const first = await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title: A, kind: 'subtask' }, parentRef: seed.storyId }],
    ctx,
  );
  await arrived(page, A, { motion: false });
  expect(await runningOnNodeLayer()).toBe(0);

  await plansService.addProposals(
    planId,
    [
      {
        op: 'add',
        proposedFields: { title: B, kind: 'subtask' },
        parentRef: seed.storyId,
        blockedByRefs: [`planItem:${first.appendedItemIds[0]}`],
      },
    ],
    ctx,
  );
  await arrived(page, B, { motion: false });
  await edgeCountIs(page, 1);
  expect(await runningOnNodeLayer()).toBe(0);
  // Both cards and the arrow are drawn — reduced motion drops the movement, not the change.
  await expect(node(page, A)).toBeVisible();
  await expect(node(page, B)).toBeVisible();

  stream.release();
});
