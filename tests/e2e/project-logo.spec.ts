// E2E: the project LOGO journey (Story MOTIR-2588 · Subtask MOTIR-2682) — the
// story's verification recipe driven end-to-end over the real stack.
//
// ── WHAT THIS SPEC IS ACTUALLY FOR ──────────────────────────────────────────
// Most of it asserts an ABSENCE, which is unusual and easy to get wrong. Every
// comparable product draws a generated square for a project with no image;
// `docs/decisions/entity-marks.md` §3 draws NOTHING, and the moment that matters
// most is the one after a remove, where the top bar shows a name and nothing
// beside it — no tile, no monogram, no reserved gap.
//
// The way to assert that badly is to check the settings row and stop. The row
// holds its own optimistic copy and flips instantly; the header only catches up
// after the server re-read. A spec that watches the row has proved the animation.
// So every header assertion here comes AFTER an authoritative wait — the upload
// route's response, or a real navigation that re-renders the shell from the
// server.
//
// ── THE UPLOAD MECHANISM IS SHIPPED, NOT INVENTED ───────────────────────────
// `profile.spec.ts` already drives this exact two-layer upload for the account
// avatar, and this follows it:
//   • SERVER side, `E2E_TEST_BLOB=1` installs `lib/test-blob-mock.ts` at the S3
//     SDK's own transport via `instrumentation.ts`, so the app's PUT never
//     leaves the process.
//   • BROWSER side, Chromium's fetch of the returned PUBLIC url goes to
//     `MOTIR_S3_PUBLIC_BASE_URL`, which no server-side interception can reach —
//     a `page.route` fulfils it so the <img> actually paints. The public bucket
//     is deliberately NOT served by `_helpers/object-store.ts`, which covers the
//     PRIVATE store only.
//
// Project settings are PROJECT-scoped, so (unlike the account pane) the personas
// are seeded through the shipped services and the active project is pinned on
// the membership row — the `project-details.spec.ts` / `settings-area.spec.ts`
// precedent.
//
// The ref gate's edge cases, the after-commit blob collection and the DTO
// read-back are proven at the vitest tier (MOTIR-2681); this spec does NOT
// re-assert them.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { organizationsService } from '@/lib/services/organizationsService';
import type { WorkspaceContext } from '@/lib/workspaces/context';

const PWD = 'project-logo-e2e-pass-123';

// A minimal valid 1×1 PNG — the same payload `profile.spec.ts` uploads. PNG
// passes both the client allowlist and the route's MIME gate.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Tenant {
  workspaceId: string;
  ownerId: string;
  ownerEmail: string;
  ownerCtx: WorkspaceContext;
  projectId: string;
  secondProjectId: string;
}

/**
 * Owner + workspace + TWO projects, the owner pinned to the first.
 *
 * Two, because step 4 is about a MIXED list: the switcher has to show an imaged
 * project beside an un-imaged one and keep both names on one left edge. One
 * project cannot demonstrate that, and a list where every row is the same is
 * exactly the list that hides an alignment bug.
 */
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: ownerEmail,
    password: PWD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Logo Workspace',
    ownerUserId: owner.id,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Mobile App',
    identifier: 'MOBI',
  });
  const second = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Marketing Site',
    identifier: 'MKTG',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    ownerEmail,
    ownerCtx,
    projectId: project.id,
    secondProjectId: second.id,
  };
}

/** Answer the browser's read of the public bucket so the <img> paints. */
async function servePublicBucket(page: Page): Promise<void> {
  await page.route(/\.public\.store\.invalid\//, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }),
  );
}

const bar = (page: Page) => page.locator('header nav[aria-label]');
const projectTier = (page: Page) => bar(page).getByRole('button', { name: 'Switch project' });
const orgTier = (page: Page) => bar(page).getByRole('button', { name: 'Organization menu' });
const settingsRail = (page: Page) => page.getByRole('navigation', { name: /Project settings/i });

/**
 * Upload a file through the row and wait on the UPLOAD ROUTE's own response —
 * the authoritative signal, armed before the action so it cannot be missed.
 * Returns the response so a caller can assert its status.
 */
async function uploadLogo(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/upload/project-image') && r.request().method() === 'POST',
  );
  await page.locator('input[data-testid="project-logo-input"]').setInputFiles(file);
  return response;
}

test.describe('project logo — upload, header, remove, and the empty state', () => {
  // A real sign-in (argon2) plus several server round-trips per test.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('@smoke upload → the header follows → remove → the header shows a NAME and nothing else', async ({
    page,
  }) => {
    const tenant = await seedTenant('logo-owner-1@example.com');
    await servePublicBucket(page);
    await signIn(page, tenant.ownerEmail, PWD);

    // ── 1. The empty state — no logo, and nothing standing in for one ────────
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    // The row is ONE button and it carries the noun, because with no picture
    // beside it a bare "Upload" reads as "upload what?".
    await expect(page.getByRole('button', { name: 'Upload logo' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Project logo' })).toHaveCount(0);
    // …and no label above it: the picture speaks for itself once there is one.
    await expect(page.getByText('Image', { exact: true })).toHaveCount(0);

    // The bar and the settings rail agree — the project is its NAME alone.
    await expect(projectTier(page)).toContainText('Mobile App');
    await expect(projectTier(page).locator('img')).toHaveCount(0);
    await expect(settingsRail(page).locator('img')).toHaveCount(0);

    // ── 2. Upload → the row, the bar and the rail all show it ───────────────
    const uploaded = await uploadLogo(page, {
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    expect(uploaded.status()).toBe(200);
    await expect(page.getByText('Project logo updated', { exact: true })).toBeVisible();

    const rowImage = page.getByRole('img', { name: 'Project logo' });
    await expect(rowImage).toBeVisible();
    await expect(rowImage).toHaveAttribute('src', /\.public\.store\.invalid\/projects\//);

    // THE assertion this step exists for. The row above is optimistic; these two
    // are server-rendered, so they only change once the write actually landed.
    // `router.refresh()` is what carries them — no manual reload here on purpose,
    // because "you have to reload to see it" is a bug, not a test detail.
    await expect(projectTier(page).locator('img')).toHaveCount(1);
    await expect(settingsRail(page).locator('img')).toHaveCount(1);

    // Persisted: a real navigation re-reads the shell from Postgres.
    await page.goto('/items');
    await expect(projectTier(page).locator('img')).toHaveCount(1);

    // ── 3. Remove → every one of those places shows the NAME and nothing ─────
    await page.goto('/settings/project');
    await page.getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove project logo?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove logo' }).click();
    await expect(page.getByText('Project logo removed', { exact: true })).toBeVisible();

    // The headline behaviour of the whole story, asserted as an ABSENCE in the
    // accessible tree rather than as "the settings row changed".
    await expect(page.getByRole('img', { name: 'Project logo' })).toHaveCount(0);
    await expect(projectTier(page).locator('img')).toHaveCount(0);
    await expect(settingsRail(page).locator('img')).toHaveCount(0);
    // Not a monogram either: the tier's whole text is the project's name.
    await expect(projectTier(page)).toContainText('Mobile App');
    await expect(projectTier(page).getByText('MO', { exact: true })).toHaveCount(0);
    // And the row is back to its one-button empty state.
    await expect(page.getByRole('button', { name: 'Upload logo' })).toBeVisible();

    // Survives a real re-read — the removal was committed, not just painted.
    await page.goto('/items');
    await expect(projectTier(page).locator('img')).toHaveCount(0);
    await expect(projectTier(page)).toContainText('Mobile App');
  });

  test('the switcher list mixes imaged and un-imaged rows, and the names stay aligned', async ({
    page,
  }) => {
    const tenant = await seedTenant('logo-owner-2@example.com');
    // Give ONE of the two a logo, through the service — this test is about the
    // LIST, and driving the upload UI twice would be re-testing step 2.
    await servePublicBucket(page);
    await signIn(page, tenant.ownerEmail, PWD);
    await page.goto('/settings/project');
    expect(
      (
        await uploadLogo(page, {
          name: 'logo.png',
          mimeType: 'image/png',
          buffer: PNG_1x1,
        })
      ).status(),
    ).toBe(200);
    await expect(page.getByText('Project logo updated', { exact: true })).toBeVisible();

    await page.goto('/items');
    await projectTier(page).click();

    const imaged = page.getByRole('button', { name: 'Mobile App' });
    const plain = page.getByRole('button', { name: 'Marketing Site' });
    await expect(imaged.locator('img')).toHaveCount(1);
    await expect(plain.locator('img')).toHaveCount(0);

    // ALIGNMENT is the reason a LIST row holds the slot open while the BAR closes
    // the gap (MOTIR-2675 drew and measured both). Assert it as geometry: the two
    // names start at the same x, even though only one row has a picture.
    const nameLeft = async (row: typeof imaged, text: string) => {
      const box = await row.getByText(text, { exact: true }).boundingBox();
      expect(box, `${text} must be laid out`).not.toBeNull();
      return box!.x;
    };
    expect(await nameLeft(imaged, 'Mobile App')).toBeCloseTo(
      await nameLeft(plain, 'Marketing Site'),
      0,
    );
  });

  test('the organization tier carries no mark — in the bar, and in its own menu', async ({
    page,
  }) => {
    const tenant = await seedTenant('logo-owner-3@example.com');
    // A SECOND organization, so the menu's "Switch organization" section renders
    // at all — it is gated on `orgs.length >= 2`, and that list is the second
    // place an org mark would naturally have been drawn (one row per org, which
    // is exactly the shape that invites a tile beside each name).
    await organizationsService.createOrganization({
      name: 'Second Org',
      actorUserId: tenant.ownerId,
    });
    await signIn(page, tenant.ownerEmail, PWD);
    // 1440 rather than 1280: `xl` is 1280 and a classic scrollbar shortens the
    // layout viewport a media query reads, so the breakpoint's first pixel is a
    // coin flip in CI. The org tier is visible from `md`, and this is the width
    // the design settled the full path on.
    await page.setViewportSize({ width: 1440, height: 812 });
    await page.goto('/items');

    // An organization has no way to HAVE an image — there is no upload surface,
    // no column and no route (`docs/decisions/entity-marks.md` §2) — so a mark
    // here could only ever be generated from the name.
    const org = orgTier(page);
    await expect(org).toBeVisible();
    await expect(org.locator('img')).toHaveCount(0);
    // Still OPERABLE, and not a chevron in an empty button: the tier's content is
    // the organization's NAME, which is what the mark used to stand in for
    // between `md` and `xl`.
    await expect(org).not.toHaveText('');
    await org.click();
    // The org menu is a Popover, which surfaces as a `dialog` (its rows are two
    // sibling `role="list"`s with the "Switch organization" label BETWEEN them,
    // so neither list contains that text — scope to the popover itself).
    const menu = page.getByRole('dialog').filter({ hasText: 'Switch organization' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('img')).toHaveCount(0);
    // Guard the guard: an empty popover, or one whose switch list never
    // rendered, would satisfy the line above vacuously. The switch list is the
    // shape that most invites a per-org tile — one row per organization.
    await expect(menu.getByRole('button', { name: 'Second Org' })).toBeVisible();
  });

  test('rejects a non-image and an over-ceiling file — with the design’s copy, and NO request', async ({
    page,
  }) => {
    const tenant = await seedTenant('logo-owner-4@example.com');
    await signIn(page, tenant.ownerEmail, PWD);
    await page.goto('/settings/project');
    await expect(page.getByRole('button', { name: 'Upload logo' })).toBeVisible();

    // Count every attempt at the route. The client pre-checks exist so the
    // message a person sees can never state a limit the server does not keep —
    // if one of these DOES reach the network, the pre-check is not running and
    // the copy is the server's to write, not the row's.
    let uploadAttempts = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/upload/project-image')) uploadAttempts += 1;
    });
    const input = page.locator('input[data-testid="project-logo-input"]');

    // A type the copy never offered.
    await input.setInputFiles({
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await expect(
      page.getByText('That file type is not supported. Use a PNG or JPG.', { exact: true }),
    ).toBeVisible();

    // Over the stated 2 MB ceiling — a real PNG header, just too much of it.
    await input.setInputFiles({
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]),
    });
    await expect(
      page.getByText('That logo is over 2 MB. Choose a smaller file.', { exact: true }),
    ).toBeVisible();

    expect(uploadAttempts, 'neither rejection may reach the upload route').toBe(0);
    await expect(page.getByRole('img', { name: 'Project logo' })).toHaveCount(0);
  });
});
