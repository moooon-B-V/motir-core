// E2E: the Story-5.2 attachments lifecycle (Subtask 5.2.8) — the Story
// CLOSER, driving the real stack. Three passes (the 5.1.7 split; the strict
// axe sweep over this surface extends shell-a11y.spec.ts):
//
//   1. @smoke journey — attach an image + a zip through the panel's Attach
//      button (real multipart POSTs through the real route); drag-drop a PDF
//      onto the panel; thumbnail-vs-glyph cards + the count; the image opens
//      the preview lightbox (Esc returns focus) with Download inside; the
//      zip card DOWNLOADS instead of previewing (the Jira-verified split);
//      an editor upload via the edit form's "Attach file" appears in the
//      panel marked Embedded with its delete DISABLED (the points-at-source
//      block); deleting the zip warns "can't be restored", removes the card,
//      and lands the revision-trail entry.
//   2. At-scale (finding #57) — a 120-row fixture: first paint shows 50
//      behind "Show more (70)", extending appends a cursor page, the
//      strip/list toggle re-renders the loaded window without refetching,
//      and no attachments read ever exceeds the page size (never load-all).
//   3. Role pass — a plain member deletes OWN files only; a project `viewer`
//      sees the panel read-only (no Attach, no delete — absent, not
//      disabled).
//
// Blob plumbing: the dev server runs with E2E_TEST_BLOB=1 (playwright.config
// webServer env), so lib/test-blob-mock intercepts the SERVER-side
// @vercel/blob put/del calls — CI deliberately has no real blob token ("no
// E2E performs a real upload", ci.yml). The BROWSER-side reads of the
// returned public URLs (thumbnails, the lightbox image, downloads) are
// fulfilled here by page.route serving tiny fixture bytes by extension —
// nothing leaves localhost in either direction.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  ATTACHMENTS_PASSWORD,
  MOCK_BLOB_HOST_GLOB,
  seedAttachmentsFixture,
  seedMember,
  seedPanelAttachment,
  seedScaleAttachments,
  seedViewer,
} from './_helpers/attachments-seed';

// Browser sign-up + project + cold-compiled detail/edit routes + several
// real upload round-trips: comfortably more than the 30s default.
test.describe.configure({ timeout: 120_000 });

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 9 9]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);
const ZIP_BYTES = Buffer.from('504b0506000000000000000000000000000000000000', 'hex'); // empty zip

/**
 * Fulfil browser reads of the mock store's public URLs with fixture bytes by
 * extension; `?download=1` (the store's content-disposition switch the
 * download affordances append) forces the attachment disposition so the
 * browser download event fires like the real store.
 */
async function serveMockBlobHost(page: Page): Promise<void> {
  await page.route(MOCK_BLOB_HOST_GLOB, async (route) => {
    const url = new URL(route.request().url());
    const byExt: Record<string, { type: string; body: Buffer }> = {
      '.png': { type: 'image/png', body: PNG_BYTES },
      '.pdf': { type: 'application/pdf', body: PDF_BYTES },
      '.zip': { type: 'application/zip', body: ZIP_BYTES },
    };
    const match = Object.entries(byExt).find(([ext]) => url.pathname.includes(ext));
    const { type, body } = match?.[1] ?? { type: 'text/plain', body: Buffer.from('x') };
    await route.fulfill({
      status: 200,
      contentType: type,
      body,
      headers:
        url.searchParams.get('download') === '1'
          ? { 'content-disposition': 'attachment' }
          : undefined,
    });
  });
}

/** The attachments file list (ul[aria-label="Attachments"]). */
function fileList(page: Page) {
  return page.getByRole('list', { name: 'Attachments' });
}

/**
 * Open the native chooser via the given affordance and feed it files.
 *
 * Retries the click: opening the chooser is a purely client-side effect
 * (`fileInputRef.click()`), so a click landing before React has hydrated the
 * panel is silently swallowed — Playwright's actionability checks can't see
 * hydration, and CI's cold runner loses that race deterministically (the
 * 27373847343 role-pass timeout: "click action done", no filechooser, ever).
 */
async function pickFiles(
  page: Page,
  trigger: ReturnType<Page['getByRole']>,
  files: { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null);
    await trigger.click();
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(files);
      return;
    }
    if (attempt >= 4) throw new Error('filechooser never opened (5 swallowed clicks)');
  }
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke attach → cards → preview → download split → editor-sourced block → delete + History', async ({
  page,
}) => {
  const fx = await seedAttachmentsFixture(page, 'e2e-attachments-pm@example.com');
  await serveMockBlobHost(page);
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Attached task', level: 1 })).toBeVisible();

  // The panel starts inviting-empty.
  await expect(page.getByText('No attachments yet — attach a file or drop one here')).toBeVisible();

  // ── 1. Attach an image + a zip via the Attach button (one multi-pick) ────
  await pickFiles(page, page.getByRole('button', { name: 'Attach', exact: true }), [
    { name: 'shot.png', mimeType: 'image/png', buffer: PNG_BYTES },
    { name: 'archive.zip', mimeType: 'application/zip', buffer: ZIP_BYTES },
  ]);
  const list = fileList(page);
  // The activation split IS the card grammar: previewable types are labelled
  // Preview (the image card carries the thumbnail), the rest Download (glyph).
  // A non-previewable card carries the label TWICE — the activation button
  // (DOM-first) and the hover download icon — so pin .first() for activation.
  const imageCard = list.getByRole('button', { name: 'Preview shot.png' });
  const zipCard = list.getByRole('button', { name: 'Download archive.zip' }).first();
  await expect(imageCard).toBeVisible();
  await expect(zipCard).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // ── 2. Drag-drop a PDF onto the panel (the dropzone enhancement) ─────────
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'spec.pdf', {
        type: 'application/pdf',
      }),
    );
    const target = document.querySelector('ul[aria-label="Attachments"]')!;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(list.getByRole('button', { name: 'Preview spec.pdf' })).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(3);

  // ── 3. The image card opens the lightbox; Esc closes + returns focus ─────
  await imageCard.click();
  const lightbox = page.getByRole('dialog', { name: 'shot.png' });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole('img', { name: 'shot.png' })).toBeVisible();
  await expect(lightbox.getByRole('button', { name: 'Download' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  // NOT asserted: focus returning to the opening card. Under the E2E dev
  // server EVERY Radix modal (the create-issue modal included) lands focus on
  // <body> after Esc — StrictMode's double-mount corrupts FocusScope's stored
  // return target — so the contract isn't assertable here either way; logged
  // as a PRODECT_FINDINGS entry to verify against a production build.

  // ── 4. The zip card DOWNLOADS — no modal (the Jira-verified split) ───────
  const downloadPromise = page.waitForEvent('download');
  await zipCard.click();
  // The store URL carries the addRandomSuffix infix, and `anchor.download`
  // is ignored cross-origin — the suggested name is the suffixed store name.
  expect((await downloadPromise).suggestedFilename()).toMatch(/^archive.*\.zip$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // ── 5. An editor upload surfaces in the panel as Embedded, delete blocked ─
  await page.goto(`/issues/${fx.issue.identifier}/edit`);
  await expect(page.locator('.ProseMirror').first()).toBeVisible();
  // The Description editor leads the form — its toolbar's Attach file.
  await pickFiles(page, page.getByRole('button', { name: 'Attach file' }).first(), [
    { name: 'embed.png', mimeType: 'image/png', buffer: PNG_BYTES },
  ]);
  // The embed lands in the editing surface once the upload round-trips.
  await expect(page.locator('.ProseMirror img')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // The edit form stays put on success (toast + refresh) — wait for the save
  // to land, then return to the detail page.
  await expect(page.getByText(`${fx.issue.identifier} saved`, { exact: true })).toBeVisible();
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Attached task', level: 1 })).toBeVisible();
  const embedCard = fileList(page).getByRole('listitem').filter({ hasText: 'embed.png' });
  await expect(embedCard.getByText('Embedded')).toBeVisible();
  await embedCard.hover();
  // Disabled-with-tooltip, not omitted: the points-at-source block.
  const blockedDelete = embedCard.getByRole('button', {
    name: 'Delete embed.png — unavailable, added in the editor',
  });
  await expect(blockedDelete).toHaveAttribute('aria-disabled', 'true');

  // ── 6. Delete the zip: the confirm states the hard-delete truth ──────────
  const zipRow = fileList(page).getByRole('listitem').filter({ hasText: 'archive.zip' });
  await zipRow.hover();
  await zipRow.getByRole('button', { name: 'Delete archive.zip' }).click();
  await expect(page.getByText("Delete archive.zip? Attachments can't be restored.")).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(fileList(page).getByText('archive.zip')).toHaveCount(0);
  await expect(fileList(page).getByRole('listitem')).toHaveCount(3); // png + pdf + embed

  // …and the History trail recorded the removal (uniform across entry paths).
  const revisions = await db.workItemRevision.findMany({ where: { workItemId: fx.issue.id } });
  const removedCells = revisions
    .map((rev) => (rev.diff as { attachments?: { removed?: { name: string }[] } }).attachments)
    .filter((cell) => cell?.removed)
    .flatMap((cell) => cell!.removed!);
  expect(removedCells.map((item) => item.name)).toEqual(['archive.zip']);
});

test('at scale the read stays cursor-paged: 50 + "Show more", view toggle without refetch (finding #57)', async ({
  page,
}) => {
  const fx = await seedAttachmentsFixture(page, 'e2e-attachments-scale@example.com');
  await seedScaleAttachments(fx, 120);
  await serveMockBlobHost(page);

  // Track every attachments-API response; none may carry more than the page
  // size (the unbounded-read guard). The first 50 are server-rendered, so
  // network reads only happen when the window extends.
  const pageSizes: number[] = [];
  page.on('response', (res) => {
    if (!/\/api\/work-items\/[^/]+\/attachments/.test(res.url())) return;
    void res
      .json()
      .then((body: { attachments?: unknown[] }) => {
        if (Array.isArray(body.attachments)) pageSizes.push(body.attachments.length);
      })
      .catch(() => {});
  });

  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Attached task', level: 1 })).toBeVisible();

  // First paint: the newest 50, the rest behind "Show more (70)" — never in
  // the DOM.
  const list = fileList(page);
  await expect(list.getByRole('listitem')).toHaveCount(50);
  await expect(list.getByText('file-120.txt')).toBeVisible();
  await expect(list.getByText('file-71.txt')).toBeVisible();
  await expect(list.getByText('file-70.txt')).toHaveCount(0);

  // Extend one cursor page.
  await page.getByRole('button', { name: 'Show more (70)' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(100);
  await expect(list.getByText('file-21.txt')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more (20)' })).toBeVisible();

  // The strip/list toggle re-presents the loaded window without refetching.
  const fetchesBeforeToggle = pageSizes.length;
  await page
    .getByRole('group', { name: 'Attachments view' })
    .getByRole('button', { name: 'List' })
    .click();
  await expect(list.getByRole('listitem')).toHaveCount(100);
  expect(pageSizes.length).toBe(fetchesBeforeToggle);

  // Every network read stayed within the page size.
  expect(pageSizes.length).toBeGreaterThan(0);
  expect(Math.max(...pageSizes)).toBeLessThanOrEqual(50);
});

test('role pass: a member deletes OWN only; a viewer gets the read-only panel', async ({
  page,
}) => {
  const fx = await seedAttachmentsFixture(page, 'e2e-attachments-roles-pm@example.com');
  await seedPanelAttachment(fx, fx.pm.id, 'pm-file.txt');
  const memberEmail = 'e2e-attachments-member@example.com';
  const viewerEmail = 'e2e-attachments-viewer@example.com';
  await seedMember(fx, memberEmail);
  await seedViewer(fx, viewerEmail);
  await serveMockBlobHost(page);

  // ── The plain member: uploads, deletes own, can't delete the PM's ────────
  await page.context().clearCookies();
  await signIn(page, memberEmail, ATTACHMENTS_PASSWORD);
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Attached task', level: 1 })).toBeVisible();

  await pickFiles(page, page.getByRole('button', { name: 'Attach', exact: true }), [
    { name: 'mine.png', mimeType: 'image/png', buffer: PNG_BYTES },
  ]);
  const list = fileList(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // Own card: the delete affordance exists. The PM's: OMITTED, never
  // disabled (the 5.1 role grammar) — while download stays for everyone.
  const mine = list.getByRole('listitem').filter({ hasText: 'mine.png' });
  await mine.hover();
  await expect(mine.getByRole('button', { name: 'Delete mine.png' })).toBeVisible();
  const pmFile = list.getByRole('listitem').filter({ hasText: 'pm-file.txt' });
  await pmFile.hover();
  // Two Download affordances per non-previewable card (activation + icon);
  // the delete control is what the role gates.
  await expect(pmFile.getByRole('button', { name: 'Download pm-file.txt' })).toHaveCount(2);
  await expect(pmFile.getByRole('button', { name: 'Delete pm-file.txt' })).toHaveCount(0);

  // Deleting own goes through.
  await mine.hover();
  await mine.getByRole('button', { name: 'Delete mine.png' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(list.getByText('mine.png')).toHaveCount(0);

  // ── The viewer: panel visible, zero write affordances ────────────────────
  await page.context().clearCookies();
  await signIn(page, viewerEmail, ATTACHMENTS_PASSWORD);
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Attached task', level: 1 })).toBeVisible();

  const viewerList = fileList(page);
  await expect(viewerList.getByText('pm-file.txt')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
  const row = viewerList.getByRole('listitem').filter({ hasText: 'pm-file.txt' });
  await row.hover();
  await expect(row.getByRole('button', { name: 'Download pm-file.txt' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
});
