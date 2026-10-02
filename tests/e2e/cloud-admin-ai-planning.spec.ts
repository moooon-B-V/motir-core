import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { adminDb } from '../helpers/adminDb';
import { resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

/**
 * AI PLANNING — the smoke spec (MOTIR-7231, design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10, story MOTIR-7220).
 *
 * ⚠️ IN THE CLOUD LANE ON PURPOSE. The page reads motir-ai, and only this lane
 * points `MOTIR_AI_URL` at the boundary host the `E2E_TEST_PLANNER_MODEL` seam
 * intercepts. The page is server rendered and its write is a Server Action, so
 * `page.route` reaches neither: the spec seeds and reads back the fixture file.
 *
 * What only a browser proves: the rail row reaches the page, a superadmin's save
 * goes through the confirm with a required reason and lands in motir-ai, an
 * operator reads the same rows with no control, and a tenant gets the 404.
 */

test.describe.configure({ timeout: 120_000 });

// The SAME file the webServer is handed in `playwright.cloud.config.ts`.
const FIXTURE =
  process.env['MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-planner-model-fixture.json');

function writeFixture(): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify({
      settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
        audience,
        model: 'claude-opus-5-5',
      })),
      offered: [
        { id: 'claude-opus-5-5', provider: 'anthropic' },
        { id: 'claude-sonnet-5-5', provider: 'anthropic' },
      ],
    }),
  );
}

function storedModel(audience: string): string | undefined {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    settings: { audience: string; model: string }[];
  };
  return fixture.settings.find((s) => s.audience === audience)?.model;
}

test.beforeEach(async () => {
  await resetDatabase();
  writeFixture();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('@smoke a superadmin changes a planning model with a reason; an operator reads it; a tenant gets a 404', async ({
  page,
}) => {
  const email = 'e2e-ai-planning@example.com';
  await signUp(page, email);
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });

  expect((await page.goto('/admin/ai-planning'))?.status()).toBe(404);

  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
  await page.goto('/admin/monitoring');
  await page.getByRole('link', { name: 'AI planning' }).click();
  await expect(page).toHaveURL(/\/admin\/ai-planning$/);
  await expect(page.getByRole('heading', { name: 'Planning model by audience' })).toBeVisible();

  const main = page.getByRole('main');
  const internal = main.getByTestId('ai-planning-row-internal');
  await expect(internal).toContainText('Seeded default · never changed');
  const save = internal.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  await internal.getByRole('combobox', { name: 'Planning model — Internal organisations' }).click();
  await page.getByRole('option', { name: /claude-sonnet-5-5/ }).click();
  await expect(save).toBeEnabled();
  await save.click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('claude-opus-5-5 → claude-sonnet-5-5');
  const confirm = dialog.getByRole('button', { name: 'Change model' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Reason/).fill('Cheaper model for internal planning');
  await confirm.click();

  // The toast and the row's own line are rendered from the action's result and
  // the revalidated read — the authoritative signal, not an optimistic flip.
  await expect(
    page.getByRole('status').filter({ hasText: 'Planning model changed' }),
  ).toBeVisible();
  await expect(internal).toContainText('Changed just now by you');
  expect(storedModel('internal')).toBe('claude-sonnet-5-5');
  expect(storedModel('customer')).toBe('claude-opus-5-5');

  const audit = await adminDb.platformAuditLog.findFirstOrThrow({
    where: { action: 'ai.planner_model.set' },
  });
  expect(audit.reason).toBe('Cheaper model for internal planning');

  // An operator reads the same rows, with no control to use.
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
  await page.reload();
  await expect(main.getByTestId('ai-planning-read-only')).toHaveText(
    'Only a superadmin can change these.',
  );
  await expect(main.getByTestId('ai-planning-row-internal')).toContainText('claude-sonnet-5-5');
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
});
