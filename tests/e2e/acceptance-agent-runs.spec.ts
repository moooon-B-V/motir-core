import { test, expect } from './_helpers/acceptance-video';
import { signIn } from './_helpers/shell-session';
import { seedScopedRun, SCOPED_RUN_PASSWORD } from './_helpers/scoped-run-seed';
import { appendEvents, closeRun, ingestContext, openRun } from './_helpers/agent-run-seed';

// AGENT RUNS, watched (Story MOTIR-1789 · MOTIR-1800) — the story's acceptance
// receipt and its end-to-end flow.
//
// ⚠️ WHAT THIS PROVES THAT NO VITEST SIBLING CAN. `tests/dispatchRunService`,
// `dispatchRunReadRoutes` and the component suites all drive these seams and
// assert rows, DTOs and rendered markup. Every one of them would pass in full
// while a person opening `/runs` learned nothing: the whole claim of this story
// is that a run is WATCHABLE — you dispatch a story, eleven work items go In
// Progress at once, and the surface tells you which is being worked and why one
// was left out. Only a browser can answer that.
//
// ⚠️ PACED FOR A HUMAN, DELIBERATELY. This clip is what somebody watches to
// accept the story, and what it has to show is a set CHANGING — a node going
// live, a log filling, one member skipped with its reason. A recording that
// blinks past that meets every criterion and proves nothing, so each phase is
// its own chapter with its own beats.
//
// ⚠️ THE MODAL IS NOT A PAGE, and that is asserted as itself. There is no
// `/runs/<id>` route; a spec that navigated to one would go red on a missing
// path rather than on a defect, so this opens the modal from a row, asserts the
// URL stayed on `/runs`, and asserts the list is unchanged after closing.
//
// ⚠️ THE APPEND'S OWN 200 IS THE AUTHORITATIVE SIGNAL — do NOT add a re-read
// between an append and the assertion that follows it. An earlier draft had a
// `settle()` that polled `GET /api/v1/dispatch-runs/{id}` until the cursor
// advanced, on the reasoning that the UI cannot show what the record does not
// hold. Both halves were wrong. That route DOES NOT EXIST: `/api/v1` carries
// the three INGEST operations only (open, events, close) — `tests/runs/
// storyGate.test.ts` asserts exactly those three — and the run is read back
// through the session-authenticated `/api/dispatch-runs/[id]`, which a
// PAT context cannot open anyway. So it 404'd forever and timed out.
//
// It was also redundant. `appendEvents` POSTs and asserts its 200 before
// returning, and the server commits the batch before it answers — so by the
// time the call resolves the record already holds the events. What the
// assertions below wait on is the SSE push of a fact that is already committed,
// which is exactly what an auto-retrying `toBeVisible` is for and is not the
// race `CLAUDE.md` forbids (that one is asserting ahead of an in-flight write).
//
// A footnote worth keeping: the old helper returned `-1` for any non-200, so the
// failure read `Expected: >= 3, Received: -1` and never said `404`. A poll that
// swallows the status hides the one fact that explains it.

const EMAIL = 'agent-runs-acceptance@example.com';

/** Playwright's own origin — the one the RUNNER can reach. See `ingestContext`. */
function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
  return baseURL;
}

test('a run claims a story, and you can watch the whole set advance', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
  baseURL,
}) => {
  acceptanceStory('MOTIR-1789');

  const seed = await seedScopedRun(EMAIL, 'RUNS');
  const api = await ingestContext(seed.token, origin(baseURL));

  let runId = '';

  await chapter('a run claims a story', async () => {
    // The shape `motir run MOTIR-<id>` produces: the whole ready set claimed at
    // once, in the run's own order, with the member it could not work already
    // skipped and SAYING WHY.
    runId = await openRun(api, {
      projectKey: seed.projectKey,
      command: 'run_scope',
      scopeKey: seed.story.identifier,
      agent: 'claude',
      model: 'claude-opus-5',
      cards: [
        { key: seed.first.identifier, disposition: 'queued' },
        { key: seed.second.identifier, disposition: 'queued' },
        { key: seed.manual.identifier, disposition: 'skipped', skipReason: 'needs_human' },
      ],
    });
    await signIn(page, EMAIL, SCOPED_RUN_PASSWORD);
    await beat();
  });

  await chapter('the run appears on the runs page', async () => {
    await page.goto('/runs');
    // The live section carries it, with the command it was started by.
    await expect(page.getByRole('heading', { name: 'Running now' })).toBeVisible();
    // ⚠️ THE INDEX PRINTS THE RAW COMMAND (`{run.command}`), not the
    // translated label — the modal's HEADER is what renders `t('command.*')`.
    // Asserting the pretty string here would have been a spec written against
    // a surface that does not exist.
    await expect(page.getByRole('button', { name: 'run_scope' }).first()).toBeVisible();
    await beat();
  });

  await chapter('the run opens full screen', async () => {
    await page.getByRole('button', { name: 'run_scope' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // ⚠️ THE URL STAYED ON `/runs`. An overlay, not a navigation — the whole
    // reason the list survives underneath.
    await expect(page).toHaveURL(/\/runs\?run=/);
    await beat();
  });

  await chapter('the whole set is on the canvas', async () => {
    const dialog = page.getByRole('dialog');
    // Every member the run owns, by its KEY — asserted on the accessible name
    // rather than a position, because the canvas lays out asynchronously.
    for (const key of [seed.first.identifier, seed.second.identifier, seed.manual.identifier]) {
      await expect(dialog.getByText(key, { exact: false }).first()).toBeVisible();
    }
    await beat();
  });

  await chapter('a work item goes live, and the log says what the agent is doing', async () => {
    await appendEvents(api, runId, [
      { kind: 'card_claimed', workItemKey: seed.first.identifier, disposition: 'running' },
      {
        kind: 'log',
        workItemKey: seed.first.identifier,
        body: 'Reading lib/services/dispatchRunService.ts',
      },
      {
        kind: 'log',
        workItemKey: seed.first.identifier,
        body: 'pnpm vitest run tests/dispatchRunService.test.ts',
      },
    ]);

    // ⚠️ SCOPED TO EACH PANE, and that is not tidiness. `Running` also appears
    // on the RUN's own status pill in the header, so an unscoped match would go
    // green while the canvas node never moved — the assertion would be about
    // the header and read as though it were about the set.
    const canvas = page.getByRole('region', { name: 'The set' });
    const log = page.getByRole('region', { name: 'Agent output' });
    // No refresh: the node's state and the log both arrive over the SSE the
    // modal already had open.
    await expect(canvas.getByText('Running').first()).toBeVisible();
    await expect(log.getByText(/dispatchRunService/).first()).toBeVisible();
    await beat();
  });

  await chapter('it finishes, and one was skipped — the canvas says why', async () => {
    await appendEvents(api, runId, [
      {
        kind: 'card_settled',
        workItemKey: seed.first.identifier,
        disposition: 'implemented',
        exitCode: 0,
      },
    ]);

    const canvas = page.getByRole('region', { name: 'The set' });
    await expect(canvas.getByText('Implemented').first()).toBeVisible();
    // The skipped member carries its REASON, not merely its state — a skip
    // shown without one says nothing.
    await expect(canvas.getByText('Skipped — needs a human.').first()).toBeVisible();
    await beat();
  });

  await chapter('the run stops, and the header says why', async () => {
    await closeRun(api, runId, 'drained');
    // The stop reason in the terminal's OWN words.
    await expect(page.getByText('the ready set is drained')).toBeVisible();
    await beat();
  });

  await chapter('close, and the list is where you left it', async () => {
    // ⚠️ ESC, because the dialog and the canvas BOTH handle keys and the
    // dialog's must win. This collision is the likeliest regression here.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page).toHaveURL(/\/runs$/);
    // Both headed sections are still there — the partition survived, which is
    // the difference between an overlay and a page.
    await expect(page.getByRole('heading', { name: 'Past runs' })).toBeVisible();
    await beat();
  });

  await api.dispose();
});

test('the log pane names the FLAG when a run reported no bodies', async ({ page, baseURL }) => {
  // ⚠️ THE COMMON CASE IN PRODUCTION. Sending log bodies is opt-in and off by
  // default, so the pane most people meet is this one — and it has to read as
  // the operator's own choice rather than as something Motir failed to record.
  const seed = await seedScopedRun('agent-runs-quiet@example.com', 'QUIET');
  const api = await ingestContext(seed.token, origin(baseURL));

  const runId = await openRun(api, {
    projectKey: seed.projectKey,
    command: 'run_scope',
    scopeKey: seed.story.identifier,
    cards: [{ key: seed.first.identifier, disposition: 'queued' }],
  });
  await appendEvents(api, runId, [
    { kind: 'card_claimed', workItemKey: seed.first.identifier, disposition: 'running' },
  ]);
  await closeRun(api, runId, 'drained');

  await signIn(page, 'agent-runs-quiet@example.com', SCOPED_RUN_PASSWORD);
  await page.goto(`/runs?run=${runId}`);

  await expect(page.getByRole('dialog')).toBeVisible();
  const log = page.getByRole('region', { name: 'Agent output' });
  await expect(log.getByText('Nothing was sent')).toBeVisible();
  // Naming the flag is the whole remedy; without it the message is a dead end.
  await expect(log.getByText(/--report-log/)).toBeVisible();

  await api.dispose();
});

test('a deep link opens the modal already on that run, and no /runs/<id> route exists', async ({
  page,
  baseURL,
}) => {
  const seed = await seedScopedRun('agent-runs-deeplink@example.com', 'DEEP');
  const api = await ingestContext(seed.token, origin(baseURL));
  const runId = await openRun(api, {
    projectKey: seed.projectKey,
    command: 'run_scope',
    scopeKey: seed.story.identifier,
    cards: [{ key: seed.first.identifier, disposition: 'queued' }],
  });

  await signIn(page, 'agent-runs-deeplink@example.com', SCOPED_RUN_PASSWORD);

  // The destination the run section's "one of N" link uses.
  await page.goto(`/runs?run=${runId}`);
  await expect(page.getByRole('dialog')).toBeVisible();

  // ⚠️ AND THE ROUTE THAT MUST NOT EXIST. `/runs/<id>` was withdrawn when the
  // view became an overlay; a link to one would fail as a missing route rather
  // than as a defect, so its absence is asserted rather than assumed.
  const res = await page.request.get(`/runs/${runId}`);
  expect(res.status()).toBe(404);

  await api.dispose();
});

test('nothing has run yet reads as a fact, not an error', async ({ page }) => {
  const seed = await seedScopedRun('agent-runs-empty@example.com', 'MTY');
  await signIn(page, 'agent-runs-empty@example.com', SCOPED_RUN_PASSWORD);
  await page.goto('/runs');

  await expect(page.getByText('Nothing has run yet')).toBeVisible();
  // It names the command that changes it — an empty state that only says
  // "nothing" leaves a reader with nowhere to go.
  await expect(page.getByText(/motir run/)).toBeVisible();
  expect(seed.projectKey).toBeTruthy();
});
