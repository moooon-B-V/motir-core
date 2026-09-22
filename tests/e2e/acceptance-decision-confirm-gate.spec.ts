import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedDecisionConfirmGate,
  type DecisionConfirmGateSeed,
  type SeededDecision,
} from './_helpers/decision-confirm-gate-seed';
import { adminDb } from '@/tests/helpers/adminDb';
import en from '@/messages/en.json';

// A RE-PLAN THAT CHANGED APPROVED WORK RECORDS WHY, AND A PERSON CONFIRMS IT — THE
// ACCEPTANCE RECEIPT (Story MOTIR-5871 · Subtask MOTIR-5964).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A re-plan changed work the requester had already approved, so it wrote a DECISION
// under the epic: what was decided, what changed, which approved work it supersedes,
// and where the epic now stands. It waits on To approve. The person reads it and
// CONFIRMS it — the record says who, when, and which written record they confirmed
// against. A second one is not what was discussed: Overturn refuses to go without a
// note, then records the note and owes a re-plan for the work it superseded. A third
// has no write-up and confirms without complaint. Then the answers a demo would hide: a
// body that is not complete asks nothing and says why, and somebody who may not decide
// sees each decision and no controls.
//
// ⚠️ PACED FOR A PERSON. The happy path's holds are `chapter()` / `beat()`'s, taken
// AFTER each assertion, long enough to read a decision's sections and the overturn
// note before each press. Every WAIT is authoritative — a role, a settled dialog name,
// the server action's response, a status read — never a timed sleep.

test.describe.configure({ timeout: 480_000 });

const dc = en.approvalGate.decisionConfirm;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

/** The To-approve table's row for a card. */
const rowFor = (page: Page, card: SeededDecision): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: card.identifier });

/** The confirm overlay, by its SETTLED accessible name — the read's own answer. */
const overlayFor = (page: Page, card: SeededDecision): Locator =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, {
      kind: en.workbench.approvals.kind.decision_confirmation,
      key: card.identifier,
    }),
    exact: true,
  });

/** The item page's Decision section card. */
const decisionCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: dc.sectionTitle, exact: true }) });

/** The detail rail's Status field card. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

const statusOf = async (card: SeededDecision) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status;

async function openFromToApprove(page: Page, card: SeededDecision): Promise<Locator> {
  await page.goto('/workbench?tab=approvals');
  await rowFor(page, card)
    .getByRole('button', { name: en.workbench.approvals.review, exact: true })
    .click();
  const dialog = overlayFor(page, card);
  await expect(dialog).toHaveCount(1, { timeout: 60_000 });
  return dialog;
}

async function confirm(dialog: Locator, page: Page) {
  await dialog.getByRole('button', { name: dc.verb.confirm, exact: true }).click();
  await expect(dialog.getByText(dc.confirmStep.title, { exact: true })).toBeVisible();
  const action = serverAction(page);
  await dialog.getByRole('button', { name: dc.confirmStep.proceed, exact: true }).click();
  expect((await action).status()).toBe(200);
}

test.describe('a decision that changed approved work is confirmed, or overturned with a note', () => {
  let seed: DecisionConfirmGateSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedDecisionConfirmGate(Date.now().toString(36));
    await signIn(page, seed.ownerEmail, seed.password);
  });

  test('confirm with a record, overturn with a note, confirm with none; the defect, and a reader who may not decide', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5871');

    await chapter('The decisions are waiting on To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      const rows = page
        .getByRole('table', { name: en.workbench.tabs.toApprove })
        .getByTestId(/^approval-row-/);
      // Four complete decisions ask; the defective one asks nothing.
      await expect(rows).toHaveCount(4, { timeout: 60_000 });
      await expect(
        rowFor(page, seed.recorded).getByText(
          fill(dc.row.awaiting, {
            changes: dc.change.workflow,
            count: 1,
            decision: 'Exported reports are written to managed object storage, not to Postgres.',
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(rowFor(page, seed.defect)).toHaveCount(0);
    });
    await beat();

    await chapter(
      'Open it: the decision, what changed, what it supersedes, where the epic stands',
      async () => {
        const dialog = await openFromToApprove(page, seed.recorded);
        await expect(dialog.getByText(dc.eyebrow.whatChanged, { exact: true })).toBeVisible();
        await expect(dialog.getByText(dc.change.workflow, { exact: true }).first()).toBeVisible();
        await expect(
          dialog.getByText(fill(dc.eyebrow.supersedes, { count: 1 }), { exact: true }),
        ).toBeVisible();
        await expect(
          dialog.getByRole('link', { name: new RegExp(seed.story.identifier) }),
        ).toBeVisible();
        await expect(
          dialog.getByText(dc.eyebrow.resultingDirection, { exact: true }),
        ).toBeVisible();
        // The written record it will be confirmed against.
        await expect(dialog.getByRole('link', { name: seed.recordFilename })).toBeVisible();
      },
    );
    await beat();

    await chapter(
      'Confirm it: recorded with its written record, and the decision is Done',
      async () => {
        const dialog = overlayFor(page, seed.recorded);
        await confirm(dialog, page);
        await expect(dialog.getByText(new RegExp('^Confirmed by Yue Owner'))).toBeVisible({
          timeout: 60_000,
        });
        await expect(dialog.getByText(dc.band.withRecord, { exact: true })).toBeVisible();
        await expect(dialog.getByRole('link', { name: seed.recordFilename })).toBeVisible();
        await expect.poll(() => statusOf(seed.recorded), { timeout: 30_000 }).toBe('done');
        // It has left To approve.
        await page.goto('/workbench?tab=approvals');
        await expect(
          page
            .getByRole('table', { name: en.workbench.tabs.toApprove })
            .getByTestId(/^approval-row-/),
        ).toHaveCount(3, { timeout: 60_000 });
        await expect(rowFor(page, seed.recorded)).toHaveCount(0);
      },
    );
    await beat();

    await chapter('Overturn needs a note — refused without one, and nothing moves', async () => {
      const dialog = await openFromToApprove(page, seed.overturned);
      await expect(
        dialog.getByText(
          'The export history page is dropped; a customer re-runs an export instead.',
        ),
      ).toBeVisible();
      await dialog.getByRole('button', { name: dc.verb.overturn, exact: true }).click();
      await expect(dialog.getByText(dc.overturnStep.title, { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: dc.overturnStep.proceed, exact: true }).click();
      await expect(dialog.getByText(dc.note.required, { exact: true })).toBeVisible();
      expect(await statusOf(seed.overturned)).toBe('in_review');
    });
    await beat();

    await chapter('With the note, it is Overturned and a re-plan is owed', async () => {
      const dialog = overlayFor(page, seed.overturned);
      await dialog.getByLabel(dc.note.label).fill("that's not what we discussed");
      await beat();
      const action = serverAction(page);
      await dialog.getByRole('button', { name: dc.overturnStep.proceed, exact: true }).click();
      expect((await action).status()).toBe(200);
      await expect(dialog.getByText(new RegExp('^Overturned by Yue Owner'))).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        dialog.getByText("“that's not what we discussed”", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText(dc.band.replanOwed, { exact: true })).toBeVisible();
      await expect(
        dialog.getByRole('link', { name: new RegExp(seed.story.identifier) }).last(),
      ).toBeVisible();
      await expect.poll(() => statusOf(seed.overturned), { timeout: 30_000 }).toBe('cancelled');
      // The overturn changed no other work item.
      expect(await statusOf(seed.story)).toBe('todo');
    });
    await beat();

    await chapter('A decision with no write-up confirms without complaint', async () => {
      const dialog = await openFromToApprove(page, seed.bare);
      await expect(dialog.getByText(dc.record.none, { exact: true })).toBeVisible();
      await confirm(dialog, page);
      await expect(dialog.getByText(dc.band.withoutRecord, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect.poll(() => statusOf(seed.bare), { timeout: 30_000 }).toBe('done');
      await page.goto(`/items/${seed.bare.identifier}`);
      await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        decisionCard(page).getByText(dc.band.withoutRecord, { exact: true }),
      ).toBeVisible();
    });
    await beat();

    await chapter('A decision that is not complete asks nothing, and says why', async () => {
      await page.goto(`/items/${seed.defect.identifier}`);
      const card = decisionCard(page);
      await expect(card.getByText(dc.defect.title, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(card.getByText(dc.defect.no_resulting_direction, { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: dc.verb.confirm })).toHaveCount(0);
      await expect(card.getByRole('button', { name: dc.verb.overturn })).toHaveCount(0);
    });
    await beat();

    await chapter('Somebody who may not decide sees each decision and no controls', async () => {
      await signIn(page, seed.viewerEmail, seed.password);
      for (const card of [seed.watched, seed.recorded, seed.overturned, seed.bare]) {
        await page.goto(
          `/workbench?approval=${card.identifier}&approvalKind=decision_confirmation`,
        );
        const dialog = overlayFor(page, card);
        await expect(dialog).toHaveCount(1, { timeout: 60_000 });
        await expect(dialog.getByTestId('decision-confirm-port')).toBeVisible();
        await expect(
          dialog.getByRole('button', { name: dc.verb.confirm, exact: true }),
        ).toHaveCount(0);
        await expect(
          dialog.getByRole('button', { name: dc.verb.overturn, exact: true }),
        ).toHaveCount(0);
      }
      // The one still waiting says whom it waits on; the last one opened reads as decided.
      await expect(
        overlayFor(page, seed.bare).getByText(dc.band.withoutRecord, { exact: true }),
      ).toBeVisible();
      await page.goto(
        `/workbench?approval=${seed.watched.identifier}&approvalKind=decision_confirmation`,
      );
      await expect(
        overlayFor(page, seed.watched).getByText(
          fill(en.approvalGate.waitingOn, { name: 'Yue Owner' }),
        ),
      ).toBeVisible({ timeout: 60_000 });
    });
    await beat();
  });
});
