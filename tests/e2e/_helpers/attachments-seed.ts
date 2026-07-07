// E2E fixture for the Story-5.2 attachments specs (Subtask 5.2.8).
//
// Mirrors the comments-seed shape: the PM signs up through the real browser
// UI (shell-session signUp — the page needs a live session) and creates the
// first project via the dashboard CTA (which pins it active); then,
// server-side via the sanctioned test cross-layer reach, the issue under
// test plus any extra cast members (a plain workspace member, a read-only
// project viewer) are minted directly through the services.
//
// The AT-SCALE fixture (seedScaleAttachments) writes linked attachment rows
// straight through Prisma rather than the upload route: the surface under
// test is the cursor-paged READ + "Show more (N)" (finding #57), not the
// write path (the journey spec covers that over the real stack), and 120
// real uploads would burn the run for nothing. text/plain MIME keeps the
// strip cards on the glyph path (no thumbnail fetches for the browser to
// wait on); createdAt is spaced one second apart so the repository's
// newest-first cursor walk is deterministic.

import { expect, type Page } from '@playwright/test';
import { db } from './db-reset';
import { signUp, createFirstProject } from './shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectMembersService } from '@/lib/services/projectMembersService';

export const ATTACHMENTS_PASSWORD = 'attachments-e2e-pass-123';

/** The host suffix lib/test-blob-mock's synthetic URLs ride — the spec's
 * page.route fulfiller matches it so no browser request leaves localhost. */
export const MOCK_BLOB_HOST_GLOB = '**/*.public.blob.vercel-storage.com/**';

export interface AttachmentsFixture {
  pm: { id: string; name: string; email: string };
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  issue: { id: string; identifier: string };
}

/**
 * Browser sign-up for the PM + first project, then server-side: one task to
 * attach files to. Leaves the page signed in as the PM with the project
 * active.
 */
export async function seedAttachmentsFixture(
  page: Page,
  pmEmail: string,
): Promise<AttachmentsFixture> {
  await signUp(page, pmEmail);
  await createFirstProject(page, 'Mobile App');

  const local = pmEmail.split('@')[0]!;
  const pm = await db.user.findFirst({ where: { email: pmEmail } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(pm, 'PM user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await db.project.findFirst({ where: { workspaceId: ws!.id } });
  expect(project, 'first project exists').not.toBeNull();

  const issue = await workItemsService.createWorkItem(
    { projectId: project!.id, kind: 'task', title: 'Attached task' },
    { userId: pm!.id, workspaceId: ws!.id },
  );

  return {
    pm: { id: pm!.id, name: pm!.name, email: pmEmail },
    workspaceId: ws!.id,
    projectId: project!.id,
    projectIdentifier: project!.identifier,
    issue: { id: issue.id, identifier: issue.identifier },
  };
}

/** A plain workspace member (no project role) — uploads + deletes own only. */
export async function seedMember(
  fx: AttachmentsFixture,
  email: string,
  name = 'Plain Member',
): Promise<{ id: string }> {
  const member = await usersService.createUser({ email, password: ATTACHMENTS_PASSWORD, name });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: member.id, workspaceId: fx.workspaceId } },
    data: { activeProjectId: fx.projectId },
  });
  return { id: member.id };
}

/** A workspace member holding the read-only project `viewer` role. */
export async function seedViewer(fx: AttachmentsFixture, email: string): Promise<void> {
  const viewer = await usersService.createUser({
    email,
    password: ATTACHMENTS_PASSWORD,
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
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: fx.workspaceId } },
    data: { activeProjectId: fx.projectId },
  });
}

/** Insert one linked panel attachment directly (role-pass setup). */
export async function seedPanelAttachment(
  fx: AttachmentsFixture,
  uploaderUserId: string,
  filename: string,
): Promise<void> {
  await db.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: fx.issue.id,
      uploaderUserId,
      source: 'panel',
      blobPathname: `https://e2etest.public.blob.vercel-storage.com/seeded/${filename}`,
      mimeType: 'text/plain',
      sizeBytes: 8,
      originalFilename: filename,
    },
  });
}

/** The finding-#57 fixture: `count` linked panel rows, newest-first walkable. */
export async function seedScaleAttachments(fx: AttachmentsFixture, count: number): Promise<void> {
  const base = Date.now() - count * 1000;
  await db.attachment.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId: fx.workspaceId,
      workItemId: fx.issue.id,
      uploaderUserId: fx.pm.id,
      source: 'panel' as const,
      blobPathname: `https://e2etest.public.blob.vercel-storage.com/scale/file-${i + 1}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 16,
      originalFilename: `file-${i + 1}.txt`,
      createdAt: new Date(base + i * 1000),
    })),
  });
}
