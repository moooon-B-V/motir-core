import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  SEED_TEST_PROJECT_IDENTIFIER,
  SEED_TEST_PROJECT_NAME,
  seedGenerationTestProject,
} from '@/scripts/plan-seed/testProject';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 7.4.10 · MOTIR-1426 — the AI-generation TEST-BED project the seed adds
// under the `moooon` workspace. Real Postgres (the seed-test convention). Pins the
// invariants the test bed depends on: it is onboarding-ready (`onboardingRanAt`
// null → `/onboarding` LOADS rather than redirecting to `/roadmap`), the team is
// enrolled (owner `admin` / rest `member`), it COEXISTS with the real project, and
// it does NOT steal the workspace's active-project pin (`motir` stays the landing
// project — testers switch via the project switcher).

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('seedGenerationTestProject (MOTIR-1426)', () => {
  it('creates an onboarding-ready test project, enrols the team, and leaves the active-project pin untouched', async () => {
    // An owner + a teammate, both workspace members (mirrors the moooon team).
    const owner = await usersService.createUser({
      email: 'owner@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const member = await usersService.createUser({
      email: 'member@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'moooon',
      ownerUserId: owner.id,
    });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: workspace.id,
      role: 'member',
    });

    // The real `motir` analogue: a first project, pinned active (as the seed pins it).
    const mainProject = await projectsService.createProject({
      name: 'motir',
      identifier: 'PROD',
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    await db.workspaceMembership.updateMany({
      where: { workspaceId: workspace.id },
      data: { activeProjectId: mainProject.id },
    });

    // The thing under test: the generation test bed.
    const testProject = await seedGenerationTestProject({
      workspaceId: workspace.id,
      ownerUserId: owner.id,
      memberUserIds: [owner.id, member.id],
    });

    // Onboarding-ready: never-onboarded → `/onboarding` LOADS (the gate redirects
    // to /roadmap only once a plan is approved), and it is a DISTINCT project.
    expect(testProject.identifier).toBe(SEED_TEST_PROJECT_IDENTIFIER);
    expect(testProject.onboardingRanAt).toBeNull();
    expect(testProject.id).not.toBe(mainProject.id);
    const persisted = await db.project.findUnique({ where: { id: testProject.id } });
    expect(persisted?.name).toBe(SEED_TEST_PROJECT_NAME);
    expect(persisted?.onboardingRanAt).toBeNull();

    // Team enrolled: owner → admin, teammate → member (the whole team can switch to it).
    const memberships = await db.projectMembership.findMany({
      where: { projectId: testProject.id },
    });
    const roleByUser = new Map(memberships.map((m) => [m.userId, m.role]));
    expect(memberships).toHaveLength(2);
    expect(roleByUser.get(owner.id)).toBe('admin');
    expect(roleByUser.get(member.id)).toBe('member');

    // The active-project pin is NOT stolen — `motir` stays every member's landing project.
    const pins = await db.workspaceMembership.findMany({ where: { workspaceId: workspace.id } });
    for (const pin of pins) expect(pin.activeProjectId).toBe(mainProject.id);
  });
});
