import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import { seedApprovalsTab, type ApprovalsTabSeed } from './_helpers/approvals-tab-seed';
import {
  formatRefreshTable,
  installRefreshCounter,
  type RefreshCounter,
  type RefreshCountRow,
} from './_helpers/refresh-counter';
import { driveWriteBurst, seedBurstCard } from './_helpers/write-burst';
import en from '@/messages/en.json';

// DOES ANOTHER ACTOR'S WRITE REFRESH THE PAGE UNDER AN OPEN APPROVAL?
// (Story MOTIR-8539 · Subtask MOTIR-8571 — the confirmation spec.)
//
// ── THE FINDING (recorded against `origin/main` at 9b538d7, 2026-10-14) ─────
//
// | case                               | writes | stream nudges | RSC refetches | document loads |
// | ---------------------------------- | ------ | ------------- | ------------- | -------------- |
// | (i)   approval over /workbench     | 50     | 7             | 7             | 0              |
// | (ii)  approval over an item page   | 50     | 5             | 0             | 0              |
// | (iii) control: /workbench, nothing | 50     | 5             | 5             | 0              |
// | (iv)  control: item page, nothing  | 50     | 0             | 0             | 0              |
//
// One local run against a production build of that commit, the Postgres job
// engine running. The nudge count is the stream's own batching of 50 writes
// (its frames coalesce), so it varies run to run; the RSC count tracking it one
// for one is the finding. The run prints this table and attaches it.
//
//   · (i) CONFIRMED. Over `/workbench?approval=…` every nudge re-fetches the
//     Workbench's RSC payload under the open approval. The carrier is
//     `app/(authed)/workbench/_components/WorkbenchLive.tsx`, `useRefreshOnNudge`
//     → `useCoordinatedRefresh()` → `router.refresh()`. Its gate is
//     `onWorkbench = pathname === WORKBENCH_PATH`, and `?approval=` does not
//     change the pathname, so the approval is no exemption. The coordinator
//     coalesces refreshes requested while one is pending, so the refetch count
//     is at most the nudge count, not equal to it.
//   · (ii) NOT REPRODUCED. Over an item page the stream IS open (the provider
//     subscribes while `approvalOpen`), but the same file passes `0` to
//     `useRefreshOnNudge` off the Workbench, so no nudge refreshes the page.
//     No other carrier refreshed the item page during the burst.
//   · (iii) the control: the Workbench with nothing open refreshes per nudge.
//     That is today's intended behaviour (MOTIR-5242) and the reason (i) fires.
//   · (iv) the control: an item page with nothing open holds no stream at all
//     (`enabled` is false), so nothing can nudge it.
//
// No case loaded a new document. The plan-proposal half of the burst was not
// driven: the harness's write door for proposals needs a planning session the
// approval seed does not carry, and every assertion here is about the
// Workbench's watermark, which the work-item writes already move.
//
// ── WHAT INVERTS THIS ───────────────────────────────────────────────────────
//
// The assertions marked DEFECT below encode today's behaviour so this spec is
// green against `main` and RECORDS the cause. MOTIR-8574 (the Workbench
// applier) inverts case (i) to zero, and the story E2E (MOTIR-8580) asserts
// zero across every surface with the counter this spec exports
// (`_helpers/refresh-counter.ts`). MOTIR-8577 inverts (ii) only if it ever
// reproduces; it does not today.
//
// ⚠️ THE COUNTS COME FROM THE NETWORK LOG, never from component state. See the
// counter's header for what each number counts and what it deliberately does
// not (prefetches, server actions, `framenavigated`).

test.describe.configure({ timeout: 300_000 });

/** Writes per case — the story's burst size. */
const BURST = 50;

/**
 * How long a case waits, after the burst's last nudge, for a refresh it is
 * asserting did NOT happen.
 *
 * ⚠️ A DURATION OF QUIET, AND THE CLAIM IS ONE. "Nothing re-fetched" has no
 * authoritative completion signal — the absence of a request never arrives —
 * so the only honest measurement is a window long enough for the refresh to
 * have fired if it were going to. The stream polls every 1s and the
 * coordinator runs one follow-up after a pending refresh commits; five seconds
 * clears both by several multiples on a loaded runner.
 */
const QUIET_MS = 5_000;

const rows: RefreshCountRow[] = [];

test.describe('a write by another actor under an open approval', () => {
  let seed: ApprovalsTabSeed;
  let burstKey: string;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`rua${Date.now().toString(36)}`);
    burstKey = (await seedBurstCard(seed)).key;
  });

  test.afterAll(async ({}, testInfo) => {
    const table = formatRefreshTable(rows);
    // eslint-disable-next-line no-console -- the recorded finding is the run's own output.
    console.log(`\nRefresh under an open approval (MOTIR-8571)\n${table}\n`);
    await testInfo.attach('refresh-under-approval.md', {
      body: table,
      contentType: 'text/markdown',
    });
  });

  /** The approval's dialog for the seed's design gate. */
  const dialogFor = (page: Page) =>
    page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });

  /** Publish the gate the reviewer reads (the real door), and serve its mock. */
  async function publishGate(page: Page, baseURL: string) {
    await servePublishedMock(page);
    const client = await openAgentSession(seed.token, baseURL);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    return client;
  }

  /**
   * Sign in and open `path`, arming the stream wait BEFORE the navigation when
   * the page is expected to hold one, so the priming response cannot be missed.
   */
  async function openReader(page: Page, path: string, holdsStream: boolean): Promise<void> {
    await signIn(page, seed.reviewerEmail, seed.password);
    const streamOpened = holdsStream
      ? page.waitForResponse((r) => r.url().includes('/api/workbench/stream') && r.ok())
      : null;
    await page.goto(path);
    if (streamOpened) await streamOpened;
  }

  /**
   * Run the burst and wait for it to LAND: the stream's frame for a write made
   * after the last one was acknowledged is the authoritative signal on a page
   * that holds a stream. Then hold the quiet window, and wait out any refetch
   * still in flight so the count is final.
   */
  async function burstAndSettle(
    page: Page,
    counter: RefreshCounter,
    holdsStream: boolean,
    client: Awaited<ReturnType<typeof openAgentSession>>,
  ): Promise<{ writes: number }> {
    await counter.reset();
    const { writes, lastWriteAt } = await driveWriteBurst(client, burstKey, BURST);
    if (holdsStream) {
      await expect
        .poll(async () => (await counter.frames()).some((f) => f.at >= lastWriteAt - 1_000), {
          timeout: 60_000,
        })
        .toBe(true);
    }
    await page.waitForTimeout(QUIET_MS);
    await expect.poll(() => counter.inFlight(), { timeout: 60_000 }).toBe(0);
    return { writes };
  }

  async function record(name: string, writes: number, counter: RefreshCounter, info: TestInfo) {
    const counts = await counter.read();
    const row = { case: name, writes, ...counts };
    rows.push(row);
    await info.attach(`${name}.json`, {
      body: JSON.stringify(row, null, 2),
      contentType: 'application/json',
    });
    return counts;
  }

  test('(i) approval open over /workbench — CONFIRMED: every nudge re-fetches the page under it', async ({
    page,
    baseURL,
  }, testInfo) => {
    const counter = await installRefreshCounter(page);
    const client = await publishGate(page, baseURL!);
    await openReader(
      page,
      `/workbench?tab=approvals&approval=${seed.designKey}&approvalKind=design_result`,
      true,
    );
    const dialog = dialogFor(page);
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible({
      timeout: 60_000,
    });

    const { writes } = await burstAndSettle(page, counter, true, client);
    const counts = await record('(i) approval over /workbench', writes, counter, testInfo);

    expect(writes).toBeGreaterThanOrEqual(BURST);
    expect(counts.streamNudges).toBeGreaterThan(0);
    // DEFECT — MOTIR-8574 inverts this to `toBe(0)`: the Workbench host's
    // `useRefreshOnNudge` refreshes the route on every nudge, approval or not.
    expect(counts.rscRefetches).toBeGreaterThan(0);
    // The coordinator coalesces, so never more refetches than nudges.
    expect(counts.rscRefetches).toBeLessThanOrEqual(counts.streamNudges);
    expect(counts.documentLoads).toBe(0);
    // The approval is still open over the same document.
    await expect(dialog).toBeVisible();
    await client.close();
  });

  test('(ii) approval open over an item page — NOT REPRODUCED: the stream nudges, nothing re-fetches', async ({
    page,
    baseURL,
  }, testInfo) => {
    const counter = await installRefreshCounter(page);
    const client = await publishGate(page, baseURL!);
    await openReader(
      page,
      `/items/${seed.designKey}?approval=${seed.designKey}&approvalKind=design_result`,
      true,
    );
    const dialog = dialogFor(page);
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible({
      timeout: 60_000,
    });

    const { writes } = await burstAndSettle(page, counter, true, client);
    const counts = await record('(ii) approval over an item page', writes, counter, testInfo);

    expect(writes).toBeGreaterThanOrEqual(BURST);
    // The provider subscribes while an approval is open, on any host…
    expect(counts.streamNudges).toBeGreaterThan(0);
    // …and off the Workbench it refreshes nothing. Already the story's target.
    expect(counts.rscRefetches).toBe(0);
    expect(counts.documentLoads).toBe(0);
    await expect(dialog).toBeVisible();
    await client.close();
  });

  test('(iii) control — /workbench with nothing open refreshes per nudge (MOTIR-5242 today)', async ({
    page,
    baseURL,
  }, testInfo) => {
    const counter = await installRefreshCounter(page);
    const client = await openAgentSession(seed.token, baseURL!);
    await openReader(page, '/workbench?tab=todo', true);
    await expect(
      page.getByRole('link', { name: new RegExp(en.workbench.tabs.toDo) }),
    ).toHaveAttribute('aria-current', 'page');

    const { writes } = await burstAndSettle(page, counter, true, client);
    const counts = await record(
      '(iii) control: /workbench, nothing open',
      writes,
      counter,
      testInfo,
    );

    expect(counts.streamNudges).toBeGreaterThan(0);
    // DEFECT for the story, intended for MOTIR-5242 — MOTIR-8574 removes it.
    expect(counts.rscRefetches).toBeGreaterThan(0);
    expect(counts.documentLoads).toBe(0);
    await client.close();
  });

  test('(iv) control — an item page with nothing open holds no stream and re-fetches nothing', async ({
    page,
    baseURL,
  }, testInfo) => {
    const counter = await installRefreshCounter(page);
    const client = await openAgentSession(seed.token, baseURL!);
    await openReader(page, `/items/${seed.designKey}`, false);
    await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible({
      timeout: 60_000,
    });

    const { writes } = await burstAndSettle(page, counter, false, client);
    const counts = await record('(iv) control: item page, nothing open', writes, counter, testInfo);

    expect(counts.streamNudges).toBe(0);
    expect(counts.rscRefetches).toBe(0);
    expect(counts.documentLoads).toBe(0);
    await client.close();
  });
});
