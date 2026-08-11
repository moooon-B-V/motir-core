import { expect } from '@playwright/test';
import { test } from './_helpers/acceptance-video';
import { db, resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

// Story MOTIR-2588 — a project's mark becomes an uploaded image (Subtask
// MOTIR-2682).
//
// THE ACCEPTANCE RECEIPT. What this story ships is mostly an ABSENCE, and an
// absence is the one thing a changelog line cannot convey. "Projects without a
// logo show their name alone" reads, on paper, like a description of a missing
// feature. Watching it is what makes it a decision: the bar shows a name, the
// switcher list shows two projects where only one has a picture and both names
// still line up, and nothing anywhere is a coloured square with two letters in
// it.
//
// So the clip is shot in the order that makes the absence legible — the empty
// state FIRST, then the picture, then the removal back to empty. Seeing it come
// and go is the argument; a still of either end is not.
//
// The functional assertions — every band, the rejection copy, the alignment
// geometry, the org menu — are `project-logo.spec.ts`. This file is the thing a
// person watches, and it deliberately walks the wide, happy path only: a receipt
// that tried to be a test would be neither.
//
// Nothing about the product is stubbed. A real sign-up, a real project, the real
// upload route. The ONE stub is the browser's read of the object store's public
// URL, which is unavoidable — `MOTIR_S3_PUBLIC_BASE_URL` points at an invalid
// host by design in this lane, and without fulfilling it the video would show a
// broken-image glyph, which is the opposite of a receipt.

test.describe.configure({ timeout: 240_000 });

// A LOGO worth filming: 96×96, filled, so the mark reads as a picture at 22px in
// the bar rather than as a speck. Written as a data-URI-free raw PNG so the spec
// stays dependency-free — a solid-colour square is enough to see.
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAP0lEQVR42u3OMQEAAAgDoK1/aM3g' +
    '4QcJSHOlAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICH1kL0QABm3iVGgAAAABJRU5ErkJggg==',
  'base64',
);

test('a project gets a face, and loses it again', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // Publishes the clip to THIS story. The publish OUTCOME — the artifact's
  // location, or the reason it did not upload (no OIDC / no PAT / an unwatchable
  // clip) — is reported by `scripts/upload-acceptance-video.mjs` in the job log
  // and its annotations, so "the step was green" can never stand in for "a
  // reviewer has something to watch".
  acceptanceStory('MOTIR-2588');

  await resetDatabase();
  // 1440, not 1280: `xl` is 1280 and a classic scrollbar shortens the layout
  // viewport a media query reads, so the breakpoint's first pixel is a coin flip
  // in CI. The receipt should show the full context path, not straddle it.
  await page.setViewportSize({ width: 1440, height: 812 });

  // Answer the browser's read of the public bucket, so the uploaded logo PAINTS.
  await page.route(/\.public\.store\.invalid\//, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: LOGO_PNG }),
  );

  const bar = page.locator('header nav[aria-label]');
  const projectTier = bar.getByRole('button', { name: 'Switch project' });

  await chapter('A new project has no mark — and nothing stands in for one', async () => {
    const email = `acceptance-project-logo-${Date.now()}@example.com`;
    await signUp(page, email);
    // Sign-up derives an org name from the address, which reads as machine
    // exhaust on a clip a person is meant to watch. The org's NAME is what the
    // top tier renders now that it has no mark, so it is on screen throughout —
    // give it one worth reading.
    await db.organization.updateMany({ data: { name: 'Northwind' } });
    await createFirstProject(page, 'Mobile App');
    await page.reload();

    // The bar's last tier is the project, and it is a NAME. No tile, no
    // key-letters, no reserved gap where a picture would go.
    await expect(projectTier).toContainText('Mobile App');
    await expect(projectTier.locator('img')).toHaveCount(0);
    await beat();

    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    // The row is one button. There is no "Image" label above it — a word
    // describing a picture, printed where the picture goes, says nothing the
    // picture would not.
    await expect(page.getByRole('button', { name: 'Upload logo' })).toBeVisible();
    await beat();
  });

  await chapter('Upload one, and it appears everywhere the project is named', async () => {
    const uploaded = page.waitForResponse(
      (r) => r.url().endsWith('/api/upload/project-image') && r.request().method() === 'POST',
    );
    await page.locator('input[data-testid="project-logo-input"]').setInputFiles({
      name: 'mobile-app.png',
      mimeType: 'image/png',
      buffer: LOGO_PNG,
    });
    expect((await uploaded).status()).toBe(200);
    await expect(page.getByText('Project logo updated', { exact: true })).toBeVisible();
    await beat();

    // The settings row shows it, and so — without a reload — do the two
    // server-rendered surfaces: the top bar's project tier and the settings
    // rail's own header.
    await expect(page.getByRole('img', { name: 'Project logo' })).toBeVisible();
    await expect(projectTier.locator('img')).toHaveCount(1);
    await expect(
      page.getByRole('navigation', { name: 'Project settings' }).locator('img'),
    ).toHaveCount(1);
    await beat();
  });

  await chapter('Two projects, one picture — and the names still line up', async () => {
    await projectTier.click();
    await beat();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByLabel('Project name').fill('Marketing Site');
    await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
    await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible();
    await beat();

    // The list is the one place a slot is held open for a project with no logo —
    // not to draw anything in it, but so every NAME keeps one left edge. This is
    // the shot that shows why: a mixed list that still reads as a column.
    await projectTier.click();
    await expect(page.getByRole('button', { name: 'Mobile App' }).locator('img')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Marketing Site' }).locator('img')).toHaveCount(
      0,
    );
    await beat();

    // Switch BACK to Mobile App: creating the second project made it active, and
    // the last chapter removes a logo from the project that has one.
    await page.getByRole('button', { name: 'Mobile App' }).click();
    await page.waitForURL('**/items**');
    await expect(projectTier).toContainText('Mobile App');
    await beat();
  });

  await chapter('The organization above it has no mark at all, and never will', async () => {
    const org = bar.getByRole('button', { name: 'Organization menu' });
    await expect(org).toBeVisible();
    await expect(org.locator('img')).toHaveCount(0);
    await beat();

    // There is no upload surface for an organization anywhere in the product, so
    // any mark here could only ever have been generated from its name. The tier
    // is its NAME instead — which is the thing the generated square was standing
    // in front of.
    await org.click();
    const menu = page.getByRole('dialog').filter({ hasText: 'Members' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('img')).toHaveCount(0);
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('Remove it, and the name stands on its own again', async () => {
    await page.goto('/settings/project');
    await expect(page.getByRole('img', { name: 'Project logo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    await beat();

    await page.getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove project logo?' });
    await expect(dialog).toBeVisible();
    // The confirm says what happens rather than asking "are you sure": Motir
    // will show the project by name wherever the logo appeared.
    await expect(dialog).toContainText('show the project by name');
    await beat();

    await dialog.getByRole('button', { name: 'Remove logo' }).click();
    await expect(page.getByText('Project logo removed', { exact: true })).toBeVisible();
    await beat();

    // Back to where the clip started — and this is the whole story in one frame.
    // Not a placeholder square, not two grey letters: a name, and the space
    // beside it closed.
    await expect(page.getByRole('img', { name: 'Project logo' })).toHaveCount(0);
    await expect(projectTier.locator('img')).toHaveCount(0);
    await expect(projectTier).toContainText('Mobile App');
    await beat();
  });

  await db.$disconnect();
});
