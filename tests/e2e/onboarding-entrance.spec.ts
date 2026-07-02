// E2E — the onboarding ENTRANCE fork (Subtask 7.22.4 / MOTIR-1462).
//
// `/onboarding` is now the idea-first entrance fork (designed by MOTIR-1461); the
// discovery chat moved to `/onboarding/discovery`. This spec proves the fork's two
// exits route correctly, end to end against the real stack:
//   • Start planning → forwards to the discovery chat (/onboarding/discovery),
//     which renders its composer (the idea is carried via the same preserved-idea
//     cookie the chat already seeds from).
//   • Import an existing project → the downstream hand-off stub
//     (/onboarding/import), owned by 7.15 / 7.17.
//
// motir-ai has no presence in CI, so the discovery hub's single browser-reachable
// read (`/api/ai/pre-plan`) is stubbed for the render, exactly as the other
// onboarding specs do.

import { expect, test } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

// Browser sign-up + project + cold-compiled /onboarding + /onboarding/discovery
// comfortably exceed the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test('Start planning routes the entrance into the discovery chat', async ({ page }) => {
  await signUp(page, `entrance-start-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  // The hub reads /api/ai/pre-plan on mount (motir-ai is absent in CI) — stub the
  // empty resume so it renders its chat composer instead of an error.
  await page.route('**/api/ai/pre-plan', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ session: null, docs: [], catalog: null }),
    }),
  );

  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'How would you like to start?' })).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Your idea' })
    .fill('A booking app for a hair salon where clients pick a stylist and time.');
  await page.getByRole('button', { name: /start planning/i }).click();

  // Forwards to the discovery chat surface, which renders its composer.
  await page.waitForURL('**/onboarding/discovery');
  await expect(page.getByRole('textbox', { name: 'Reply, or ask a question…' })).toBeVisible();
});

test('Import routes the entrance to the downstream import hand-off', async ({ page }) => {
  await signUp(page, `entrance-import-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  await page.goto('/onboarding');
  await page.getByRole('link', { name: /i have an existing project/i }).click();

  await page.waitForURL('**/onboarding/import');
  await expect(page.getByRole('heading', { name: 'Import an existing project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to start' })).toBeVisible();
});
