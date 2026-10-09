import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanProgress, PLAN_PROGRESS_PASSWORD } from './_helpers/plan-progress-seed';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// MOTIR-7982 — the per-call line E2E + ACCEPTANCE VIDEO for Story MOTIR-7974.
//
// The story's claim, in a real browser: while Motir AI writes a plan, the rail
// says what the planner is doing RIGHT NOW — one plain line per tool call, shown
// as the call starts, under the step it belongs to, in en and in zh.
//
// ── What is real, and what is not ───────────────────────────────────────────
// The planner is PLAYED, not run (as in MOTIR-7835's `acceptance-plan-progress
// .spec.ts`): this lane's motir-ai is a mock whose job stream is one fixed body
// (`lib/test-ai-jobs-mock.ts`). What is real:
//   · the person asks from the card's composer, and the anchored door
//     `POST /api/work-items/{key}/ai/plan` submits a real `plan` job to the jobs
//     mock — the session and plan rows are written in Postgres;
//   · the page's `consumeStream`, `applyPlanFrame`, `narrateFrame` and the
//     rail's grouping, live line, marks, truncation and `aria-live` region.
//
// THE INCREMENTAL-STREAM SEAM. A whole-body reply cannot show a line appearing
// as its call starts — every frame would land in one chunk, and both the undici
// mock and `route.fulfill` answer with one body. So the browser's own request
// for `**/api/work-items/*/ai/plan/*/stream` is re-targeted with
// `route.continue({ url })` at a RUNNER-LOCAL SSE server
// (`_helpers/sse-frame-server.ts`) that holds the connection open and writes a
// frame only when this spec says so. Each frame is written AFTER the assertion
// on the previous one, so the order a reviewer watches is the order the
// assertions proved. The frames are the contract's shapes
// (`lib/planning/planChangeFrames.ts`), as motir-ai's emitters send them.
//
// WHAT THE SEAM SKIPS, AND WHO PROVES IT:
//   · the server-side relay — its byte-identical passthrough of `tool_call`,
//     `retrieval.callId` and `tool_call_failed` is pinned by
//     `tests/api/plan-job-stream-relay-tool-call.test.ts`, and the relay →
//     reader → fold → rail chain is re-driven on a RECORDED stream by the
//     motir-core integration gate (MOTIR-7981,
//     `tests/integration/planning/toolCallNarrationStoryGate.test.tsx`);
//   · that motir-ai sends these frames from a real walk, before each executor
//     runs, with the model surface byte-identical and token usage unchanged — the
//     motir-ai integration gate (MOTIR-7980, `tests/toolCallNarrationStoryGate
//     .test.ts` in motir-ai). This lane runs no model and claims none of it.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Every wait is a landmark, a response the page issued, the SSE server seeing
// the page's connection, or a rendered state. Nothing sleeps to wait for state;
// `beat()` and `chapter()`'s holds are pacing for a viewer only — remove every
// one and every assertion is unchanged (`acceptance-video.ts` § Pacing).
//
// EVERY ASSERTED WORDING is formatted from `messages/en.json` /
// `messages/zh.json` by next-intl's own formatter — never retyped.

const NS = 'planningWorkspace.conversation';
type Tr = (key: string, values?: Record<string, string | number>) => string;
const TR: Record<'en' | 'zh', Tr> = {
  en: createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as Tr,
  zh: createTranslator({ locale: 'zh', messages: zh, namespace: NS }) as unknown as Tr,
};

// ── Locators — every one scoped to the rail ──────────────────────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const record = (page: Page) => rail(page).getByTestId('plan-change-acts');
const callLines = (scope: Locator) => scope.getByTestId('plan-change-call');
const step = (page: Page, kind: string) => record(page).getByTestId(`plan-change-act-${kind}`);
const authorStep = (page: Page, title: string) =>
  step(page, 'authoring').filter({ hasText: TR.en('act.authoringLine', { title }) });
const runningBar = (page: Page) => rail(page).getByTestId('plan-change-running-bar');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** Every plan run settles with a planner QUESTION, so a run that proposes
 *  nothing ends as a conversation waiting on its answer (the rail's design state
 *  B) rather than as an `EMPTY` failure; the project thread's ask settles as an
 *  answer. */
function declareJobs(question: string, answer: string): void {
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify(
      {
        ask: [{ intent: 'ask', answer, citations: [] }],
        plan: [{ turn: { message: 'Here is what I looked at.', question } }],
        submitted: [],
      },
      null,
      2,
    ),
  );
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

/** Ask from the CARD and wait for the run's stream to reach the frame server.
 *  The door's 200 is "the session holds this turn and its job is submitted". */
async function askFromCard(page: Page, sse: SseFrameServer, text: string): Promise<void> {
  const answered = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  const connected = sse.nextConnection();
  await composer(page).fill(text);
  await composer(page).press('Enter');
  expect((await answered).status()).toBe(200);
  await connected;
}

/** End the run and wait for it to settle: the planner-turn record the page
 *  makes once its stream closes is the authoritative "the run is over", and the
 *  question it carries then stands on the rail. */
async function endRun(page: Page, sse: SseFrameServer, question: string): Promise<void> {
  const recorded = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/planner-turn' &&
      r.request().method() === 'POST',
  );
  sse.done();
  expect((await recorded).status()).toBe(200);
  await expect(rail(page).getByText(question).last()).toBeVisible();
}

// ── Frames — the contract's shapes ──────────────────────────────────────────

let seq = 0;
interface Call {
  callId: string;
  tool: string;
  family: string;
  verb: string;
  object: { kind: string; value?: string };
  itemRef: string | null;
}
function call(
  tool: string,
  family: string,
  verb: string,
  object: Call['object'],
  itemRef: string | null = null,
): Call {
  seq += 1;
  return { callId: `c${seq}`, tool, family, verb, object, itemRef };
}

/** The last call line in `scope`, once it says `text`. */
async function expectNewestLine(scope: Locator, text: string): Promise<Locator> {
  const line = callLines(scope).last();
  await expect(line).toContainText(text);
  return line;
}

/** Walk BACK from the composer with Shift+Tab until `target` holds focus — the
 *  value is reached by keyboard, not by `focus()`. Bounded, so a target the
 *  keyboard cannot reach fails here instead of hanging. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await composer(page).focus();
  const handle = await target.elementHandle();
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Shift+Tab');
    if (await handle!.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error('the truncated value is not reachable by keyboard');
}

/** Over the whole record: no line is empty, and none leaks a placeholder or key. */
async function expectNoBrokenLine(page: Page): Promise<void> {
  const texts = await record(page)
    .locator('li')
    .evaluateAll((items) => items.map((li) => (li.textContent ?? '').trim()));
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    expect(text.length, 'an empty act line').toBeGreaterThan(0);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('progress.call');
    expect(text).not.toMatch(/\bact\.[a-z]/);
    expect(text).not.toMatch(/planningWorkspace\./);
  }
}

test.describe.configure({ timeout: 420_000 });

let sse: SseFrameServer;

test.beforeEach(async () => {
  await resetDatabase();
  sse = await startSseFrameServer();
});

test.afterEach(async () => {
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('while Motir AI writes a plan, the rail says what the planner is doing — one line per call as it starts, under its step, marked when it fails, in en and zh, and never on an ask turn', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7974');

  const t = TR.en;
  const QUESTION = 'Should the session store keep its current cookie name?';
  const ANSWER = 'Nothing is blocked right now.';
  declareJobs(QUESTION, ANSWER);
  const seed = await seedPlanProgress(`call-lines-${Date.now()}`);
  await markProjectOnboarded(seed.projectId);
  const key = seed.storyKey;
  await stubAiAccess(page);
  // THE SEAM — the page's own stream request, re-targeted at the frame server.
  // The headers are passed EXPLICITLY: re-targeting a cookie-carrying request
  // to another origin with Chromium's own header set is refused as
  // `ERR_BLOCKED_BY_CLIENT`; `headers()` is that set without the cookie, which
  // the frame server does not read.
  await page.route('**/api/work-items/*/ai/plan/*/stream', (route) =>
    route.continue({ url: sse.url, headers: route.request().headers() }),
  );
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  /** Every `tool_call` this run played, in arrival order — what case 3 counts. */
  const played: Call[] = [];
  const play = (c: Call) => {
    played.push(c);
    sse.write('tool_call', c);
  };

  await chapter('Ask Motir AI for a plan from the story', async () => {
    await page.goto(`/items/${key}`);
    await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance(page).click();
    await page.waitForURL((url) => url.searchParams.has('plan'));
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await askFromCard(page, sse, 'Split the session work into cards.');
    await beat();
  });

  // ── CASE 1 ──────────────────────────────────────────────────────────────
  await chapter('A call’s line appears the moment the call starts', async () => {
    sse.write('lay', { target: key });
    const laying = step(page, 'laying');
    await expect(laying).toContainText(t('act.layingLine', { target: key }));

    const read = call('read_file', 'code_read', 'read', {
      kind: 'path',
      value: 'lib/auth/session.ts',
    });
    play(read);
    // Visible BEFORE any `retrieval` frame for this call is written — and live.
    const line = await expectNewestLine(
      laying,
      t('act.call.tool.read_file', { path: 'lib/auth/session.ts' }),
    );
    await expect(line).toHaveAttribute('data-outcome', 'running');
    await expect(line.locator('.animate-spin')).toHaveCount(1);
    await beat();

    // Its audit lands: the same line stays, and NO per-family row joins it.
    sse.write('retrieval', {
      tool: 'read_file',
      family: 'code_read',
      ok: true,
      args: { path: 'lib/auth/session.ts' },
      callId: read.callId,
    });
    const search = call('search_work_items_semantic', 'plan_tree', 'search', {
      kind: 'query',
      value: 'billing',
    });
    play(search);
    const next = await expectNewestLine(
      laying,
      t('act.call.tool.search_work_items_semantic', { query: 'billing' }),
    );
    // The next call is now the live one; the read stays above it, settled.
    await expect(next.locator('.animate-spin')).toHaveCount(1);
    await expect(callLines(laying)).toHaveCount(2);
    await expect(callLines(laying).first()).toContainText(
      t('act.call.tool.read_file', { path: 'lib/auth/session.ts' }),
    );
    await expect(callLines(laying).first().locator('.animate-spin')).toHaveCount(0);
    await expect(step(page, 'retrieval')).toHaveCount(0);
    await beat();
  });

  // ── CASE 2 ──────────────────────────────────────────────────────────────
  await chapter('Each line names what the call is about', async () => {
    const laying = step(page, 'laying');
    const lookUp = call('get_item', 'plan_tree', 'look_up', { kind: 'item', value: key });
    play(lookUp);
    await expectNewestLine(laying, t('act.call.tool.get_item', { item: key }));
    await beat();

    const lay = call('lay', 'lay', 'lay', { kind: 'parent', value: key });
    play(lay);
    await expectNewestLine(laying, t('act.call.tool.lay', { parent: key }));
    await beat();
  });

  // ── CASE 6 ──────────────────────────────────────────────────────────────
  await chapter(
    'A long path or query is shortened, and its full value is one key away',
    async () => {
      const laying = step(page, 'laying');
      const LONG_PATH = 'packages/design-system/src/components/theme/StyleVignette.tsx';
      play(call('read_file', 'code_read', 'read', { kind: 'path', value: LONG_PATH }));
      const pathLine = callLines(laying).last();
      const pathObject = pathLine.getByTestId('plan-change-call-object');
      // The visible text is the design's shortening: first segment, then the file.
      await expect(pathObject.locator('[aria-hidden="true"]')).toHaveText(
        'packages/…/StyleVignette.tsx',
      );
      // Reached by KEYBOARD, and the full value is what it reads out.
      await tabTo(page, pathObject);
      await expect(pathObject).toBeFocused();
      await expect(pathObject.locator('.sr-only')).toHaveText(
        t('act.call.full.path', { value: LONG_PATH }),
      );
      await expect(page.getByRole('tooltip')).toContainText(LONG_PATH);
      await beat();

      const LONG_QUERY = 'sessions that outlive a password change on every device';
      play(call('code_search', 'code_graph', 'search', { kind: 'query', value: LONG_QUERY }));
      const queryObject = callLines(laying).last().getByTestId('plan-change-call-object');
      await expect(queryObject.locator('[aria-hidden="true"]')).toHaveText(/^sessions that .+…$/);
      await tabTo(page, queryObject);
      await expect(queryObject).toBeFocused();
      await expect(queryObject.locator('.sr-only')).toHaveText(
        t('act.call.full.query', { value: LONG_QUERY }),
      );
      await page.keyboard.press('Escape');
      await beat();
    },
  );

  // ── CASE 4 ──────────────────────────────────────────────────────────────
  await chapter('A failed lookup and a refused write say so — and the run carries on', async () => {
    const laying = step(page, 'laying');
    const missing = `${seed.projectKey}-999`;
    const lookUp = call('get_item', 'plan_tree', 'look_up', { kind: 'item', value: missing });
    play(lookUp);
    await expectNewestLine(laying, t('act.call.tool.get_item', { item: missing }));
    sse.write('retrieval', {
      tool: 'get_item',
      family: 'plan_tree',
      ok: false,
      args: { key: missing },
      callId: lookUp.callId,
    });
    const failed = callLines(laying).filter({
      hasText: t('act.call.tool.get_item', { item: missing }),
    });
    await expect(failed).toHaveAttribute('data-outcome', 'failed');
    await expect(failed.getByTestId('plan-change-call-mark')).toHaveText(t('act.call.mark.failed'));
    await beat();

    const TITLE = 'Session cookie not cleared';
    const add = call('add_item', 'item', 'add', { kind: 'item', value: TITLE });
    play(add);
    await expectNewestLine(laying, t('act.call.tool.add_item', { title: TITLE }));
    sse.write('tool_call_failed', { callId: add.callId, reason: 'refused', code: 'PLAN_GATE' });
    const refused = callLines(laying).filter({
      hasText: t('act.call.tool.add_item', { title: TITLE }),
    });
    await expect(refused).toHaveAttribute('data-outcome', 'refused');
    await expect(refused.getByTestId('plan-change-call-mark')).toHaveText(
      t('act.call.mark.refused'),
    );
    // A failed call is not a failed run: no alert, and the run is still going.
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    await expect(runningBar(page)).toBeVisible();
    await beat();

    // An OLDER producer's budget frame — no callId — keeps the shipped row.
    sse.write('retrieval', { tool: 'get_item', family: 'plan_tree', blocked: true });
    await expect(step(page, 'retrieval')).toContainText(t('act.retrievalBlockedLine'));
    await beat();
  });

  // ── CASE 5 ──────────────────────────────────────────────────────────────
  await chapter('A call it cannot name still reads as plain words', async () => {
    // A call with no object, a tool AND verb this build does not know, and a
    // tool it does not know: each reads as its family's generic line. (The line
    // is keyed on the TOOL — MOTIR-7975's copy table — so an unknown verb on a
    // known tool keeps the tool's line; here both are unknown.)
    sse.write('lay', { target: key });
    const laying = step(page, 'laying').last();
    play(call('read_file', 'code_read', 'read', { kind: 'none' }));
    await expectNewestLine(laying, t('act.call.family.code_read'));
    play(call('ponder_lessons', 'lessons', 'ponder', { kind: 'query', value: 'risk' }));
    await expectNewestLine(laying, t('act.call.family.lessons'));
    play(call('brand_new_tool', 'web', 'search', { kind: 'query', value: 'pkce' }));
    await expectNewestLine(laying, t('act.call.family.web'));
    await expectNoBrokenLine(page);
    await beat();
  });

  // ── CASES 3 and 9 ───────────────────────────────────────────────────────
  await chapter('Two cards written at once — every line says which card it is for', async () => {
    const A = 'Rotate the session cookie';
    const B = 'Expire refresh tokens';
    sse.write('author', { ref: 'pi_0', kind: 'subtask', title: A });
    sse.write('author', { ref: 'pi_1', kind: 'subtask', title: B });
    await expect(authorStep(page, A)).toBeVisible();
    await expect(authorStep(page, B)).toBeVisible();

    const interleaved: [string, Call, string][] = [
      [
        A,
        call('get_item', 'plan_tree', 'look_up', { kind: 'item', value: key }, A),
        t('act.call.tool.get_item', { item: key }),
      ],
      [
        B,
        call('code_search', 'code_graph', 'search', { kind: 'query', value: 'refresh' }, B),
        t('act.call.tool.code_search', { query: 'refresh' }),
      ],
      [
        A,
        call('author', 'author', 'write', { kind: 'item', value: A }, A),
        t('act.call.tool.author', { item: A }),
      ],
      [
        B,
        call('author', 'author', 'write', { kind: 'item', value: B }, B),
        t('act.call.tool.author', { item: B }),
      ],
    ];
    for (const [title, c, text] of interleaved) {
      play(c);
      // Attributed to ITS card by text alone: the line sits under that card's step.
      await expectNewestLine(authorStep(page, title), text);
      // CASE 9 — one live region, whatever is streaming.
      await expect(rail(page).locator('[aria-live]')).toHaveCount(1);
      await beat();
    }
    // Two sessions open: the bar repeats the newest started call, with its card.
    await expect(runningBar(page)).toContainText(
      t('act.call.barParallel', { line: t('act.call.tool.author', { item: B }), title: B }),
    );

    // Every call played is reachable, in arrival order: open the folded steps
    // and the open steps' earlier calls, then read every line.
    for (const toggle of await record(page).getByTestId('plan-change-calls-toggle').all()) {
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    }
    for (const earlier of await record(page).getByTestId('plan-change-calls-earlier').all()) {
      if ((await earlier.getAttribute('aria-expanded')) === 'false') await earlier.click();
    }
    await expect(callLines(record(page))).toHaveCount(played.length);
    await expect(callLines(record(page)).filter({ visible: true })).toHaveCount(played.length);
    await beat();
  });

  await chapter('The run ends — finished steps fold behind their count', async () => {
    await endRun(page, sse, QUESTION);
    const laying = step(page, 'laying').first();
    await expect(laying).toHaveAttribute('data-step', /folded|expanded/);
    await expect(laying.getByTestId('plan-change-calls-toggle')).toHaveText(
      t('act.call.countFailed', { count: 8, failed: 2 }),
    );
    await expectNoBrokenLine(page);
    await beat();
  });

  // ── CASE 7 ──────────────────────────────────────────────────────────────
  await chapter('The same lines in Chinese', async () => {
    const z = TR.zh;
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: baseURL! }]);
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await askFromCard(page, sse, '保留现有的 cookie 名称。');

    sse.write('lay', { target: key });
    const laying = step(page, 'laying').last();
    await expect(laying).toContainText(z('act.layingLine', { target: key }));
    const lines: [Call, string][] = [
      [
        call('read_file', 'code_read', 'read', { kind: 'path', value: 'lib/auth/session.ts' }),
        z('act.call.tool.read_file', { path: 'lib/auth/session.ts' }),
      ],
      [
        call('search_work_items_semantic', 'plan_tree', 'search', {
          kind: 'query',
          value: '会话',
        }),
        z('act.call.tool.search_work_items_semantic', { query: '会话' }),
      ],
      [
        call('get_item', 'plan_tree', 'look_up', { kind: 'item', value: key }),
        z('act.call.tool.get_item', { item: key }),
      ],
      [
        call('lay', 'lay', 'lay', { kind: 'parent', value: key }),
        z('act.call.tool.lay', { parent: key }),
      ],
      [call('read_file', 'code_read', 'read', { kind: 'none' }), z('act.call.family.code_read')],
    ];
    for (const [c, text] of lines) {
      sse.write('tool_call', c);
      await expectNewestLine(laying, text);
      await beat();
    }
    const A = 'Rotate the session cookie';
    sse.write('author', { ref: 'pi_0', kind: 'subtask', title: A });
    const writing = step(page, 'authoring').filter({
      hasText: z('act.authoringLine', { title: A }),
    });
    sse.write('tool_call', call('author', 'author', 'write', { kind: 'item', value: A }, A));
    await expectNewestLine(writing, z('act.call.tool.author', { item: A }));
    await expectNoBrokenLine(page);
    await beat();

    await endRun(page, sse, QUESTION);
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }]);
  });

  // ── CASE 8 ──────────────────────────────────────────────────────────────
  await chapter('A question answered in the conversation adds no call lines', async () => {
    await page.goto('/roadmap?plan=replan&planFrom=project');
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const settled = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/ai/ask/settle' && r.request().method() === 'POST',
    );
    const asked = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
    );
    await composer(page).fill('Is anything blocked in this project?');
    await composer(page).press('Enter');
    expect((await asked).status()).toBe(200);
    expect((await settled).status()).toBe(200);
    await expect(rail(page).getByText(ANSWER)).toBeVisible();
    await expect(callLines(rail(page))).toHaveCount(0);
    await beat();
  });
});
