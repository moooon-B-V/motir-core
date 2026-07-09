// E2E: the issue importer — CSV path (Story 7.16 · MOTIR-945 / 7.16.9), end to
// end over the real stack (Next routes + Postgres). A signed-in user drives the
// whole wizard — connect → map → dry-run preview → run → progress — over the
// CREDENTIAL-FREE CSV source, which exercises the REAL engine (mapping → persist
// → idempotency → NDJSON run) and writes real work items. It proves three
// promises from a user's seat: work items appear correctly mapped, a re-run
// UPDATEs instead of duplicating, and the dry-run gate writes nothing until
// Confirm.
//
// Why CSV-only (not Jira): the live connectors (Jira/Linear/Plane/GitHub) call a
// real vendor API and have NO server-side stub reachable from a Playwright-driven
// dev server — instrumentation.ts ships E2E seams for OAuth/Blob/Billing only, and
// page.route can't intercept the server-side connector's fetches (it would bypass
// the engine under test). The Jira connector's field mapping is covered where its
// recorded-payload stub genuinely lives: tests/import/jiraConnector.test.ts +
// tests/integration/import/importSeam.test.ts (MOTIR-944). See notes.html #152.
//
// CSV carries no comments (one row per issue), so "comments mapped" is a Jira-path
// property asserted in the MOTIR-944 vitest seam, not here; this spec asserts
// kind/status/priority/assignee/labels + parent, which the CSV format DOES carry.
//
// The exhaustive field-mapping truth is read back from Postgres (the authoritative
// committed-state read the E2E discipline blesses); the UI assertions prove the
// items surface to the user. Run: `pnpm test:e2e --grep import`.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedImportTenant, type ImportSeed } from './_helpers/import-seed';

// In-process seeding (users/workspace/project) + a real sign-in + a full CSV
// import round-trip per test need more than the 30s default; serial because the
// three tests share one seeded tenant and build on each other's committed state.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

// ── CSV fixtures (inline — there are no on-disk importer fixtures) ────────────
const HEADER = 'id,title,type,status,priority,assignee,labels,parent';
const ASSIGNEE = 'dev.two@import.dev'; // the seeded second member

// The base export: 4 issues spanning every mapped field. `QA` is a status with
// no auto-match (forcing an explicit Map decision); `ACME-2` parents to `ACME-1`.
function baseCsv(loginTitle = 'Login bug'): string {
  return [
    HEADER,
    `ACME-1,Checkout epic,story,To Do,high,${ASSIGNEE},auth;ux,`,
    `ACME-2,Payment subtask,subtask,In Progress,medium,,backend,ACME-1`,
    `ACME-3,${loginTitle},bug,Done,low,${ASSIGNEE},,`,
    `ACME-4,QA pass,task,QA,medium,,,`,
  ].join('\n');
}

// A distinct export whose ids do NOT exist yet — used by the gate test, so if the
// abort ever leaked a write it would ADD a row (a count change we can catch).
const GATE_CSV = [HEADER, `GATE-1,Should never be written,task,To Do,medium,,,`].join('\n');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Sign in as the seeded owner and open the wizard for the seeded project. */
async function openWizard(page: Page, seed: ImportSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto(`/onboarding/import?projectId=${seed.projectId}`);
  await expect(
    page.getByRole('radiogroup', { name: 'Where are your issues coming from?' }),
  ).toBeVisible();
  // The step rail opens on Connect, with Import locked behind the dry-run.
  await expect(page.locator('[aria-current="step"]')).toHaveText('Connect');
  await expect(page.getByText('locked until preview')).toBeVisible();
}

/** Connect step: pick CSV, upload the inline file, choose the id column, advance
 *  to Map (waits on the authoritative Map heading — discover has resolved). */
async function uploadCsvToMap(page: Page, csv: string): Promise<void> {
  await page.getByRole('radio', { name: 'CSV' }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('export.csv ready')).toBeVisible();
  await page.getByRole('combobox', { name: 'Which column is the issue ID?' }).click();
  await page.getByRole('option', { name: 'id', exact: true }).click();
  await page.getByRole('button', { name: 'Next: map fields' }).click();
  await expect(page.getByRole('heading', { name: 'Map source fields to Motir' })).toBeVisible();
}

/** Map step → Preview. Resolves the unmatched `QA` status when present (the base
 *  fixture), which is BOTH the required decision and the "adjust one mapping"
 *  step; then advances (waits on the authoritative Preview heading). */
async function mapToPreview(page: Page, opts: { resolveQa: boolean }): Promise<void> {
  const unresolved = page.getByRole('status').filter({ hasText: 'needs a decision' });
  if (opts.resolveQa) {
    // The gate holds while a status is unmatched: banner shown, Next disabled.
    await expect(unresolved).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next: preview' })).toBeDisabled();
    // Discovered statuses are sorted (Done, In Progress, QA, To Do) → QA is the
    // 3rd status combobox. Map it to In Review.
    await page.getByRole('combobox', { name: 'Status → workflow status' }).nth(2).click();
    await page.getByRole('option', { name: 'In Review', exact: true }).click();
    await expect(unresolved).toHaveCount(0);
  } else {
    await expect(unresolved).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Next: preview' }).click();
  await expect(page.getByRole('heading', { name: 'Review what will be imported' })).toBeVisible();
  // The review-before-write gate is stated on every Preview.
  await expect(page.getByText('Nothing has been written to Motir yet.')).toBeVisible();
}

/** Confirm the dry-run and wait for the run to COMMIT: the /run POST returns 200
 *  (armed before the click — the RunStep fires it on mount) and the terminal
 *  heading + the aria-live counts region land. */
async function confirmAndRun(page: Page, expectedCount: number, project: string): Promise<void> {
  const runDone = page.waitForResponse(
    (r) => /\/api\/import\/[^/]+\/run$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /^Confirm & import/ }).click();
  expect((await runDone).status()).toBe(200);
  await expect(
    page.getByRole('heading', {
      name: new RegExp(`Imported ${expectedCount} issues? into ${project}`),
    }),
  ).toBeVisible({ timeout: 30_000 });
  // The aria-live counts region announces the same totals.
  await expect(page.getByRole('status').filter({ hasText: 'created' })).toBeVisible();
}

async function projectItemCount(projectId: string): Promise<number> {
  return db.workItem.count({ where: { projectId } });
}

async function itemByTitle(projectId: string, title: string) {
  return db.workItem.findFirst({ where: { projectId, title } });
}

async function labelNames(workItemId: string): Promise<string[]> {
  const rows = await db.workItemLabel.findMany({
    where: { workItemId },
    include: { label: true },
  });
  return rows.map((r) => r.label.name).sort();
}

// ════════════════════════════════════════════════════════════════════════════
test.describe('issue importer — CSV path (7.16.9)', () => {
  let seed: ImportSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedImportTenant('import-e2e-owner@motir.dev');
  });

  test('imports a CSV through the wizard; work items appear on /backlog, correctly mapped', async ({
    page,
  }) => {
    await openWizard(page, seed);
    await uploadCsvToMap(page, baseCsv());
    await mapToPreview(page, { resolveQa: true });

    // Preview: a first run is all CREATE, nothing to update.
    await expect(page.getByText('To create')).toBeVisible();
    await expect(page.getByText('CREATE', { exact: true })).toHaveCount(4);
    await expect(page.getByText('UPDATE', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Checkout epic')).toBeVisible();

    await confirmAndRun(page, 4, seed.projectName);

    // The user lands on the backlog and sees the imported work items. The
    // backlog hides Done work, so the 4 imported issues show as 3 rows here —
    // the Done "Login bug" is verified through the authoritative DB read below.
    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toContainText('3');
    await expect(page.getByText('Checkout epic')).toBeVisible();
    await expect(page.getByText('Payment subtask')).toBeVisible();

    // Authoritative field-mapping truth, read back from Postgres.
    expect(await projectItemCount(seed.projectId)).toBe(4);
    expect(await db.importedIssue.count({ where: { projectId: seed.projectId } })).toBe(4);

    const epic = await itemByTitle(seed.projectId, 'Checkout epic');
    const subtask = await itemByTitle(seed.projectId, 'Payment subtask');
    const bug = await itemByTitle(seed.projectId, 'Login bug');
    const qa = await itemByTitle(seed.projectId, 'QA pass');
    expect(epic && subtask && bug && qa).toBeTruthy();

    // kind ← type; status ← workflow status (QA → the mapped In Review); priority;
    // assignee ← matched member email; labels; parent ← the parent column.
    expect(epic!.kind).toBe('story');
    expect(epic!.status).toBe('todo');
    expect(epic!.priority).toBe('high');
    expect(epic!.assigneeId).toBe(seed.memberId);
    expect(await labelNames(epic!.id)).toEqual(['auth', 'ux']);
    expect(epic!.parentId).toBeNull();

    expect(subtask!.kind).toBe('subtask');
    expect(subtask!.status).toBe('in_progress');
    expect(subtask!.priority).toBe('medium');
    expect(subtask!.assigneeId).toBeNull(); // no assignee column value → unassigned
    expect(await labelNames(subtask!.id)).toEqual(['backend']);
    expect(subtask!.parentId).toBe(epic!.id); // ACME-2 → ACME-1

    expect(bug!.kind).toBe('bug');
    expect(bug!.status).toBe('done');
    expect(bug!.priority).toBe('low');
    expect(bug!.assigneeId).toBe(seed.memberId);

    expect(qa!.kind).toBe('task');
    expect(qa!.status).toBe('in_review'); // the explicit QA → In Review mapping
  });

  test('a re-run UPDATEs instead of duplicating; the backlog count is unchanged', async ({
    page,
  }) => {
    const before = await projectItemCount(seed.projectId);
    expect(before).toBe(4);

    // Re-import the SAME ids with ONE changed title → that row hashes differently
    // (UPDATE); the rest are unchanged (SKIP); nothing is a CREATE.
    await openWizard(page, seed);
    await uploadCsvToMap(page, baseCsv('Login bug (edited)'));
    await mapToPreview(page, { resolveQa: true });

    await expect(page.getByText('Every issue is already imported', { exact: false })).toBeVisible();
    await expect(page.getByText('CREATE', { exact: true })).toHaveCount(0);
    await expect(page.getByText('UPDATE', { exact: true })).toHaveCount(1);
    await expect(page.getByText('SKIP', { exact: true })).toHaveCount(3);

    await confirmAndRun(page, 1, seed.projectName);

    // No duplicates: the same 4 items, the edited one re-synced in place.
    expect(await projectItemCount(seed.projectId)).toBe(4);
    expect(await db.importedIssue.count({ where: { projectId: seed.projectId } })).toBe(4);
    expect(await itemByTitle(seed.projectId, 'Login bug (edited)')).toBeTruthy();
    expect(await itemByTitle(seed.projectId, 'Login bug')).toBeNull();

    // Still exactly 3 backlog rows — the re-run updated in place, added none.
    // ("Login bug (edited)" is Done, so it stays out of the backlog; verified
    // via the DB read above.)
    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toContainText('3');
    await expect(page.getByText('Checkout epic')).toBeVisible();
  });

  test('aborting at Preview writes nothing — the gate holds', async ({ page }) => {
    const before = await projectItemCount(seed.projectId);

    // A brand-new id that does not exist yet — reach Preview (a dry run, no
    // writes) then LEAVE without Confirm.
    await openWizard(page, seed);
    await uploadCsvToMap(page, GATE_CSV);
    await mapToPreview(page, { resolveQa: false });
    await expect(page.getByText('CREATE', { exact: true })).toHaveCount(1);

    // Abort: navigate away from the wizard without confirming.
    await page.goto('/backlog');

    // Nothing was written — no GATE-1 item, and the project count is untouched.
    expect(await projectItemCount(seed.projectId)).toBe(before);
    expect(await itemByTitle(seed.projectId, 'Should never be written')).toBeNull();
  });
});
