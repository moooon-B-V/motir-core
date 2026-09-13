import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import {
  InvalidPrMergeModeError,
  PermissionDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestProject, createTestUser, createTestWorkspace } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE READERS MOVE OFF `Workspace` — Story MOTIR-4880 · MOTIR-5179.
//
// Pinned here: the value rides the base `ProjectDTO`; the project-scoped read AND
// write both need `workflow:manage` (the room is manage-only — no read-only view);
// the write STAMPS the value decided; and two projects in ONE workspace hold different values — the
// tier move proved by behaviour, not by the schema.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function tenant() {
  const { workspace, owner } = await createTestWorkspace();
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  return { workspace, owner, project, ownerCtx };
}

describe('ProjectDTO.prMergeMode', () => {
  it('rides the base DTO a fresh project is created with, at the manual floor', async () => {
    const { project } = await tenant();
    expect(project.prMergeMode).toBe('manual');
  });

  it('maps whatever the row holds', async () => {
    const { project } = await tenant();
    const row = await adminDb.project.update({
      where: { id: project.id },
      data: { prMergeMode: 'review_on_fail' },
    });
    expect(toProjectDTO(row).prMergeMode).toBe('review_on_fail');
  });
});

describe('the project-scoped read and write', () => {
  it('a manager changes it, the change is stamped DECIDED, and the read returns it', async () => {
    const { project, ownerCtx } = await tenant();

    expect(await projectPrMergeModeService.setPrMergeMode(project.id, 'auto', ownerCtx)).toEqual({
      prMergeMode: 'auto',
    });
    expect(await projectPrMergeModeService.getPrMergeMode(project.id, ownerCtx)).toEqual({
      prMergeMode: 'auto',
    });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.prMergeModeDecidedAt).not.toBeNull();
  });

  it('two projects in ONE workspace hold different values, and each read returns its own', async () => {
    const { workspace, owner, project, ownerCtx } = await tenant();
    const second = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      identifier: 'SECOND',
    });

    await projectPrMergeModeService.setPrMergeMode(project.id, 'auto', ownerCtx);
    await projectPrMergeModeService.setPrMergeMode(second.id, 'manual', ownerCtx);

    expect((await projectPrMergeModeService.getPrMergeMode(project.id, ownerCtx)).prMergeMode).toBe(
      'auto',
    );
    expect((await projectPrMergeModeService.getPrMergeMode(second.id, ownerCtx)).prMergeMode).toBe(
      'manual',
    );
  });

  it('a member who may browse but not manage is refused the read AND the write', async () => {
    // There is no read-only view of this setting (Yue, 2026-09-13): the room is
    // guarded by `workflow:manage`, so the read is too.
    const { workspace, project, ownerCtx } = await tenant();
    await projectPrMergeModeService.setPrMergeMode(project.id, 'auto', ownerCtx);
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    const memberCtx = { userId: member.id, workspaceId: workspace.id };

    await expect(
      projectPrMergeModeService.getPrMergeMode(project.id, memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      projectPrMergeModeService.setPrMergeMode(project.id, 'manual', memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: project.id } })).prMergeMode,
    ).toBe('auto');
  });

  it('refuses a value outside the vocabulary before touching anything', async () => {
    const { project, ownerCtx } = await tenant();
    await expect(
      projectPrMergeModeService.setPrMergeMode(project.id, 'sometimes', ownerCtx),
    ).rejects.toBeInstanceOf(InvalidPrMergeModeError);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.prMergeModeDecidedAt).toBeNull();
  });

  it('answers a cross-tenant project as not found, for the read and the write', async () => {
    const a = await tenant();
    const b = await tenant();
    await expect(
      projectPrMergeModeService.getPrMergeMode(b.project.id, a.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      projectPrMergeModeService.setPrMergeMode(b.project.id, 'auto', a.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
