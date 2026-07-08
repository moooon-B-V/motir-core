// Accessibility audit — the POPULATED issue surfaces (Subtasks 2.5.6, 5.1.7,
// 5.5.5, 5.2.8 — the Epic-2-7 a11y closers extending the shell sweep).
//
// Split out of shell-a11y.spec.ts so Playwright's file-level sharding spreads
// the axe sweeps across CI legs. These are the HEAVY a11y specs: each seeds a
// real fixture server-side through the services (the sanctioned test
// cross-layer reach) so the swept DOM is exactly what Motir renders — the
// populated /items tree+list, a mention-bearing comment thread, the activity
// history, and the attachments panel + lightbox.
//
// Companion files: shell-a11y.spec.ts (shell routes + core CRUD + aria) and
// shell-a11y-tokens.spec.ts (public /tokens specimens). Shared axe helpers in
// _helpers/a11y.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { WCAG_TAGS, formatViolations, type AxeViolation } from './_helpers/a11y';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';

// Each test signs up a fresh user, seeds a fixture, then runs several axe
// sweeps — heavier than the 30s default. Raise the ceiling so a cold-compiled
// route or a slow argon2 sign-up doesn't time out.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The POPULATED /items route — BOTH views (Subtask 2.5.6). The empty /items
// is already in the SHELL_ROUTES sweep (shell-a11y.spec.ts); this seeds a real
// multi-level tree (so the treegrid carries nested rows with aria-level/expanded
// + status Pills + the inline-edit cell controls) and sweeps the Tree AND the
// flat sortable List. STRICT — zero exclusions, color-contrast ENABLED: the
// treegrid semantics (2.5.2) + the List's sortable-header `aria-sort` (2.5.8)
// + the AA-safe Pills (#35) must all hold on the REAL route, not just the
// /tokens specimen. Seeds server-side through workItemsService (the sanctioned
// test cross-layer reach) so the fixture is exactly what Motir renders.
async function seedIssueTree(page: Page, email: string) {
  await signUp(page, email);
  await createFirstProject(page, 'Mobile App');
  const local = email.split('@')[0]!;
  const user = (await db.user.findFirst({ where: { email } }))!;
  const ws = (await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } }))!;
  const project = (await db.project.findFirst({ where: { workspaceId: ws.id } }))!;
  const ctx = { userId: user.id, workspaceId: ws.id };
  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'Platform epic' },
    ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Auth story', parentId: epic.id },
    ctx,
  );
  // A second root with a non-default status + an assignee so the swept DOM
  // carries a colored status Pill + an assignee avatar (the palette tones, not
  // just grey) alongside the default-status rows.
  const task = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Ship the build', assigneeId: user.id },
    ctx,
  );
  await workItemsService.updateStatus(task.id, 'in_progress', ctx);
  return { epic, story };
}

test.describe('@a11y populated issue surfaces', () => {
  test('the populated /items TREE view is axe-clean (WCAG 2.1 AA; strict)', async ({ page }) => {
    const { epic, story } = await seedIssueTree(page, 'e2e-issues-tree-a11y@example.com');

    await page.goto('/items');
    const grid = page.getByRole('treegrid', { name: 'Work Items', exact: true });
    await expect(grid).toBeVisible();
    // Expand a node so a NESTED level (aria-level 2 row + its gridcells + the
    // collapse control) is part of the swept DOM, not just the roots. Use the
    // treegrid keyboard model (ArrowRight on the focused row) — robust vs a
    // coordinate click on the chevron among same-row z-10 inline-edit controls.
    await page.getByTestId(`issue-row-${epic.identifier}`).press('ArrowRight');
    await expect(page.getByTestId(`issue-row-${story.identifier}`)).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations('/items (tree, populated)', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  test('the populated /items LIST view is axe-clean (WCAG 2.1 AA; strict)', async ({ page }) => {
    await seedIssueTree(page, 'e2e-issues-list-a11y@example.com');

    await page.goto('/items?view=list');
    await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
    // The sortable headers carry aria-sort and the inline-edit cell triggers
    // (labelled buttons) are present — all held to full AA here.
    await expect(page.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
      'aria-sort',
      'none',
    );

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations('/items (list, populated)', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The issue detail route with a POPULATED, mention-bearing comment thread
  // (Subtask 5.1.7 — the Story-5.1 a11y closer, extending the 2.4.6 sweeps).
  // Seeds the comments surface into its real states server-side (the
  // sanctioned test cross-layer reach): a root with a rendered mention CHIP
  // (its tint background + strong text is the AA cell finding #35 settled),
  // an "Edited" tag, and enough replies that the "Show N more replies"
  // collapse affordance renders. Three swept states:
  //   1. the populated thread, composer at REST — STRICT, zero exclusions
  //      (no third-party editor in the DOM at rest);
  //   2. the delete-confirm popover OPEN (the reply-count-naming confirm) —
  //      scoped to the popover dialog itself (the /tokens Pill-matrix
  //      `.include()` precedent): sweep 1 already held the page beneath to
  //      AA, and axe cannot resolve the background of elements the floating
  //      panel geometrically overlaps (it reports them as color-contrast
  //      violations rather than incompletes), so the page-wide re-sweep
  //      would only re-test what sweep 1 proved, with overlap artifacts;
  //   3. the composer EXPANDED with the @mention picker OPEN (the
  //      aria-activedescendant listbox the keyboard path drives) — only the
  //      third-party `.ProseMirror` contenteditable excluded, same basis as
  //      the create/edit sweeps above.
  test('the issue detail route is axe-clean with a populated comment thread + mention picker (WCAG 2.1 AA)', async ({
    page,
  }) => {
    const email = 'e2e-comments-a11y@example.com';
    await signUp(page, email);
    await createFirstProject(page, 'Mobile App');

    const user = (await db.user.findFirst({ where: { email } }))!;
    const local = email.split('@')[0]!;
    const ws = (await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } }))!;
    const project = (await db.project.findFirst({ where: { workspaceId: ws.id } }))!;
    const ctx = { userId: user.id, workspaceId: ws.id };
    // A second member so the thread carries a real mention chip and the
    // picker has a non-self candidate.
    const bo = await usersService.createUser({
      email: 'e2e-comments-a11y-bo@example.com',
      password: 'comments-a11y-pass-123',
      name: 'Bo Philips',
    });
    await workspacesService.addMember({ userId: bo.id, workspaceId: ws.id });
    const issue = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Commented task' },
      ctx,
    );
    // The thread: a mention-bearing, edited root + 5 replies (over the
    // collapse threshold, so "Show N more replies" is in the swept DOM).
    const base = Date.now() - 60_000;
    const root = await db.comment.create({
      data: {
        workspaceId: ws.id,
        workItemId: issue.id,
        authorId: user.id,
        bodyMd: `Looping in [@Bo Philips](mention:${bo.id}) on this.`,
        editedAt: new Date(base + 30_000),
        createdAt: new Date(base),
      },
    });
    await db.comment.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        workspaceId: ws.id,
        workItemId: issue.id,
        authorId: i % 2 === 0 ? bo.id : user.id,
        parentCommentId: root.id,
        bodyMd: `reply ${i + 1}`,
        createdAt: new Date(base + (i + 1) * 1000),
      })),
    });

    await page.goto(`/items/${issue.identifier}`);
    await expect(page.getByRole('heading', { name: 'Commented task', level: 1 })).toBeVisible();
    const list = page.getByRole('list', { name: 'Comments' });
    await expect(list.locator('.mention-chip')).toBeVisible();
    await expect(list.getByText('· Edited')).toBeVisible();
    await expect(list.getByRole('button', { name: 'Show 4 more replies' })).toBeVisible();

    // 1. Populated thread, composer at rest — strict, zero exclusions.
    const threadResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      threadResults.violations,
      formatViolations('/items/[key] (comment thread)', threadResults.violations as AxeViolation[]),
    ).toEqual([]);

    // 2. The delete-confirm popover open — scoped to the dialog (see above).
    await list.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await expect(page.getByRole('dialog').getByText(/Also deletes 5 replies/)).toBeVisible();
    const confirmResults = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include('[role="dialog"]')
      .analyze();
    expect(
      confirmResults.violations,
      formatViolations(
        '/items/[key] (delete-comment confirm)',
        confirmResults.violations as AxeViolation[],
      ),
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // 3. Composer expanded, mention picker open — third-party editor excluded.
    await page.getByRole('button', { name: 'Add a comment…' }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('@Bo');
    await expect(page.getByRole('listbox', { name: /^Mention a/ })).toBeVisible();
    const pickerResults = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.ProseMirror')
      .analyze();
    expect(
      pickerResults.violations,
      formatViolations(
        '/items/[key] (mention picker open)',
        pickerResults.violations as AxeViolation[],
      ),
    ).toEqual([]);
  });

  // The issue detail route's POPULATED Activity History + All tabs (Subtask
  // 5.5.5 — the Story-5.5 a11y closer, extending the 5.1.7 sweep above).
  // Seeds a history covering the varied row grammars (scalar struck/emphasised
  // values, the status Pill pair, a user form, a link identifier, an
  // attachment chip, a comment-deletion gloss, a generic fallback) plus one
  // live comment so the All tab interleaves both grammars. Both states are
  // swept STRICT with zero exclusions: the History tab is read-only (no
  // third-party editor anywhere), and on the All tab the composer sits at
  // REST (no `.ProseMirror` in the DOM).
  test('the issue detail Activity History + All tabs are axe-clean populated (WCAG 2.1 AA; strict)', async ({
    page,
  }) => {
    const email = 'e2e-activity-a11y@example.com';
    await signUp(page, email);
    await createFirstProject(page, 'Mobile App');

    const user = (await db.user.findFirst({ where: { email } }))!;
    const local = email.split('@')[0]!;
    const ws = (await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } }))!;
    const project = (await db.project.findFirst({ where: { workspaceId: ws.id } }))!;
    const ctx = { userId: user.id, workspaceId: ws.id };
    const issue = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Audited task' },
      ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Linked blocker' },
      ctx,
    );
    // Real-path history: a scalar+user+date edit, a workflow transition and
    // a link add (the forms with Pills / avatars / mono identifiers).
    await workItemsService.updateWorkItem(
      issue.id,
      { priority: 'high', assigneeId: user.id, dueDate: '2026-07-01T00:00:00.000Z' },
      ctx,
    );
    await workItemsService.updateStatus(issue.id, 'in_progress', ctx);
    await workItemsService.linkWorkItems(
      { fromId: issue.id, toId: blocker.id, kind: 'is_blocked_by' },
      ctx,
    );
    // Injected rows for the remaining grammars (attachment chip, the
    // comment-deletion gloss, the designed generic-fallback state).
    await db.workItemRevision.create({
      data: {
        workItemId: issue.id,
        changedById: user.id,
        changeKind: 'updated',
        diff: {
          attachments: { added: [{ attachmentId: 'att_a11y', name: 'spec.pdf', source: 'panel' }] },
        },
      },
    });
    await db.workItemRevision.create({
      data: {
        workItemId: issue.id,
        changedById: user.id,
        changeKind: 'comment_deleted',
        diff: {
          comment: { from: { commentId: 'cm_a11y', authorId: user.id, replyCount: 2 }, to: null },
        },
      },
    });
    await db.workItemRevision.create({
      data: {
        workItemId: issue.id,
        changedById: user.id,
        changeKind: 'updated',
        diff: { riskScore: { from: 3, to: 7 } },
      },
    });
    // One live comment so the All tab interleaves both grammars.
    await db.comment.create({
      data: {
        workspaceId: ws.id,
        workItemId: issue.id,
        authorId: user.id,
        bodyMd: 'a live comment among the history rows',
      },
    });

    // 1. The History tab, populated — strict, zero exclusions.
    await page.goto(`/items/${issue.identifier}?activity=history`);
    await expect(page.getByRole('heading', { name: 'Audited task', level: 1 })).toBeVisible();
    const history = page.getByRole('list', { name: 'History' });
    await expect(history).toBeVisible();
    await expect(history.getByText(/created the work item/)).toBeVisible();
    await expect(history.getByText(/deleted a comment/)).toBeVisible();

    const historyResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      historyResults.violations,
      formatViolations(
        '/items/[key]?activity=history (populated)',
        historyResults.violations as AxeViolation[],
      ),
    ).toEqual([]);

    // 2. The All tab, interleaved, composer at rest — strict, zero exclusions.
    await page.goto(`/items/${issue.identifier}?activity=all`);
    const all = page.getByRole('list', { name: 'All activity' });
    await expect(all).toBeVisible();
    await expect(all.getByText('a live comment among the history rows')).toBeVisible();
    await expect(all.getByText(/created the work item/)).toBeVisible();

    const allResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      allResults.violations,
      formatViolations(
        '/items/[key]?activity=all (populated)',
        allResults.violations as AxeViolation[],
      ),
    ).toEqual([]);
  });

  // The issue detail route with a POPULATED attachments panel + the open
  // preview lightbox (Subtask 5.2.8 — the Story-5.2 a11y closer, extending
  // the 2.4.6/5.1.7 sweeps). Seeds the panel's real states server-side: an
  // image card (the thumbnail/preview path), a non-previewable file (the
  // glyph/download path), and an EDITOR-sourced row (the Embedded chip +
  // disabled delete — the disabled control still needs an accessible name).
  // Two swept states:
  //   1. the populated panel, strip view — STRICT, zero exclusions (no
  //      third-party editor in the detail DOM);
  //   2. the preview lightbox OPEN — scoped to the dialog itself (the 5.1.7
  //      delete-confirm precedent: sweep 1 already held the page beneath to
  //      AA, and axe mis-resolves the background of elements the full-screen
  //      scrim geometrically overlaps, reporting them as color-contrast
  //      violations rather than incompletes). The dialog is labelled by the
  //      filename (srTitle), the image carries the filename as alt, and the
  //      white-on-scrim header controls are real labelled buttons.
  // The blob host is fulfilled with a tiny PNG so the lightbox audits a
  // loaded image, not a broken one (the URLs are the test-blob-mock shape;
  // nothing leaves localhost).
  test('the issue detail route is axe-clean with a populated attachments panel + open lightbox (WCAG 2.1 AA)', async ({
    page,
  }) => {
    const email = 'e2e-attachments-a11y@example.com';
    await signUp(page, email);
    await createFirstProject(page, 'Mobile App');

    const user = (await db.user.findFirst({ where: { email } }))!;
    const local = email.split('@')[0]!;
    const ws = (await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } }))!;
    const project = (await db.project.findFirst({ where: { workspaceId: ws.id } }))!;
    const issue = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Attached task' },
      { userId: user.id, workspaceId: ws.id },
    );
    const blobHost = 'https://e2etest.public.blob.vercel-storage.com';
    await db.attachment.createMany({
      data: [
        { originalFilename: 'shot.png', mimeType: 'image/png', source: 'panel' as const },
        { originalFilename: 'archive.zip', mimeType: 'application/zip', source: 'panel' as const },
        { originalFilename: 'embed.png', mimeType: 'image/png', source: 'editor' as const },
      ].map((row, i) => ({
        ...row,
        workspaceId: ws.id,
        workItemId: issue.id,
        uploaderUserId: user.id,
        blobPathname: `${blobHost}/a11y/${row.originalFilename}`,
        sizeBytes: 64,
        createdAt: new Date(Date.now() - (3 - i) * 1000),
      })),
    });
    await page.route('**/*.public.blob.vercel-storage.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5CYII=',
          'base64',
        ),
      }),
    );

    await page.goto(`/items/${issue.identifier}`);
    await expect(page.getByRole('heading', { name: 'Attached task', level: 1 })).toBeVisible();
    const list = page.getByRole('list', { name: 'Attachments' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByText('Embedded')).toBeVisible();

    // 1. Populated panel — strict, zero exclusions.
    const panelResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      panelResults.violations,
      formatViolations(
        '/items/[key] (attachments panel)',
        panelResults.violations as AxeViolation[],
      ),
    ).toEqual([]);

    // 2. The preview lightbox open — scoped to the dialog (see above).
    await list.getByRole('button', { name: 'Preview shot.png' }).click();
    const lightbox = page.getByRole('dialog', { name: 'shot.png' });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('img', { name: 'shot.png' })).toBeVisible();
    const lightboxResults = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include('[role="dialog"]')
      .analyze();
    expect(
      lightboxResults.violations,
      formatViolations(
        '/items/[key] (attachment lightbox)',
        lightboxResults.violations as AxeViolation[],
      ),
    ).toEqual([]);
  });
});
