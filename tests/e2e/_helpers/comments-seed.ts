// E2E fixture for the Story-5.1 comments specs (Subtask 5.1.7).
//
// Stands up the comment journey's cast + surface: the PM signs up through the
// real browser UI (shell-session signUp — the page needs a live session) and
// creates the first project via the dashboard CTA (which pins it active);
// then, server-side via the sanctioned test cross-layer reach, a second
// workspace member ("Bo Philips" — the mention target the Story verification
// recipe names) and the issue under comment are minted directly through the
// services, exactly the shape the Vitest scenario builds.
//
// The AT-SCALE fixture (seedScaleComments) writes root comments straight
// through Prisma (db.comment.createMany) rather than commentsService:
//   * the surface under test is the cursor-paged READ + "Show more comments"
//     UI, not the write path (the journey spec covers that over the real
//     stack), and 100+ service calls would burn ~10s per run;
//   * commentsService.addComment awaits the post-commit `sendEvent` — and
//     while the runner process IS Inngest-wired since Subtask 5.4.5
//     (INNGEST_DEV at playwright.config.ts module scope), 100+ service-level
//     writes would also publish 100+ pointless events for the dev server to
//     fan out mid-run.
// createdAt is spaced one second apart so the repository's
// `orderBy [{createdAt}, {id}]` walk is deterministic for the assertions.

import { expect, type Page } from '@playwright/test';
import { db } from './db-reset';
import { signUp, createFirstProject } from './shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectMembersService } from '@/lib/services/projectMembersService';

export const COMMENTS_PASSWORD = 'comments-e2e-pass-123';

export interface CommentsFixture {
  pm: { id: string; name: string; email: string };
  bo: { id: string; name: string; email: string };
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  issue: { id: string; identifier: string };
}

/**
 * Browser sign-up for the PM + first project, then server-side: Bo (a second
 * workspace member, the mention target) and one task to comment on. Leaves
 * the page signed in as the PM on /dashboard with the project active.
 */
export async function seedCommentsFixture(
  page: Page,
  pmEmail: string,
  boEmail: string,
): Promise<CommentsFixture> {
  await signUp(page, pmEmail);
  await createFirstProject(page, 'Mobile App');

  const local = pmEmail.split('@')[0]!;
  const pm = await db.user.findFirst({ where: { email: pmEmail } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(pm, 'PM user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await db.project.findFirst({ where: { workspaceId: ws!.id } });
  expect(project, 'first project exists').not.toBeNull();

  const bo = await usersService.createUser({
    email: boEmail,
    password: COMMENTS_PASSWORD,
    name: 'Bo Philips',
  });
  await workspacesService.addMember({ userId: bo.id, workspaceId: ws!.id });

  const ctx = { userId: pm!.id, workspaceId: ws!.id };
  const issue = await workItemsService.createWorkItem(
    { projectId: project!.id, kind: 'task', title: 'Commented task' },
    ctx,
  );

  return {
    pm: { id: pm!.id, name: pm!.name, email: pmEmail },
    bo: { id: bo.id, name: bo.name, email: boEmail },
    workspaceId: ws!.id,
    projectId: project!.id,
    projectIdentifier: project!.identifier,
    issue: { id: issue.id, identifier: issue.identifier },
  };
}

/**
 * Add a workspace member holding the read-only project `viewer` role, able
 * to sign in through the browser (the 6.4 role the read-only pass drives).
 */
export async function seedViewer(fx: CommentsFixture, email: string): Promise<void> {
  const viewer = await usersService.createUser({
    email,
    password: COMMENTS_PASSWORD,
    name: 'Read Only',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.pm.id,
    ctx: { userId: fx.pm.id, workspaceId: fx.workspaceId },
    targetUserId: viewer.id,
    role: 'viewer',
  });
  // Pin the project active for the viewer so the project-scoped shell (and
  // the /issues/[key] route's sidebar) resolves on first navigation.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: fx.workspaceId } },
    data: { activeProjectId: fx.projectId },
  });
}

/**
 * The finding-#57 fixture: `count` ROOT comments by the PM, bodies
 * `comment 1` … `comment <count>`, createdAt spaced 1s apart (oldest first)
 * so the cursor walk + sort flip are deterministic.
 */
export async function seedScaleComments(fx: CommentsFixture, count: number): Promise<void> {
  const base = Date.now() - count * 1000;
  await db.comment.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId: fx.workspaceId,
      workItemId: fx.issue.id,
      authorId: fx.pm.id,
      bodyMd: `comment ${i + 1}`,
      createdAt: new Date(base + i * 1000),
    })),
  });
}
