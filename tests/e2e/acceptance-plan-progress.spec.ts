import { writeFileSync } from 'node:fs';
import type { Browser, Locator, Page, Route } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import {
  backdatePlanActivity,
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { plansService } from '@/lib/services/plansService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { WORKBENCH_PATH, workbenchTabHref } from '@/lib/workbench/tab';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { WorkbenchPlanningPageDto } from '@/lib/dto/home';
import type { PlanStepKindDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';

// MOTIR-7835 — the plan-progress E2E + ACCEPTANCE VIDEO for MOTIR-7820.
//
// The story's claim, in a real browser: a person who asked for a plan can LEAVE
// it, find it again on the Workbench › Planning tab, open it where it is being
// written, and watch the drafting marks move across the canvas as the planner
// moves — for Motir AI's hosted planner and for an MCP planner alike. A plan that
// stalls says so on the row and on the surface; a proposed plan leaves the tab.
//
// ── Why this cannot be a lower tier ─────────────────────────────────────────
// The core integration gate (MOTIR-7834) already proves the rows: a step through
// either door is read back on the one poll and on the tab's read as the same
// progress, and stalled holds on the server clock. What only a browser shows is
// a person FOLLOWING the plan — a tab, a row, a mark moving between cards, the
// reduced-motion media query, and a 2.5 s poll that has to be met, not raced.
//
// ── What is real, and what is not ───────────────────────────────────────────
// The planners are PLAYED, not run: this lane's motir-ai is a mock that proposes
// nothing, and `plan.py` is not in this repository. Each planner's own gate
// proves it reports at the right moment. This spec drives the two DOORS exactly
// as each planner does:
//   · the MCP planner (what `prompts/plan.py` does) goes through the real MCP SDK
//     against this lane's `/api/mcp`, with a minted token carrying
//     `ai:view_plan` — `create_plan`, `add_plan_items`, `update_plan_item`,
//     `withdraw_plan_proposal` and `report_plan_step`. Nothing is stubbed;
//   · the HOSTED planner opens its plan through the real anchored `POST …/ai/plan`
//     door, and has its job stream held open while it writes (the live-drawing
//     spec's one browser seam — a settled run stops watching its plan). Its
//     proposals are written through `plansService`, one batch at a time. Its
//     STEPS go through `aiGenerationService.recordPlanStepForJob` — the SAME
//     service method `POST /api/internal/ai/plan-step` delegates to — and its
//     close through `aiGenerationService.appendProposals(…, { final: true })`,
//     the method `POST /api/internal/ai/plan-proposals` delegates to. Both are
//     called in the runner process, against the lane's own database.
//
// ⚠️ WHY THE HOSTED STEP IS NOT AN HTTP CALL. The internal ai routes sit behind
// the `CORE_CALLBACK_SECRET` service bearer plus a job token, and this lane's
// server holds no such secret (it is in neither `.env`, the Playwright configs
// nor the CI workflows), so the route answers 401 here — and stubbing it would
// test the harness. `planner-bug-destination.spec.ts` documents the same
// constraint and the same remedy. The principal handed to the method is the one
// the route itself AUTHENTICATES TO: `authenticateJobRequest` resolves the job
// token's claims into `{ ctx: { userId: sub, workspaceId }, projectId }`, and a
// hosted job's token is minted for the person who asked in the plan's project.
// So the call carries exactly that — the reader's id, their workspace, the
// plan's project — and the job id is the plan's own `sourceJobId`, which the
// method resolves the plan from. Nothing about the method is bypassed.
//
// THE LIVE READS ARE NEVER INTERCEPTED. The canvas, the progress line and the
// tab row all read the real `GET /api/plans/[id]` poll and the real Workbench
// Planning read (`GET /api/workbench/planning` and the tab's server render).
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// After a door call the spec waits for the next `GET /api/plans/[id]` response
// whose BODY carries that step in `inFlightSteps` (armed before the call), and
// only then asserts the DOM. For the tab it waits on the Workbench read: the
// tab's server render on a navigation, or a `GET /api/workbench/planning` poll
// response whose body carries the change. Stalled waits for a poll response
// observed AFTER the backdate. Nothing sleeps to wait for state; the receipt's
// holds (`beat()`, `chapter()`'s own) are pacing for a viewer only — remove
// every one and every assertion is unchanged (`acceptance-video.ts` § Pacing).
//
// EVERY ASSERTED WORDING is read from `messages/en.json` — the progress design's
// `planReview.progress.*` / `planReview.live*`, the Planning tab's
// `workbench.planning.*` / `workbench.tabs.*` / `workbench.empty.planning.*`, and
// the canvas slot's `planningWorkspace.arrival.*` — never retyped.

const planReview = en.planReview;
const progress = en.planReview.progress;
const workbench = en.workbench;
const planning = en.workbench.planning;
const arrival = en.planningWorkspace.arrival;
const planRowCopy = en.approvalGate.planApproval.row;

// ── Copy helpers — the catalogue's own templates, filled ─────────────────────

/** Fill a `{name}` template from the catalogue. */
const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
/** A rich message's text: its `<tag>…</tag>` markup removed, the chunks kept. */
const textOf = (template: string): string => template.replace(/<\/?\w+>/g, '');
/** A template as a pattern — each `{placeholder}` matches any value. */
const patternOf = (template: string, placeholder = '.+?'): string =>
  escapeRegExp(template).replace(/\\\{\w+\\\}/g, placeholder);
const anyOf = (...templates: string[]): RegExp =>
  new RegExp(templates.map((t) => patternOf(t, '\\d+')).join('|'));

const authoring = (title: string) => fill(progress.authoring, { title });
const authored = (n: number, m: number) => fill(progress.authored, { authored: n, proposed: m });
/** The design's elapsed formats (§25.4): `<1 min` · `{m} min` · `{h} h {m} min`. */
const ELAPSED = anyOf(progress.elapsedUnderMinute, progress.elapsedMinutes, progress.elapsedHours);
/** The design's last-activity formats (§25.4). */
const LAST_ACTIVITY = new RegExp(
  [progress.lastActivityJustNow, progress.lastActivitySeconds, progress.lastActivityAgo]
    .map((t) => patternOf(t))
    .join('|'),
);
const STALLED_FOR = new RegExp(patternOf(progress.stalledFor));
/** The tab's text: its label, then its count chip (absent while every count is 0). */
const tabText = (count: number, chipMayBeAbsent = false): RegExp =>
  new RegExp(
    `^${escapeRegExp(workbench.tabs.planning)}\\s*${chipMayBeAbsent ? `(?:${count})?` : count}$`,
  );

// ── Locators — every one scoped to a role-resolved subtree ───────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
const liveState = (page: Page) => workspace(page).getByTestId('plan-live-state');
const paneProgress = (page: Page) => workspace(page).getByTestId('plan-progress');
const paneSteps = (page: Page) => paneProgress(page).getByTestId('plan-progress-steps');
const viewButton = (page: Page, name: string) =>
  workspace(page)
    .getByRole('group', { name: planReview.viewSwitchAria })
    .getByRole('button', { name, exact: true });
const nodeLayer = (page: Page) => workspace(page).getByTestId('canvas-world');
const node = (page: Page, title: string) =>
  nodeLayer(page).locator('[data-node-id]').filter({ hasText: title });
const cuedNodes = (page: Page) => nodeLayer(page).locator('[data-node-id][data-cue]');
const arrivals = (page: Page) => workspace(page).getByTestId('canvas-arrivals-offer');
const canvasBack = (page: Page) =>
  workspace(page).getByRole('button', { name: en.roadmap.canvas.back, exact: true });
const closeWorkspace = (page: Page) =>
  workspace(page).getByRole('button', { name: en.planningWorkspace.close });

const tabStrip = (page: Page) => page.getByRole('navigation', { name: workbench.tabs.label });
const planningTab = (page: Page) => tabStrip(page).getByTestId('workbench-tab-planning');
const planningTable = (page: Page) => page.getByRole('table', { name: workbench.tabs.planning });
const planRow = (page: Page, text: string) =>
  planningTable(page).getByRole('row').filter({ hasText: text });
/** The row's door — named by `workbench.planning.rowAria`, whose sentence varies. */
const rowDoor = (row: Locator) =>
  row.getByRole('link', { name: planning.rowAria.split('{sentence}')[0]! });
const compact = (row: Locator) => row.getByTestId('plan-progress-compact');
const compactSteps = (row: Locator) => compact(row).getByTestId('plan-progress-steps');
const emptyState = (page: Page) => page.getByRole('main').getByTestId('planning-empty');

/** The Planning tab's address, and the query key every tab is spelled with —
 *  both read from `lib/workbench/tab.ts`, the one home of that spelling. */
const PLANNING_HREF = workbenchTabHref('planning');
const TAB_PARAM = [...new URL(PLANNING_HREF, 'http://workbench.local').searchParams.keys()][0]!;
const tabOf = (url: string | URL) => new URL(url).searchParams.get(TAB_PARAM);

const overlayOpen = (url: URL) =>
  url.searchParams.has('planSession') || url.searchParams.has('plan');

// ── The motion record (the live-drawing spec's recorder) ─────────────────────

interface MotionEvent {
  layer: 'node' | 'edge';
  motion: string;
  text: string;
}

/**
 * Record every `data-motion` mark the canvas puts on a node or an arrow — at
 * insertion and on attribute change, because a mark lives for one play and is
 * RECORDED rather than polled for.
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

const marked = async (page: Page, motion: string | null, text: string) =>
  (await motionLog(page)).filter(
    (e) => e.layer === 'node' && (motion === null || e.motion === motion) && e.text.includes(text),
  ).length;

// ── The authoritative signals ────────────────────────────────────────────────

type Steps = NonNullable<PlanReviewDto['inFlightSteps']>;
const ref = (planItemId: string) => `planItem:${planItemId}`;
const hasStep = (steps: Steps | undefined, sessionKey: string, targetRef: string | null) =>
  (steps ?? []).some((s) => s.sessionKey === sessionKey && s.targetRef === targetRef);

/**
 * The NEXT `GET /api/plans/[id]` response whose body satisfies `until` — the
 * live pane's own poll, never intercepted. Arm it BEFORE the door call.
 */
function planPolled(
  page: Page,
  planId: string,
  until: (body: PlanReviewDto) => boolean,
): Promise<unknown> {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return false;
      try {
        return until((await r.json()) as PlanReviewDto);
      } catch {
        return false;
      }
    },
    { timeout: 8 * POLL_MS },
  );
}

/** The Planning tab's poll cadence is `PLANNING_POLL_MS` (10 s, a client module
 *  the runner does not load); three of them is the budget for the next read. */
const WORKBENCH_READ_BUDGET_MS = 35_000;

/** The NEXT `GET /api/workbench/planning` response whose body satisfies `until`. */
function workbenchPolled(
  page: Page,
  until: (body: WorkbenchPlanningPageDto) => boolean,
): Promise<unknown> {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      if (new URL(r.url()).pathname !== '/api/workbench/planning') return false;
      try {
        return until((await r.json()) as WorkbenchPlanningPageDto);
      } catch {
        return false;
      }
    },
    { timeout: WORKBENCH_READ_BUDGET_MS },
  );
}

const rowOf = (body: WorkbenchPlanningPageDto, planId: string) =>
  body.items.find((r) => r.planId === planId);

// ── The hosted planner — the internal route's own service method ─────────────

interface HostedRun {
  planId: string;
  jobId: string;
  /** What `authenticateJobRequest` resolves a hosted job's token to. */
  auth: { ctx: ServiceContext; projectId: string };
}

async function hostedRunOf(planId: string, asker: ServiceContext): Promise<HostedRun> {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  expect(plan.sourceJobId, 'the hosted plan carries its job').not.toBeNull();
  return {
    planId,
    jobId: plan.sourceJobId!,
    auth: {
      ctx: { userId: asker.userId, workspaceId: plan.workspaceId },
      projectId: plan.projectId,
    },
  };
}

/** One step through `POST /api/internal/ai/plan-step`'s service method. */
async function hostedStep(
  run: HostedRun,
  sessionKey: string,
  step: PlanStepKindDto | 'end',
  targetRef: string | null = null,
): Promise<void> {
  await aiGenerationService.recordPlanStepForJob(
    { jobId: run.jobId, planId: run.planId, sessionKey, step, targetRef },
    run.auth,
  );
}

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
 * Exactly the live-drawing spec's seam: the anchored door runs for real, but in
 * this lane its job settles at once, and a settled run stops watching its plan.
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
  await page.waitForURL((url) => url.searchParams.has('plan'));
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

/** The pane is drawn on the CANVAS. The canvas itself, not its node layer:
 *  `canvas-world` is a 0×0 transformed origin that never reads as visible. */
async function showCanvas(page: Page): Promise<void> {
  await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await viewButton(page, planReview.viewCanvas).click();
  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
}

// ── The MCP planner — the real SDK over the lane's `/api/mcp` ────────────────

async function tool<T>(agent: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const r = (await agent.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name} refused: ${JSON.stringify(r.content)}`);
  return r.structuredContent as unknown as T;
}

async function mcpCreatePlan(
  agent: Client,
  seed: PlanProgressSeed,
  title: string,
  author: { harness?: string; model?: string } = {},
): Promise<string> {
  const created = await tool<{ id: string }>(agent, CREATE_PLAN_TOOL_NAME, {
    projectKey: seed.projectKey,
    title,
    summary: title,
    ...(author.harness ? { plannedWithHarness: author.harness } : {}),
    ...(author.model ? { plannedWithModel: author.model } : {}),
  });
  return created.id;
}

async function mcpAdd(
  agent: Client,
  planId: string,
  titles: readonly string[],
  parentRef: string,
): Promise<string[]> {
  const r = await tool<{ planItemIds: string[] }>(agent, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: titles.map((title) => ({
      op: 'add',
      proposedFields: { title, kind: 'subtask' },
      parentRef,
    })),
  });
  return r.planItemIds;
}

async function mcpStep(
  agent: Client,
  planId: string,
  sessionKey: string,
  step: PlanStepKindDto | 'end',
  target?: string,
): Promise<void> {
  await tool(agent, REPORT_PLAN_STEP_TOOL_NAME, {
    planId,
    sessionKey,
    step,
    ...(target ? { target } : {}),
  });
}

/** A LEAF's authored fields — description, explanation and the five sizing
 *  fields, so it passes the progress derivation's authored test. */
const AUTHORED_LEAF = {
  descriptionMd: 'What to build, and the boundary it stops at.',
  explanationMd: 'Why it matters to the person following the plan.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 3,
  estimateMinutes: 30,
  difficulty: 'medium',
} as const;

// ── Workbench › Planning ─────────────────────────────────────────────────────

/** Land on the tab — its server render IS the Workbench read for a navigation. */
async function openPlanningTab(page: Page): Promise<void> {
  await page.goto(PLANNING_HREF);
  await expect(planningTab(page)).toHaveAttribute('aria-current', 'page', {
    timeout: FIRST_PAINT_MS,
  });
}

/** Press the row's door; the plan opens over the tab, where it is being written. */
async function openRow(page: Page, row: Locator): Promise<void> {
  await rowDoor(row).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

// ── Geometry — the "nothing moved" measure ───────────────────────────────────

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

/** Sign a SECOND person in, in a context of their own (no recording). */
async function asSecondPerson(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, email, PLAN_PROGRESS_PASSWORD);
  return { page, close: () => context.close() };
}

// The hosted plan's cards.
const A = 'Read the step table on every poll';
const B = 'Name the step on the progress line';
const C = 'Count the authored cards';
const D = 'Mark the off-level drafting count';
// The MCP planners' cards and plans — every title distinct, none a substring of another.
const MCP_HARNESS = 'acme-planning-harness';
const MCP_MODEL = 'frontier-model-long-context';
const E = 'Report the author step on each session';
const F = 'Clear the step when a session ends';
const G = 'Write the quiet planner a body';
const H = 'Leave the second card bare';
const J = 'Withdraw the card being drafted';
const K = 'Keep the sibling card on the plan';
const L = 'Hold the ring still under reduced motion';
const M = 'Hold the chip still under reduced motion';
const S1 = 'Stall the first session';
const S2 = 'Recover on the second session';

let counter = 0;
const slug = () => `${Date.now()}-${++counter}`;

test.describe.configure({ timeout: 420_000 });

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  resetJobsFixture();
  await page.addInitScript(MOTION_RECORDER);
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('a plan is followed from the Workbench Planning tab back to its canvas, its drafting marks moving as the planner moves, until it is proposed and leaves the tab', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7820');

  const seed = await seedPlanProgress(slug());
  const ctx = seed.reader.ctx;
  await stubAiAccess(page);
  const stream = await holdRunStream(page);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  let planId = '';
  let run!: HostedRun;
  const ids: Record<string, string> = {};
  let paneWords = '';

  await chapter('Ask Motir AI for a plan — two cards are drafted at once', async () => {
    await openFromCard(page, seed.storyKey);
    planId = await askFromCard(page, seed.reader.email, 'Split the progress work into cards.');
    run = await hostedRunOf(planId, ctx);
    // Nothing proposed yet: the marker reads the design's *Starting…*.
    await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(liveState(page)).toHaveText(planReview.liveStarting, { timeout: 4 * POLL_MS });
    await showCanvas(page);

    // The planner lays the level: three cards under the story, one under its task.
    const laid = await plansService.addProposals(
      planId,
      [
        { op: 'add', proposedFields: { title: A, kind: 'task' }, parentRef: seed.storyId },
        { op: 'add', proposedFields: { title: B, kind: 'task' }, parentRef: seed.storyId },
        { op: 'add', proposedFields: { title: C, kind: 'task' }, parentRef: seed.storyId },
        { op: 'add', proposedFields: { title: D, kind: 'subtask' }, parentRef: seed.taskId },
      ],
      ctx,
    );
    [ids[A], ids[B], ids[C], ids[D]] = laid.appendedItemIds as [string, string, string, string];
    for (const title of [A, B, C]) {
      await expect(node(page, title)).toBeVisible({ timeout: 4 * POLL_MS });
    }

    // Two author sessions start CONCURRENTLY, as one parallel level does.
    const both = planPolled(
      page,
      planId,
      (b) =>
        hasStep(b.inFlightSteps, 'author-1', ref(ids[A]!)) &&
        hasStep(b.inFlightSteps, 'author-2', ref(ids[B]!)),
    );
    await Promise.all([
      hostedStep(run, 'author-1', 'author', ref(ids[A]!)),
      hostedStep(run, 'author-2', 'author', ref(ids[B]!)),
    ]);
    await both;

    await expect(node(page, A)).toHaveAttribute('data-cue', 'drafting');
    await expect(node(page, B)).toHaveAttribute('data-cue', 'drafting');
    await expect(node(page, C)).not.toHaveAttribute('data-cue');
    await expect(liveState(page)).toHaveText(planReview.liveWriting);
    // The line names one step and counts the other — *Authoring: …* · +1 more · 0 of 4 authored.
    await expect(paneProgress(page)).toContainText(fill(progress.moreSteps, { count: 1 }));
    await expect(paneProgress(page)).toContainText(authored(0, 4));
    paneWords = ((await paneSteps(page).textContent()) ?? '').trim();
    expect([authoring(A), authoring(B)]).toContain(paneWords);
    await beat();
  });

  await chapter('Leave it — and find it on Workbench › Planning', async () => {
    await page.goto(WORKBENCH_PATH);
    await expect(tabStrip(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    // The bare path is an entrance: it resolves to a tab — and never to Planning.
    await page.waitForURL((url) => url.searchParams.has(TAB_PARAM));
    expect(tabOf(page.url())).not.toBe('planning');
    await expect(planningTab(page)).not.toHaveAttribute('aria-current', 'page');
    // Planning sits right after the first tab, counting the one plan being written.
    await expect(tabStrip(page).getByRole('link').nth(1)).toHaveAttribute(
      'data-testid',
      'workbench-tab-planning',
    );
    await expect(planningTab(page)).toHaveText(tabText(1));

    await planningTab(page).click();
    await page.waitForURL((url) => tabOf(url) === 'planning');
    const row = planRow(page, seed.storyTitle);
    await expect(row).toHaveCount(1, { timeout: FIRST_PAINT_MS });
    await expect(row).toContainText(textOf(fill(planRowCopy.targeted, { name: seed.storyTitle })));
    await expect(row).toContainText(seed.storyKey);
    await expect(row).toContainText(planning.planner.motir);
    // The SAME step and the SAME count the surface showed a moment ago.
    await expect(compactSteps(row)).toHaveText(paneWords);
    await expect(compact(row)).toContainText(fill(progress.moreSteps, { count: 1 }));
    await expect(compact(row)).toContainText(authored(0, 4));
    await expect(compact(row)).toContainText(ELAPSED);
    await beat();
  });

  await chapter('Open it again — where it is being written', async () => {
    const row = planRow(page, seed.storyTitle);
    const read = planPolled(
      page,
      planId,
      (b) =>
        hasStep(b.inFlightSteps, 'author-1', ref(ids[A]!)) &&
        hasStep(b.inFlightSteps, 'author-2', ref(ids[B]!)),
    );
    await openRow(page, row);
    await read;
    await showCanvas(page);
    await expect(node(page, A)).toHaveAttribute('data-cue', 'drafting');
    await expect(node(page, B)).toHaveAttribute('data-cue', 'drafting');
  });

  await chapter('The mark moves — one session ends and drafts the third card', async () => {
    const moved = planPolled(
      page,
      planId,
      (b) =>
        hasStep(b.inFlightSteps, 'author-1', ref(ids[C]!)) &&
        !hasStep(b.inFlightSteps, 'author-1', ref(ids[A]!)) &&
        b.progress?.authored === 1,
    );
    await hostedStep(run, 'author-1', 'end');
    await hostedStep(run, 'author-1', 'author', ref(ids[C]!));
    // …and that session's writing lands: the third card is deepened.
    await plansService.correctProposal(planId, ids[C]!, AUTHORED_LEAF, ctx);
    await moved;

    await expect(node(page, A)).not.toHaveAttribute('data-cue');
    await expect(node(page, C)).toHaveAttribute('data-cue', 'drafting');
    await expect(node(page, B)).toHaveAttribute('data-cue', 'drafting');
    // The deepen plays the shipped mark on the card it changed.
    await expect.poll(() => marked(page, 'cue', C), { timeout: 4 * POLL_MS }).toBeGreaterThan(0);
    await expect(paneProgress(page)).toContainText(authored(1, 4));
    await beat();
  });

  await chapter('A card one level down is drafted — counted, not followed', async () => {
    const before = await boxes(page, [A, B, C, seed.taskTitle]);
    const drafted = planPolled(page, planId, (b) =>
      hasStep(b.inFlightSteps, 'author-3', ref(ids[D]!)),
    );
    await hostedStep(run, 'author-3', 'author', ref(ids[D]!));
    await drafted;
    await expect(arrivals(page)).toContainText(
      fill(arrival.draftingIn, { count: 1, identifier: seed.taskKey }),
    );
    // The canvas did NOT drill: same level, same cards, same places.
    await expect(node(page, D)).toHaveCount(0);
    expectSameBoxes(before, await boxes(page, [A, B, C, seed.taskTitle]));

    await beat();

    await arrivals(page).click();
    await expect(node(page, D)).toBeVisible();
    await expect(node(page, D)).toHaveAttribute('data-cue', 'drafting');
  });

  await chapter('A level is laid — the card being laid carries its mark', async () => {
    await canvasBack(page).click();
    await expect(node(page, A)).toBeVisible();
    const laying = planPolled(page, planId, (b) => hasStep(b.inFlightSteps, 'lay-1', seed.taskId));
    await hostedStep(run, 'lay-1', 'lay', seed.taskId);
    await laying;
    await expect(node(page, seed.taskTitle)).toHaveAttribute('data-cue', 'laying');
  });

  await chapter('It is proposed — the marks leave, and so does its row', async () => {
    const titles = [A, B, C, seed.taskTitle];
    const before = await boxes(page, titles);
    const closed = planPolled(page, planId, (b) => b.status !== 'generating');
    // The hosted walk's close — `final: true` on its last append.
    await aiGenerationService.appendProposals(run.jobId, [], run.auth.ctx, { final: true });
    await closed;
    await expect(liveState(page)).toHaveCount(0, { timeout: 4 * POLL_MS });
    await expect(paneProgress(page)).toHaveCount(0);
    await expect(cuedNodes(page)).toHaveCount(0);
    expectSameBoxes(before, await boxes(page, titles));
    stream.release();

    await openPlanningTab(page);
    await expect(planningTable(page)).toHaveCount(0);
    await expect(planningTab(page)).toHaveText(tabText(0, true));
    await expect(emptyState(page)).toBeVisible();
    await expect(emptyState(page)).toContainText(workbench.empty.planning.title);
    await beat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FURTHER TESTS — not the receipt, no pacing holds
// ─────────────────────────────────────────────────────────────────────────────

test('an MCP planner’s row names its harness and model, and its report moves the cue', async ({
  page,
  baseURL,
}) => {
  const seed = await seedPlanProgress(slug());
  const agent = await agentSession(seed.token, baseURL!);
  try {
    const title = 'Agent plan — progress signals';
    const planId = await mcpCreatePlan(agent, seed, title, {
      harness: MCP_HARNESS,
      model: MCP_MODEL,
    });
    const [e, f] = await mcpAdd(agent, planId, [E, F], seed.storyKey);
    await mcpStep(agent, planId, 'session-1', 'author', ref(e!));

    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
    await openPlanningTab(page);
    const row = planRow(page, title);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(
      textOf(fill(planning.planner.harnessModel, { harness: MCP_HARNESS, model: MCP_MODEL })),
    );
    await expect(compactSteps(row)).toHaveText(authoring(E));

    const read = planPolled(page, planId, (b) => hasStep(b.inFlightSteps, 'session-1', ref(e!)));
    await openRow(page, row);
    await read;
    await showCanvas(page);
    await expect(node(page, E)).toHaveAttribute('data-cue', 'drafting');

    // A second report on the SAME session names another add — the cue moves.
    const moved = planPolled(page, planId, (b) => hasStep(b.inFlightSteps, 'session-1', ref(f!)));
    await mcpStep(agent, planId, 'session-1', 'author', ref(f!));
    await moved;
    await expect(node(page, F)).toHaveAttribute('data-cue', 'drafting');
    await expect(node(page, E)).not.toHaveAttribute('data-cue');
    await expect(paneSteps(page)).toHaveText(authoring(F));
  } finally {
    await agent.close();
  }
});

test('a planner that never signals shows counts and times and no cue; a fresh plan reads Starting…', async ({
  page,
  baseURL,
}) => {
  const seed = await seedPlanProgress(slug());
  const agent = await agentSession(seed.token, baseURL!);
  try {
    const quietTitle = 'Agent plan — written without signals';
    const quietId = await mcpCreatePlan(agent, seed, quietTitle, { harness: MCP_HARNESS });
    const [g] = await mcpAdd(agent, quietId, [G, H], seed.storyKey);
    await tool(agent, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId: quietId,
      planItemId: g,
      ...AUTHORED_LEAF,
    });
    const freshTitle = 'Agent plan — nothing proposed yet';
    await mcpCreatePlan(agent, seed, freshTitle, { harness: MCP_HARNESS });

    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
    await openPlanningTab(page);
    await expect(planningTab(page)).toHaveText(tabText(2));

    // The quiet plan: counts, elapsed and last activity — and no step words.
    const quiet = planRow(page, quietTitle);
    await expect(compact(quiet)).toHaveAttribute('data-state', 'writing');
    await expect(compact(quiet)).toContainText(planReview.liveWriting);
    await expect(compact(quiet)).toContainText(authored(1, 2));
    await expect(compact(quiet)).toContainText(ELAPSED);
    await expect(compact(quiet)).toContainText(LAST_ACTIVITY);
    await expect(compactSteps(quiet)).toHaveCount(0);

    // The fresh plan: the design's *Starting…*.
    const fresh = planRow(page, freshTitle);
    await expect(compact(fresh)).toHaveAttribute('data-state', 'starting');
    await expect(compact(fresh)).toContainText(planReview.liveStarting);

    // On the surface the quiet plan draws its cards and marks none of them.
    const read = planPolled(page, quietId, (b) => b.status === 'generating');
    await openRow(page, quiet);
    await read;
    await showCanvas(page);
    await expect(node(page, G)).toBeVisible({ timeout: 4 * POLL_MS });
    await expect(node(page, H)).toBeVisible();
    await expect(cuedNodes(page)).toHaveCount(0);
    await expect(liveState(page)).toHaveText(planReview.liveWriting);
    await expect(paneProgress(page)).toContainText(authored(1, 2));
    await expect(paneSteps(page)).toHaveCount(0);
  } finally {
    await agent.close();
  }
});

test('a plan quiet past the stalled threshold reads stalled on the row and the surface, and one report brings it back', async ({
  page,
  baseURL,
}) => {
  const seed = await seedPlanProgress(slug());
  const agent = await agentSession(seed.token, baseURL!);
  try {
    const title = 'Agent plan — goes quiet';
    const planId = await mcpCreatePlan(agent, seed, title, { harness: MCP_HARNESS });
    const [s1, s2] = await mcpAdd(agent, planId, [S1, S2], seed.storyKey);
    await mcpStep(agent, planId, 'session-1', 'author', ref(s1!));

    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
    await openPlanningTab(page);
    const row = planRow(page, title);
    await expect(compact(row)).toHaveAttribute('data-state', 'writing');

    const opened = planPolled(page, planId, (b) => hasStep(b.inFlightSteps, 'session-1', ref(s1!)));
    await openRow(page, row);
    await opened;
    await showCanvas(page);
    await expect(node(page, S1)).toHaveAttribute('data-cue', 'drafting');

    // The server clock says nothing has happened for longer than the threshold.
    const at = await backdatePlanActivity(planId, PLAN_STALLED_AFTER_MS + 60_000);
    const backdated = (iso: string | undefined) =>
      iso !== undefined && Date.parse(iso) <= at.getTime();
    await planPolled(page, planId, (b) => backdated(b.lastActivityAt));
    await expect(liveState(page)).toHaveAttribute('data-state', 'stalled');
    await expect(liveState(page)).toHaveText(planReview.liveStalled);
    await expect(paneProgress(page)).toContainText(STALLED_FOR);
    await expect(cuedNodes(page)).toHaveCount(0);

    // …and the row says the same, on the tab's own read.
    const rowStalled = workbenchPolled(page, (b) =>
      backdated(rowOf(b, planId)?.progress.lastActivityAt),
    );
    await closeWorkspace(page).click();
    await page.waitForURL((url) => !overlayOpen(url));
    await rowStalled;
    await expect(compact(row)).toHaveAttribute('data-state', 'stalled');
    await expect(compact(row)).toContainText(planReview.liveStalled);
    await expect(compact(row)).toContainText(STALLED_FOR);
    await expect(compactSteps(row)).toHaveCount(0);

    // ONE fresh report — both read working again, and the cue returns.
    const rowBack = workbenchPolled(page, (b) =>
      (rowOf(b, planId)?.progress.steps ?? []).some(
        (s) => s.sessionKey === 'session-2' && s.targetRef === ref(s2!),
      ),
    );
    await mcpStep(agent, planId, 'session-2', 'author', ref(s2!));
    await rowBack;
    await expect(compact(row)).toHaveAttribute('data-state', 'writing');
    await expect(compactSteps(row)).toHaveText(authoring(S2));

    const surfaceBack = planPolled(page, planId, (b) =>
      hasStep(b.inFlightSteps, 'session-2', ref(s2!)),
    );
    await openRow(page, row);
    await surfaceBack;
    await showCanvas(page);
    await expect(liveState(page)).toHaveText(planReview.liveWriting);
    await expect(node(page, S2)).toHaveAttribute('data-cue', 'drafting');
  } finally {
    await agent.close();
  }
});

test('a step whose target is withdrawn marks nothing, and nothing errors', async ({
  page,
  baseURL,
}) => {
  const seed = await seedPlanProgress(slug());
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const agent = await agentSession(seed.token, baseURL!);
  try {
    const title = 'Agent plan — a card withdrawn mid-draft';
    const planId = await mcpCreatePlan(agent, seed, title, { harness: MCP_HARNESS });
    const [j] = await mcpAdd(agent, planId, [J, K], seed.storyKey);
    await mcpStep(agent, planId, 'session-1', 'author', ref(j!));

    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
    await openPlanningTab(page);
    const opened = planPolled(page, planId, (b) => hasStep(b.inFlightSteps, 'session-1', ref(j!)));
    await openRow(page, planRow(page, title));
    await opened;
    await showCanvas(page);
    await expect(node(page, J)).toHaveAttribute('data-cue', 'drafting');

    const gone = planPolled(page, planId, (b) => !b.items.some((i) => i.planItemId === j));
    await tool(agent, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, { planId, planItemId: j });
    await gone;
    await expect(node(page, J)).toHaveCount(0);
    await expect(node(page, K)).toBeVisible();
    await expect(cuedNodes(page)).toHaveCount(0);
    await expect(liveState(page)).toHaveText(planReview.liveWriting);
    await expect(paneSteps(page)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await agent.close();
  }
});

test('under reduced motion the cued boxes carry the static cue, and the cue plays no motion', async ({
  page,
  baseURL,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const seed = await seedPlanProgress(slug());
  const agent = await agentSession(seed.token, baseURL!);
  try {
    const title = 'Agent plan — read with reduced motion';
    const planId = await mcpCreatePlan(agent, seed, title, { harness: MCP_HARNESS });
    const [l, m] = await mcpAdd(agent, planId, [L, M], seed.storyKey);

    await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
    await openPlanningTab(page);
    const opened = planPolled(page, planId, (b) => b.status === 'generating');
    await openRow(page, planRow(page, title));
    await opened;
    await showCanvas(page);
    await expect(node(page, L)).toBeVisible({ timeout: 4 * POLL_MS });
    await expect(node(page, M)).toBeVisible();
    const motionBefore: Record<string, number> = {
      [L]: await marked(page, null, L),
      [M]: await marked(page, null, M),
    };

    const both = planPolled(
      page,
      planId,
      (b) =>
        hasStep(b.inFlightSteps, 'session-1', ref(l!)) &&
        hasStep(b.inFlightSteps, 'session-2', ref(m!)),
    );
    await Promise.all([
      mcpStep(agent, planId, 'session-1', 'author', ref(l!)),
      mcpStep(agent, planId, 'session-2', 'author', ref(m!)),
    ]);
    await both;

    for (const t of [L, M]) {
      await expect(node(page, t)).toHaveAttribute('data-cue', 'drafting');
      await expect(node(page, t)).toHaveClass(/(^|\s)canvas-node--drafting(\s|$)/);
      // The ring is drawn, and drawn STILL.
      const running = await node(page, t)
        .locator('.canvas-cue-ring')
        .evaluate(
          (el) =>
            el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
        );
      expect(running, `${t}'s cue ring animates`).toBe(0);
      // The cue caused no `data-motion` on the box.
      expect(await marked(page, null, t), `${t} recorded motion from its cue`).toBe(
        motionBefore[t],
      );
    }
  } finally {
    await agent.close();
  }
});

test('the tab lists only the reader’s own plans — a teammate’s plan is theirs', async ({
  page,
  browser,
  baseURL,
}) => {
  const seed = await seedPlanProgress(slug());
  const mine = 'Reader plan — my own';
  const theirs = 'Teammate plan — theirs alone';
  await plansService.createPlan(
    seed.projectId,
    { title: mine, summary: mine, createdById: seed.reader.userId },
    seed.reader.ctx,
  );
  await plansService.createPlan(
    seed.projectId,
    { title: theirs, summary: theirs, createdById: seed.teammate.userId },
    seed.teammate.ctx,
  );

  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  await openPlanningTab(page);
  await expect(planRow(page, mine)).toHaveCount(1);
  await expect(planRow(page, theirs)).toHaveCount(0);
  await expect(planningTab(page)).toHaveText(tabText(1));

  const teammate = await asSecondPerson(browser, baseURL!, seed.teammate.email);
  try {
    await openPlanningTab(teammate.page);
    await expect(planRow(teammate.page, theirs)).toHaveCount(1);
    await expect(planRow(teammate.page, mine)).toHaveCount(0);
    await expect(planningTab(teammate.page)).toHaveText(tabText(1));
  } finally {
    await teammate.close();
  }
});

test('a reader with no plan being written sees the empty state', async ({ page }) => {
  const seed = await seedPlanProgress(slug());
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  await openPlanningTab(page);
  await expect(emptyState(page)).toBeVisible();
  await expect(emptyState(page)).toContainText(workbench.empty.planning.title);
  await expect(emptyState(page)).toContainText(workbench.empty.planning.body);
  await expect(planningTable(page)).toHaveCount(0);
  await expect(planningTab(page)).toHaveText(tabText(0, true));
});
