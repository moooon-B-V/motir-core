// E2E: Work-item PROVENANCE on the detail (Story MOTIR-1685 · Subtask MOTIR-1695)
// — the story's end-to-end user flow.
//
// ⚠️ IT RUNS IN THE MAIN LANE, and this header said otherwise for as long as the
// file has existed (corrected by MOTIR-4751). It claimed to run under
// `playwright.acceptance.config.ts`, whose `testMatch` is
// `**/acceptance*.spec.ts` — a glob this filename has never matched — while
// importing `_helpers/acceptance-video`. So it ran in the BULK lane WITH the
// recording apparatus: four `CHAPTER_HOLD_MS` holds (~10 s of its recorded
// 15.2 s in `shard-plan.ts`, worth re-measuring from the first green artifact
// after this change), three sidecars nothing reads, and an
// `acceptanceStory('MOTIR-1685')` declaring a story it could not publish to.
// The import is now the promoted shim, which is what a spec outside the lane
// takes; every assertion below is unchanged, and no receipt is lost because
// none was ever produced here. `tests/e2e-acceptance-lane-imports.test.ts` is
// the guard that now fails this mistake in either direction.
//
// The flow proves the four planning/implementation states render on the collapsed
// Provenance disclosure (MOTIR-1693):
//   • MANUAL planning — created live through the UI create modal → "Manual".
//   • MCP planning — a seeded MCP-created item → "MCP" + reported harness/model.
//   • NATIVE planning — a seeded native item → "Native · Motir", the model HIDDEN
//     (recorded server-side, stripped from the read DTO — MOTIR-1691/1687).
//   • IMPLEMENTATION — "—" for an un-executed item; after a BYOK self-report via
//     mark_integrated, the implementation triple (BYOK + harness + model) appears.
//
// Setup mirrors work-item-type / epic2-acceptance: sign up through the real UI
// (auto-workspace → /home), seed the project + pin it active SERVER-SIDE via
// projectsService, then seed the non-UI provenance items directly through
// workItemsService (the one sanctioned cross-layer reach for tests) and drive the
// manual create + every assertion through the real shell. Every persisted-state
// assertion waits on the AUTHORITATIVE signal — the modal-unmount on create, the
// committed detail read after goto — never a waitForTimeout (the CLAUDE.md E2E
// discipline). Selector note: the disclosure toggle's accessible name is
// "Provenance"; the source chip text ("Manual" / "MCP" / "Native" / "BYOK") is the
// label alone (the glyph is aria-hidden); "Planning" / "Implementation" are the
// FieldCard labels — all matched within the expanded section.

import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('MOTIR-1685: provenance on the work-item detail — manual · mcp · native (model hidden) · byok implementation', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1685');

  // ── Setup: real sign-up → seed + pin an active project ──────────────────────
  await signUp(page, 'e2e-provenance@example.com');
  const user = await db.user.findFirstOrThrow({ where: { email: 'e2e-provenance@example.com' } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: "e2e-provenance's Workspace" } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Provenance',
    identifier: 'PRV',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.id };

  /** Open a work item's detail, expand the Provenance disclosure, return the
   *  expanded section locator (scopes the source/harness/model assertions). */
  async function openProvenance(identifier: string) {
    await page.goto(`/items/${identifier}`);
    const toggle = page.getByRole('button', { name: 'Provenance' });
    // First /items/[id] hit compiles the route under `next dev` — cold headroom.
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    expect(await toggle.getAttribute('aria-expanded')).toBe('false'); // collapsed by default
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    return page;
  }

  await chapter('Create a work item in the UI → planning provenance reads Manual', async () => {
    await page.goto('/items');
    await page.getByRole('button', { name: 'Create work item' }).click();
    await page.getByLabel('Title').fill('A hand-made item');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    // The modal's Create button unmounts on the 2xx create — the deterministic signal.
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeHidden();

    const items = (await (
      await page.request.get(`/api/_test/work-items?projectId=${project.id}`)
    ).json()) as Array<{ id: string; identifier: string; title: string }>;
    const manual = items.find((i) => i.title === 'A hand-made item')!;
    expect(manual, 'the manual item is listed').toBeTruthy();

    await openProvenance(manual.identifier);
    // Planning = Manual (a human via the UI); Implementation = "—" (never executed).
    await expect(page.getByText('Planning', { exact: true })).toBeVisible();
    await expect(page.getByText('Manual', { exact: true })).toBeVisible();
    await expect(page.getByText('Implementation', { exact: true })).toBeVisible();
    // "—" appears in many places on the detail page — scope to the
    // Implementation FieldCard by navigating up from its label.
    const implCard = page.getByText('Implementation', { exact: true }).locator('..').locator('..');
    await expect(implCard.getByText('—')).toBeVisible();
  });

  await chapter('An MCP-created item shows MCP + the reported harness/model', async () => {
    const mcp = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'task',
        title: 'An agent-planned item',
        provenance: {
          planning: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-4-8' },
        },
      },
      ctx,
    );
    await openProvenance(mcp.identifier);
    await expect(page.getByText('MCP', { exact: true })).toBeVisible();
    await expect(page.getByText('Claude Code', { exact: true })).toBeVisible();
    await expect(page.getByText('claude-opus-4-8', { exact: true })).toBeVisible();
  });

  await chapter('A native item shows Native · Motir — the model is HIDDEN', async () => {
    const native = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'task',
        title: 'A natively-planned item',
        provenance: {
          // The model is recorded on the row but the read DTO strips it for native.
          planning: { source: 'native', harness: 'Motir', model: 'deepseek-chat' },
        },
      },
      ctx,
    );
    await openProvenance(native.identifier);
    await expect(page.getByText('Native', { exact: true })).toBeVisible();
    await expect(page.getByText('Motir', { exact: true })).toBeVisible();
    // Motir abstracts its own model — the native model is never exposed.
    await expect(page.getByText('deepseek-chat')).toHaveCount(0);
  });

  await chapter('A BYOK self-report at integration shows the implementation triple', async () => {
    const built = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'A BYOK-built item' },
      ctx,
    );
    // Move to in_progress so mark_integrated's → `implemented` transition is legal.
    await workItemsService.updateStatus(built.id, 'in_progress', ctx);
    await workItemsService.markIntegrated(built.id, 'session/PRV-run', ctx, {
      source: 'byok',
      harness: 'opencode',
      model: 'deepseek',
    });
    await openProvenance(built.identifier);
    await expect(page.getByText('Implementation', { exact: true })).toBeVisible();
    await expect(page.getByText('BYOK', { exact: true })).toBeVisible();
    await expect(page.getByText('opencode', { exact: true })).toBeVisible();
    await expect(page.getByText('deepseek', { exact: true })).toBeVisible();
  });
});
