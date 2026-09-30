import { readFileSync, writeFileSync } from 'node:fs';
import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedAiAugmentReplan, markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import type { AiJobsFixture } from '@/lib/test-ai-jobs-mock';

// ACCEPTANCE — Debug with Motir AI, from BOTH entrances (Story MOTIR-7042 ·
// MOTIR-7052). The receipt a person watches to accept the story, walking its
// Verification recipe:
//
//   1. REPORT, THEN DEBUG. A member files a bug through the header's Report
//      widget, presses "Debug with Motir AI" on the success panel, and watches
//      the turn run. The rail's outcome line links the bug it wrote the
//      diagnosis onto; the bug carries that diagnosis; Triage lists it.
//   2. FROM THE ORB. The orb's "Debug with Motir AI" row opens the composer
//      pre-filled; the member replaces the template with a bug an EXISTING card
//      already covers and sends. The rail names that card, and Triage gains no
//      row.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// motir-ai is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts` (the lane's
// `E2E_TEST_AI_JOBS=1` undici intercept), so the real ask door → settle →
// `debug_bug` dispatch → landing → Postgres chain runs. The fixture queues are
// what the classifier (`ask_project`) and the debugger (`debug_bug`) answer.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on the AUTHORITATIVE signal (CLAUDE.md): the intake POST's
// 201, the ask door's 200, and — for the landing — the settle response whose
// BODY says `debugged`, armed before the action that causes it. The rail is
// only asserted after the landing it renders has been returned by the server.

test.describe.configure({ timeout: 120_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/**
 * APPEND the next turn's outcomes to the queues, keeping what the mock has
 * already recorded. ⚠️ `submitted` must survive: the mock indexes each queue by
 * how many jobs of that kind it has seen AND names the job by that ordinal, so
 * dropping it would re-issue chapter 1's job ids to chapter 2.
 */
function queueDebugTurn(ask: NonNullable<AiJobsFixture['ask']>[number], debugBug: unknown): void {
  const f = readJobsFixture();
  f.ask = [...(f.ask ?? []), ask];
  f.debugBug = [...(f.debugBug ?? []), { debugBug }];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

// ── What motir-ai's debugger answers ────────────────────────────────────────

const REPORT_TITLE = 'CSV export drops the last row';
const REPORT_DESCRIPTION =
  'Export a list of 10 work items to CSV — the file only has 9 rows. Expected all 10.';

const CSV_DIAGNOSIS = {
  descriptionMd: [
    'The CSV export writes every row but the last.',
    '',
    '## Acceptance criteria',
    '',
    '- An export of N work items has N data rows.',
    '',
    '## Candidate mechanisms',
    '',
    'None of these is established.',
    '',
    '- The row loop stops at `length - 1`.',
    '- The stream is closed before the final chunk flushes.',
    '',
    '## Context refs',
    '',
    '- `lib/export/csv.ts`',
  ].join('\n'),
  explanationMd: 'People reconcile exports against the plan; a missing row reads as lost work.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 60,
  difficulty: 'medium',
  contextRefs: ['lib/export/csv.ts'],
  candidateMechanisms: [
    'The row loop stops at `length - 1`.',
    'The stream is closed before the final chunk flushes.',
  ],
  grounded: true,
  groundingReason: 'indexed',
  title: REPORT_TITLE,
  acceptanceCriteria: ['An export of N work items has N data rows.'],
};

const MENTIONS_DIAGNOSIS = {
  descriptionMd: [
    'Saving a comment strips every `@mention` before the body is stored.',
    '',
    '## Acceptance criteria',
    '',
    '- A saved comment keeps its mention chips.',
    '',
    '## Candidate mechanisms',
    '',
    'None of these is established.',
    '',
    '- The sanitizer drops the `mention:` scheme.',
    '- The editor serializes before the picker commits.',
    '',
    '## Context refs',
    '',
    '- `lib/services/commentsService.ts`',
  ].join('\n'),
  explanationMd: 'Mentions pull people into a thread; losing them silences it.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 60,
  difficulty: 'medium',
  contextRefs: ['lib/services/commentsService.ts'],
  candidateMechanisms: [
    'The sanitizer drops the `mention:` scheme.',
    'The editor serializes before the picker commits.',
  ],
  grounded: true,
  groundingReason: 'indexed',
  title: 'Saving a comment drops its @mentions',
  acceptanceCriteria: ['A saved comment keeps its mention chips.'],
};

const ORB_REPORT =
  'When I save a comment, the @mention I typed disappears. It should stay a mention.';

// ── Locators ────────────────────────────────────────────────────────────────

const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => page.getByRole('textbox', { name: /Reply, or refine/ });
/** The debug turn's one outcome line — a `<p>` in `PlanChangeRail`, no role. */
const outcomeLines = (page: Page) => rail(page).getByTestId('plan-change-debug-outcome');

// ── Authoritative signals ───────────────────────────────────────────────────

/** The ask DOOR's own POST (not the settle, which shares the prefix). */
const askDoor = (page: Page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );

/**
 * The settle that ENDS the debug turn — the first settle that is not the ask
 * job's `debugging` hand-off. Resolving on ANY other answer (a refusal, a 502)
 * rather than only on `debugged` makes a broken landing fail HERE, naming the
 * server's reason, instead of hanging to the test timeout.
 */
function debugSettled(page: Page): Promise<Response> {
  return page.waitForResponse(async (r) => {
    if (new URL(r.url()).pathname !== '/api/ai/ask/settle') return false;
    if (r.request().method() !== 'POST') return false;
    if (r.status() !== 200) return true;
    try {
      return ((await r.json()) as { outcome?: string }).outcome !== 'debugging';
    } catch {
      return true;
    }
  });
}

interface Landing {
  outcome: string;
  workItemKey: string | null;
  createdInTriage: boolean;
}

/** The settle's landing — asserting first that the turn really LANDED. */
async function landingOf(res: Response): Promise<Landing> {
  const body = (await res.json()) as { outcome?: string; landing?: Landing };
  expect(res.status(), JSON.stringify(body)).toBe(200);
  expect(body.outcome, JSON.stringify(body)).toBe('debugged');
  return body.landing!;
}

/** The project's Triage — every parentless item still waiting there. */
const triageCount = (projectId: string) =>
  db.workItem.count({ where: { projectId, triagedAt: { not: null } } });

test.beforeEach(async () => {
  await resetDatabase();
  // A fresh fixture per run: nothing queued, nothing recorded.
  writeFileSync(JOBS_FIXTURE, JSON.stringify({}, null, 2));
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('Debug with Motir AI — from the report widget and from the orb', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7042');

  // The member: the project's owner (edit rights, `ai:plan`) on a Motir AI
  // configured, onboarded project.
  const seed = await seedAiAugmentReplan(`debug-motir-ai-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  // The card that ALREADY covers chapter 2's report — planned, not in Triage.
  const existing = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'bug', title: 'Comment @mentions vanish on save' },
    seed.ctx,
  );

  await signIn(page, seed.email, seed.password);
  await page.goto('/items');
  await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible({
    timeout: 60_000,
  });

  let filedKey = '';

  await chapter('Report, then debug', async () => {
    // ── Report a bug from the header ──────────────────────────────────────
    await page.getByRole('button', { name: 'Report' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Report something' });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Bug', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Bug', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await modal.getByLabel('Title').fill(REPORT_TITLE);
    await modal.getByLabel(/What happened\?/).fill(REPORT_DESCRIPTION);

    const created = page.waitForResponse(
      (r) => r.url().includes('/triage/submissions') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'Submit' }).click();
    const createdRes = await created;
    expect(createdRes.status()).toBe(201);
    filedKey = ((await createdRes.json()) as { identifier: string }).identifier;

    // The success panel offers the debug instead of closing.
    const debugButton = modal.getByRole('button', { name: 'Debug with Motir AI' });
    await expect(debugButton).toBeVisible();
    await expect(modal.getByTestId('report-debug-filed')).toContainText(filedKey);
    await beat();

    // The classifier reads the turn as a bug report and ECHOES the anchor; the
    // debugger writes its diagnosis onto the bug just filed.
    queueDebugTurn(
      { intent: 'debug', anchorKey: filedKey },
      {
        ...CSV_DIAGNOSIS,
        outcome: 'diagnose',
        anchorKey: filedKey,
        replyMd: `The diagnosis is on ${filedKey} in Triage.`,
      },
    );

    // ── Press it: the one seeded send, anchored on the bug ────────────────
    const asked = askDoor(page);
    const landed = debugSettled(page);
    await debugButton.click();
    const askRes = await asked;
    expect(askRes.status()).toBe(200);
    const askBody = JSON.parse(askRes.request().postData() ?? '{}') as {
      body?: string;
      anchorKey?: string;
    };
    expect(askBody.anchorKey).toBe(filedKey);
    expect(askBody.body).toContain(REPORT_TITLE);

    const landing = await landingOf(await landed);
    expect(landing).toMatchObject({
      outcome: 'diagnose',
      workItemKey: filedKey,
      createdInTriage: false,
    });

    // The rail's outcome line names the bug and links it.
    await expect(rail(page)).toBeVisible();
    const line = outcomeLines(page).last();
    await expect(line).toHaveAttribute('data-outcome', 'diagnose');
    await expect(line).toContainText(`Wrote the diagnosis onto ${filedKey}`);
    await expect(line).toContainText('It stays in Triage');
    await expect(line.getByRole('link', { name: new RegExp(filedKey) })).toBeVisible();
    await beat();

    // ── Open the bug: the diagnosis is on it ──────────────────────────────
    await page.goto(`/items/${filedKey}`);
    await expect(page.getByRole('heading', { name: 'Candidate mechanisms' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('The row loop stops at').first()).toBeVisible();
    await beat();

    // ── Open Triage: it is listed there ───────────────────────────────────
    await page.goto('/requested-features');
    await expect(page.getByRole('heading', { level: 1, name: 'Requested features' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: new RegExp(REPORT_TITLE) })).toBeVisible();
    expect(await triageCount(seed.projectId)).toBe(1);
    await beat();
  });

  await chapter('From the orb', async () => {
    const triageBefore = await triageCount(seed.projectId);

    // ── The orb's Debug row pre-fills the composer and sends nothing ──────
    await orb(page).click();
    const debugRow = calloutPanel(page).getByRole('link', { name: /Debug with Motir AI/ });
    await expect(debugRow).toBeVisible();
    await debugRow.click();
    await page.waitForURL((url) => url.searchParams.has('plan'));
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    await expect(composer(page)).toHaveValue(/Something is broken\. What happens:/);
    await beat();

    // The classifier reads a bug (no anchor — the orb files nothing); the
    // debugger finds the card that already covers it.
    queueDebugTurn(
      { intent: 'debug' },
      {
        ...MENTIONS_DIAGNOSIS,
        outcome: 'enrich_existing',
        workItemKey: existing.identifier,
        matchReason: 'It already describes mentions vanishing on save.',
        anchorKey: null,
        replyMd: `${existing.identifier} already covers this defect.`,
      },
    );

    // ── Replace the template with the report, and send ────────────────────
    await composer(page).fill(ORB_REPORT);
    const asked = askDoor(page);
    const landed = debugSettled(page);
    await page.getByRole('button', { name: 'Send' }).click();
    const askRes = await asked;
    expect(askRes.status()).toBe(200);
    const askBody = JSON.parse(askRes.request().postData() ?? '{}') as {
      body?: string;
      anchorKey?: string;
    };
    expect(askBody.body).toBe(ORB_REPORT);
    expect(askBody.anchorKey).toBeUndefined();

    const landing = await landingOf(await landed);
    expect(landing).toMatchObject({
      outcome: 'enrich_existing',
      workItemKey: existing.identifier,
      createdInTriage: false,
    });

    // The rail names the existing card — and says nothing new was filed.
    const line = outcomeLines(page).last();
    await expect(line).toHaveAttribute('data-outcome', 'enrich_existing');
    await expect(line).toContainText(`Added the diagnosis to ${existing.identifier}`);
    await expect(line).toContainText('Nothing new was filed.');
    await expect(line.getByRole('link', { name: new RegExp(existing.identifier) })).toBeVisible();
    await beat();

    // ── Triage gained no row ──────────────────────────────────────────────
    expect(await triageCount(seed.projectId)).toBe(triageBefore);
    await page.goto('/requested-features');
    await expect(page.getByRole('heading', { level: 1, name: 'Requested features' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: new RegExp(REPORT_TITLE) })).toBeVisible();
    await expect(page.getByRole('button', { name: /mention/i })).toHaveCount(0);
    await beat();
  });
});
