import type { Page } from '@playwright/test';
import { expect, test } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// THE MERGE SETTING A PERSON CAN FIND AND CHANGE — THE ACCEPTANCE RECEIPT
// (Story MOTIR-4880 · Subtask MOTIR-5183), walking
// `design/projects/approvals.mock.html` panels 6–8.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's complaint is that the setting existed and nobody could find it.
// So the receipt starts where a manager would look — Project settings, the
// Approvals room — reads the two modes in the reader's words, changes one, and
// shows it held. Then the three things that make it trustworthy rather than
// merely present: it lands from a deep link, it belongs to ONE project, and a
// failed save does not pretend it worked.
//
// The last chapter is the guard. The room is MANAGE-ONLY (Yue, 2026-09-13): a
// member who cannot manage the project is refused the route by the room's own
// guard, and the value is never rendered behind the refusal.
//
// ⚠️ Every write is waited on by its RESPONSE, armed before the click — never by
// the optimistic radio flipping (motir-core/CLAUDE.md, E2E discipline).

const PASSWORD = 'merge-mode-acceptance-pass-123';
const OWNER = 'merge-mode-owner@example.com';
const MEMBER = 'merge-mode-member@example.com';
const ROOM = '/settings/project/approvals';
const ASK = 'Ask before merging';
const AUTO = 'Merge automatically';

let workspaceId = '';
let ownerId = '';
let firstProjectId = '';
let secondProjectId = '';

test.beforeAll(async () => {
  await resetDatabase();
  const owner = await usersService.createUser({
    email: OWNER,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  ownerId = owner.id;
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  workspaceId = workspace.id;

  const first = await projectsService.createProject({
    name: 'Storefront',
    identifier: 'STORE',
    workspaceId,
    actorUserId: owner.id,
  });
  const second = await projectsService.createProject({
    name: 'Internal tools',
    identifier: 'TOOLS',
    workspaceId,
    actorUserId: owner.id,
  });
  firstProjectId = first.id;
  secondProjectId = second.id;
  // The second project already merges automatically, so the tier chapter has a
  // different value to show — set on the row, as a person's decision would be.
  await adminDb.project.update({
    where: { id: second.id },
    data: { prMergeMode: 'auto', prMergeModeDecidedAt: new Date() },
  });
  await pinActiveProject(owner.id, first.id);

  const member = await usersService.createUser({
    email: MEMBER,
    password: PASSWORD,
    name: 'Mia Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId });
  await adminDb.projectMembership.create({
    data: { userId: member.id, projectId: first.id, workspaceId, role: 'member' },
  });
  await pinActiveProject(member.id, first.id);
});

async function pinActiveProject(userId: string, projectId: string) {
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId } },
    data: { activeProjectId: projectId },
  });
}

const mergeGroup = (page: Page) => page.getByRole('radiogroup', { name: 'Merging pull requests' });
const option = (page: Page, label: string) =>
  mergeGroup(page).getByRole('radio', { name: new RegExp(label) });

/** Arm a wait for the merge-mode PATCH before the click that sends it. */
function mergeModeWrite(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.request().method() === 'PATCH' && new URL(res.url()).pathname.endsWith('/pr-merge-mode'),
  );
}

test('a manager finds the merge setting, changes it and it holds — and a member is refused the room', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4880');

  await chapter('Project settings → Approvals: the merge setting has a room', async () => {
    await signIn(page, OWNER, PASSWORD);
    await page.goto('/settings/project');
    await page.getByRole('link', { name: 'Approvals', exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`${ROOM}$`));
    await expect(page.getByRole('heading', { name: 'Merging pull requests' })).toBeVisible();
    await beat();
  });

  await chapter('Two modes, each saying what happens when checks pass', async () => {
    await expect(mergeGroup(page).getByRole('radio')).toHaveCount(2);
    await expect(option(page, ASK)).toContainText(
      'When its checks pass, a person approves the pull request in Motir before it is merged.',
    );
    await expect(option(page, AUTO)).toContainText(
      'When its checks pass, Motir merges the pull request without asking anyone.',
    );
    // `getByRole`, not a page-rooted `getByText`: the accessibility tree excludes a
    // streamed or outgoing subtree, so the notice cannot match twice (MOTIR-5037).
    await expect(
      page.getByRole('paragraph').filter({ hasText: /Motir does not merge pull requests yet/ }),
    ).toBeVisible();
    await expect(option(page, ASK)).toHaveAttribute('aria-checked', 'true');
    await beat();
  });

  await chapter(
    'Choosing “Merge automatically” saves in place, and holds after a reload',
    async () => {
      const write = mergeModeWrite(page);
      await option(page, AUTO).click();
      const res = await write;
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ prMergeMode: 'auto' });
      // Correct BEFORE any reload: the response is the confirmation.
      await expect(option(page, AUTO)).toHaveAttribute('aria-checked', 'true');
      await expect(option(page, ASK)).toHaveAttribute('aria-checked', 'false');
      await beat();

      await page.reload();
      await expect(option(page, AUTO)).toHaveAttribute('aria-checked', 'true');
      const stored = await adminDb.project.findUniqueOrThrow({ where: { id: firstProjectId } });
      expect(stored.prMergeMode).toBe('auto');
    },
  );

  await chapter('A deep link to #merge-mode lands on the setting', async () => {
    await page.goto('/dashboard');
    await page.goto(`${ROOM}#merge-mode`);
    await expect(page.locator('#merge-mode')).toBeFocused();
    await expect(page.locator('#merge-mode')).toBeInViewport();
    await beat();
  });

  await chapter('The setting belongs to the project: another project keeps its own', async () => {
    await pinActiveProject(ownerId, secondProjectId);
    await page.goto(ROOM);
    await expect(page.getByText('Internal tools').first()).toBeVisible();
    await expect(option(page, AUTO)).toHaveAttribute('aria-checked', 'true');

    const write = mergeModeWrite(page);
    await option(page, ASK).click();
    expect((await write).status()).toBe(200);
    await expect(option(page, ASK)).toHaveAttribute('aria-checked', 'true');

    const [first, second] = await Promise.all([
      adminDb.project.findUniqueOrThrow({ where: { id: firstProjectId } }),
      adminDb.project.findUniqueOrThrow({ where: { id: secondProjectId } }),
    ]);
    expect(second.prMergeMode).toBe('manual');
    expect(first.prMergeMode, 'the first project did not move').toBe('auto');
    await beat();
  });

  await chapter('A save that fails says so, and puts the stored value back', async () => {
    await page.route('**/api/projects/*/pr-merge-mode', (route) =>
      route.fulfill({ status: 500, json: { code: 'INTERNAL', error: 'boom' } }),
    );
    const write = mergeModeWrite(page);
    await option(page, AUTO).click();
    expect((await write).status()).toBe(500);
    await expect(page.getByText("Couldn't save — try again.").first()).toBeVisible();
    await expect(option(page, ASK)).toHaveAttribute('aria-checked', 'true');
    await expect(option(page, AUTO)).toHaveAttribute('aria-checked', 'false');
    await page.unroute('**/api/projects/*/pr-merge-mode');
    await beat();
  });

  await chapter(
    'A member without workflow:manage meets the room’s guard, and no value',
    async () => {
      // Same recording, a different reader: drop the manager's session.
      await page.context().clearCookies();
      await signIn(page, MEMBER, PASSWORD);
      const response = await page.goto(ROOM);
      expect(response?.status()).toBeLessThan(500);
      await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
      await expect(page.getByRole('radiogroup', { name: 'Merging pull requests' })).toHaveCount(0);
      await expect(page.getByText(AUTO)).toHaveCount(0);
      await expect(page.getByText(ASK)).toHaveCount(0);
      await beat();
    },
  );
});
