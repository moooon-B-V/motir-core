import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectStatusAutomationService } from '@/lib/services/projectStatusAutomationService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectStatusAutomationDto } from '@/lib/mappers/projectStatusAutomationMappers';
import {
  InvalidStatusAutomationSettingsError,
  NotProjectAdminError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { createTestWorkspace } from '../../fixtures/workspaceFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-1615 · Subtask MOTIR-1618 — the `Project` status-automation columns
// and the 4-layer path over them (migration → projectRepository →
// projectStatusAutomationService → DTO/mapper). Real Postgres, no mocks
// (CLAUDE.md).
//
// What these lock:
//   * the DEFAULTS every existing project backfills to — BOTH directions ON, the
//     ADR's rollout decision (`docs/decisions/status-derivation.md` §6);
//   * that the defaults live in the MIGRATION, so a project created by any path
//     (seed, import, raw insert) gets them;
//   * that the two switches are INDEPENDENT — turning the cascade off leaves the
//     rollup on, which is the whole reason there are two columns and not one;
//   * the partial-patch write path (an absent field is untouched);
//   * app-side validation — a non-boolean is REJECTED with a typed 422 error and
//     NOTHING is written, never coerced;
//   * the tenancy + admin gates (no existence leak on a foreign key; a plain
//     member may read but not change).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The settings fixture: an owner (project admin) + a project. */
async function makeFixture(opts: { name?: string; identifier?: string } = {}) {
  return makeWorkItemFixture({ name: opts.name ?? 'Acme', identifier: opts.identifier ?? 'PROD' });
}

/** The workspace-scoped context the settings service takes. */
function ctxFor(fx: WorkItemFixture, userId = fx.ownerId) {
  return { userId, workspaceId: fx.workspaceId };
}

describe('Project status-automation columns — defaults (MOTIR-1618)', () => {
  it('a freshly created project has BOTH directions ON — the opinion is the default', async () => {
    const fx = await makeFixture();

    const settings = await projectStatusAutomationService.getStatusAutomation(
      fx.projectIdentifier,
      ctxFor(fx),
    );

    expect(settings).toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: true,
    });
  });

  it('the columns exist on the row itself with those DB-level defaults (the migration, not the service)', async () => {
    const fx = await makeFixture();

    // Read the raw row: proves the DEFAULTs live in the migration, so a project
    // created by any path (seed, import, raw insert) backfills the same way —
    // which is what the ADR's "existing projects backfill to ON" rollout rests on.
    const row = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.autoRollupParentStatus).toBe(true);
    expect(row.autoCompleteChildrenOnParentDone).toBe(true);
  });

  it('the mapper projects exactly the two switches, from a row or from the narrow read', async () => {
    const fx = await makeFixture();
    const projection = await projectRepository.findStatusAutomation(fx.projectId);

    expect(projection).not.toBeNull();
    expect(toProjectStatusAutomationDto(projection!)).toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: true,
    });
  });
});

describe('Project status-automation — the update path (MOTIR-1618)', () => {
  it('the two switches are INDEPENDENT: the cascade goes off without touching the rollup', async () => {
    const fx = await makeFixture();

    // The upward-only preference the two-column model exists to express.
    const off = await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      { autoCompleteChildrenOnParentDone: false },
      ctxFor(fx),
    );
    expect(off).toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: false,
    });

    // And the reverse — rollup off, cascade back on — in one patch.
    const swapped = await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      { autoRollupParentStatus: false, autoCompleteChildrenOnParentDone: true },
      ctxFor(fx),
    );
    expect(swapped).toEqual({
      autoRollupParentStatus: false,
      autoCompleteChildrenOnParentDone: true,
    });
  });

  it('an ABSENT field is left untouched (the patch is partial)', async () => {
    const fx = await makeFixture();

    await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      { autoRollupParentStatus: false, autoCompleteChildrenOnParentDone: false },
      ctxFor(fx),
    );
    // Re-enable ONLY the rollup — the cascade must stay off.
    const after = await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      { autoRollupParentStatus: true },
      ctxFor(fx),
    );

    expect(after).toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: false,
    });
  });

  it('an empty patch is a no-op that still round-trips the current values', async () => {
    const fx = await makeFixture();
    await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      { autoRollupParentStatus: false },
      ctxFor(fx),
    );

    const after = await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      {},
      ctxFor(fx),
    );
    expect(after).toEqual({
      autoRollupParentStatus: false,
      autoCompleteChildrenOnParentDone: true,
    });
  });

  it('the values round-trip through the read DTO', async () => {
    const fx = await makeFixture();
    await projectStatusAutomationService.updateStatusAutomation(
      fx.projectIdentifier,
      { autoRollupParentStatus: false, autoCompleteChildrenOnParentDone: false },
      ctxFor(fx),
    );

    const read = await projectStatusAutomationService.getStatusAutomation(
      fx.projectIdentifier,
      ctxFor(fx),
    );
    expect(read).toEqual({
      autoRollupParentStatus: false,
      autoCompleteChildrenOnParentDone: false,
    });
  });

  it('settings are per-project: changing one leaves its sibling on the defaults', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Two projects' });
    const a = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
      identifier: 'ALPH',
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Beta',
      identifier: 'BETA',
    });
    const ctx = { userId: owner.id, workspaceId: workspace.id };

    await projectStatusAutomationService.updateStatusAutomation(
      'ALPH',
      { autoRollupParentStatus: false, autoCompleteChildrenOnParentDone: false },
      ctx,
    );

    expect(await projectStatusAutomationService.getStatusAutomation('BETA', ctx)).toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: true,
    });
    // And the edited one really changed (so the assertion above isn't vacuous).
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: a.id } })).autoRollupParentStatus,
    ).toBe(false);
  });
});

describe('Project status-automation — validation + gates (MOTIR-1618)', () => {
  it('a non-boolean switch is REJECTED with a typed 422 and nothing is written', async () => {
    const fx = await makeFixture();

    await expect(
      projectStatusAutomationService.updateStatusAutomation(
        fx.projectIdentifier,
        // The shape a careless client sends: the string "false", which is TRUTHY.
        { autoRollupParentStatus: 'false' as unknown as boolean },
        ctxFor(fx),
      ),
    ).rejects.toBeInstanceOf(InvalidStatusAutomationSettingsError);

    // Untouched — validation runs BEFORE the transaction opens.
    const after = await projectStatusAutomationService.getStatusAutomation(
      fx.projectIdentifier,
      ctxFor(fx),
    );
    expect(after.autoRollupParentStatus).toBe(true);
  });

  it('rejects a non-boolean CASCADE switch too, naming that field', async () => {
    const fx = await makeFixture();

    await expect(
      projectStatusAutomationService.updateStatusAutomation(
        fx.projectIdentifier,
        { autoCompleteChildrenOnParentDone: 1 as unknown as boolean },
        ctxFor(fx),
      ),
    ).rejects.toMatchObject({ field: 'autoCompleteChildrenOnParentDone' });

    const after = await projectStatusAutomationService.getStatusAutomation(
      fx.projectIdentifier,
      ctxFor(fx),
    );
    expect(after.autoCompleteChildrenOnParentDone).toBe(true);
  });

  it('the typed error maps to a 422 carrying the offending field', async () => {
    const res = projectErrorResponse(
      new InvalidStatusAutomationSettingsError('autoCompleteChildrenOnParentDone'),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(422);
    await expect(res!.json()).resolves.toMatchObject({
      code: 'INVALID_STATUS_AUTOMATION_SETTINGS',
      field: 'autoCompleteChildrenOnParentDone',
    });
  });

  it('a never-existed key reads as not-found (no existence leak)', async () => {
    const fx = await makeFixture();
    await expect(
      projectStatusAutomationService.getStatusAutomation('NOPE', ctxFor(fx)),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a plain workspace member can READ the switches but cannot CHANGE them', async () => {
    const fx = await makeFixture();
    const member = await createTestUser({ email: 'member@example.com' });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });

    // Browse-scoped read: an ordinary member sees the configuration.
    const read = await projectStatusAutomationService.getStatusAutomation(
      fx.projectIdentifier,
      ctxFor(fx, member.id),
    );
    expect(read.autoRollupParentStatus).toBe(true);

    await expect(
      projectStatusAutomationService.updateStatusAutomation(
        fx.projectIdentifier,
        { autoRollupParentStatus: false },
        ctxFor(fx, member.id),
      ),
    ).rejects.toBeInstanceOf(NotProjectAdminError);

    const after = await projectStatusAutomationService.getStatusAutomation(
      fx.projectIdentifier,
      ctxFor(fx),
    );
    expect(after.autoRollupParentStatus).toBe(true);
  });
});
