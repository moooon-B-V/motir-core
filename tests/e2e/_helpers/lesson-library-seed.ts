import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';

// Seed for the LESSON LIBRARY E2E (Story MOTIR-3329 · Subtask MOTIR-3340).
//
// ⚠️ The PEOPLE are seeded here; the LESSONS are not, and cannot be. A lesson
// lives in motir-ai's own database, on the other side of the 7.1 boundary —
// motir-core has no table for one. So the library's content comes from the
// boundary fixture (`lib/test-lessons-mock`) and this seeds only what motir-core
// owns: a private project, an admin who holds `lesson:view`, and a member who
// does not.
//
// A `private` project on purpose: on an open project every workspace member can
// browse, and the non-admin step — the one that proves the door is not merely
// hidden — would be unfalsifiable.

export const LESSON_E2E_PASSWORD = 'lesson-library-e2e-pass-7';

export interface LessonLibrarySeed {
  adminEmail: string;
  /** A project MEMBER: browses the project, holds no `lesson:view`. */
  memberEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

export async function seedLessonLibrary(prefix: string): Promise<LessonLibrarySeed> {
  const owner = await usersService.createUser({
    email: `${prefix}-owner@example.com`,
    password: LESSON_E2E_PASSWORD,
    name: 'Lesson Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Lesson E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Lesson E2E Project',
    identifier: 'LLE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };

  // `private` FIRST — going private auto-enrols the workspace members that exist
  // at that moment, and right now that is only the owner. Both actors below are
  // created after, so each one's membership is exactly the role we give it.
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });

  async function actor(role: 'admin' | 'member'): Promise<string> {
    const email = `${prefix}-${role}@example.com`;
    const user = await usersService.createUser({
      email,
      password: LESSON_E2E_PASSWORD,
      name: role,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    return email;
  }

  return {
    adminEmail: await actor('admin'),
    memberEmail: await actor('member'),
    password: LESSON_E2E_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}
