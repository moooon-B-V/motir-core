import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectAiSettingsDto } from '@/lib/mappers/projectAiSettingsMappers';
import {
  InvalidAiSettingsError,
  NotProjectAdminError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import {
  AI_AUTO_PLAN_THRESHOLD_MAX,
  AI_AUTO_PLAN_THRESHOLD_MIN,
  AI_PLANNER_MODEL_MAX_LENGTH,
  AI_SPRINT_LENGTH_DAYS_MAX,
  AI_SPRINT_LENGTH_DAYS_MIN,
} from '@/lib/projectAiSettings/limits';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { createTestWorkspace } from '../../fixtures/workspaceFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story 7.13 · Subtask MOTIR-915 — the `Project` AI-settings columns and the
// 4-layer path over them (migration → projectRepository → projectAiSettingsService
// → DTO/mapper). Real Postgres, no mocks (CLAUDE.md).
//
// What these lock:
//   * the DEFAULTS every existing project backfills to — the feature is OFF
//     (`aiAutoPlanEnabled` / `aiSprintPlanningEnabled` false, threshold 5, sprint
//      length 2 days, no planner-model override);
//   * the partial-patch write path (an absent field is untouched) through the
//     repository, with `aiPlannerModel` clearing back to the default;
//   * APP-SIDE validation — an out-of-range / fractional value is REJECTED with a
//     typed error and NOTHING is written, never silently clamped at the DB;
//   * the tenancy + admin gates (no existence leak on a foreign key; a non-admin
//     cannot change the cadence).

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

describe('Project AI-settings columns — defaults (MOTIR-915)', () => {
  it('a freshly created project backfills to the safe defaults: the feature is OFF', async () => {
    const fx = await makeFixture();

    const settings = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));

    expect(settings).toEqual({
      aiAutoPlanEnabled: false,
      aiAutoPlanThreshold: 5,
      aiSprintPlanningEnabled: false,
      aiSprintLengthDays: 2,
      aiPlannerModel: null,
      aiGenerateExplanations: false,
    });
  });

  it('the columns exist on the row itself with those DB-level defaults (the migration, not the service)', async () => {
    const fx = await makeFixture();

    // Read the raw row: proves the DEFAULTs live in the migration, so a project
    // created by any path (seed, import, raw insert) backfills the same way.
    const row = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    expect(row.aiAutoPlanEnabled).toBe(false);
    expect(row.aiAutoPlanThreshold).toBe(5);
    expect(row.aiSprintPlanningEnabled).toBe(false);
    expect(row.aiSprintLengthDays).toBe(2);
    expect(row.aiPlannerModel).toBeNull();
  });

  it('the mapper projects the row (and the repository projection) to the same DTO', async () => {
    const fx = await makeFixture();
    const projection = await projectRepository.findAiSettings(fx.projectId);
    const row = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    expect(projection).not.toBeNull();
    expect(toProjectAiSettingsDto(projection!)).toEqual(toProjectAiSettingsDto(row));
  });
});

describe('projectAiSettingsService.updateAiSettings — the write path', () => {
  it('persists every field through the repository and returns the updated DTO', async () => {
    const fx = await makeFixture();

    const updated = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      {
        aiAutoPlanEnabled: true,
        aiAutoPlanThreshold: 3,
        aiSprintPlanningEnabled: true,
        aiSprintLengthDays: 7,
        aiPlannerModel: 'deepseek-v4-flash',
        aiGenerateExplanations: true,
      },
      ctxFor(fx),
    );

    expect(updated).toEqual({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 3,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 7,
      aiPlannerModel: 'deepseek-v4-flash',
      aiGenerateExplanations: true,
    });
    // Committed, not just returned.
    const reread = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(reread).toEqual(updated);
  });

  it('is a PARTIAL patch — an absent field is left untouched', async () => {
    const fx = await makeFixture();
    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 9, aiPlannerModel: 'claude-opus-5' },
      ctxFor(fx),
    );

    const after = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiSprintPlanningEnabled: true },
      ctxFor(fx),
    );

    expect(after.aiSprintPlanningEnabled).toBe(true);
    expect(after.aiAutoPlanEnabled).toBe(true);
    expect(after.aiAutoPlanThreshold).toBe(9);
    expect(after.aiPlannerModel).toBe('claude-opus-5');
  });

  it('clears the planner-model override with null or an empty/blank string (→ the platform default)', async () => {
    const fx = await makeFixture();
    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiPlannerModel: 'deepseek-v4-pro' },
      ctxFor(fx),
    );

    const cleared = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiPlannerModel: '   ' },
      ctxFor(fx),
    );
    expect(cleared.aiPlannerModel).toBeNull();

    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiPlannerModel: 'deepseek-v4-pro' },
      ctxFor(fx),
    );
    const clearedByNull = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiPlannerModel: null },
      ctxFor(fx),
    );
    expect(clearedByNull.aiPlannerModel).toBeNull();
  });

  it('trims a planner-model override and accepts real model-id shapes', async () => {
    const fx = await makeFixture();
    for (const model of ['deepseek-v4-pro', 'openai/gpt-5.1', 'anthropic:claude-4.5', 'llama_3']) {
      const updated = await projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiPlannerModel: `  ${model}  ` },
        ctxFor(fx),
      );
      expect(updated.aiPlannerModel).toBe(model);
    }
  });

  it('accepts the bound VALUES themselves (the range is inclusive)', async () => {
    const fx = await makeFixture();

    const low = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      {
        aiAutoPlanThreshold: AI_AUTO_PLAN_THRESHOLD_MIN,
        aiSprintLengthDays: AI_SPRINT_LENGTH_DAYS_MIN,
      },
      ctxFor(fx),
    );
    expect(low.aiAutoPlanThreshold).toBe(AI_AUTO_PLAN_THRESHOLD_MIN);
    expect(low.aiSprintLengthDays).toBe(AI_SPRINT_LENGTH_DAYS_MIN);

    const high = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      {
        aiAutoPlanThreshold: AI_AUTO_PLAN_THRESHOLD_MAX,
        aiSprintLengthDays: AI_SPRINT_LENGTH_DAYS_MAX,
      },
      ctxFor(fx),
    );
    expect(high.aiAutoPlanThreshold).toBe(AI_AUTO_PLAN_THRESHOLD_MAX);
    expect(high.aiSprintLengthDays).toBe(AI_SPRINT_LENGTH_DAYS_MAX);
  });
});

describe('projectAiSettingsService.updateAiSettings — app-side validation (rejected, never clamped)', () => {
  it('rejects a threshold below 1 and writes NOTHING', async () => {
    const fx = await makeFixture();

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 0 },
        ctxFor(fx),
      ),
    ).rejects.toBeInstanceOf(InvalidAiSettingsError);

    // The whole patch is rejected — the sibling toggle in the same call did not land.
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiAutoPlanThreshold).toBe(5);
    expect(after.aiAutoPlanEnabled).toBe(false);
  });

  it('rejects a negative threshold, a fractional threshold, and one over the max', async () => {
    const fx = await makeFixture();
    for (const value of [-1, 2.5, AI_AUTO_PLAN_THRESHOLD_MAX + 1, Number.NaN]) {
      const err = await projectAiSettingsService
        .updateAiSettings(fx.projectIdentifier, { aiAutoPlanThreshold: value }, ctxFor(fx))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidAiSettingsError);
      expect((err as InvalidAiSettingsError).field).toBe('aiAutoPlanThreshold');
    }
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiAutoPlanThreshold).toBe(5);
  });

  it('rejects a sprint length outside 1..14 (and a fractional one)', async () => {
    const fx = await makeFixture();
    for (const value of [AI_SPRINT_LENGTH_DAYS_MIN - 1, AI_SPRINT_LENGTH_DAYS_MAX + 1, 1.5, -3]) {
      const err = await projectAiSettingsService
        .updateAiSettings(fx.projectIdentifier, { aiSprintLengthDays: value }, ctxFor(fx))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidAiSettingsError);
      expect((err as InvalidAiSettingsError).field).toBe('aiSprintLengthDays');
    }
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiSprintLengthDays).toBe(2);
  });

  it('rejects a malformed / over-long planner-model override', async () => {
    const fx = await makeFixture();
    for (const model of [
      'has spaces',
      'bad$char',
      '-leading-dash',
      'x'.repeat(AI_PLANNER_MODEL_MAX_LENGTH + 1),
    ]) {
      const err = await projectAiSettingsService
        .updateAiSettings(fx.projectIdentifier, { aiPlannerModel: model }, ctxFor(fx))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidAiSettingsError);
      expect((err as InvalidAiSettingsError).field).toBe('aiPlannerModel');
    }
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiPlannerModel).toBeNull();
  });

  it('the route layer maps the typed error to 422 with its field', async () => {
    const res = projectErrorResponse(
      new InvalidAiSettingsError('aiSprintLengthDays', 'The AI sprint length (days) must be…'),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(422);
    await expect(res!.json()).resolves.toMatchObject({
      code: 'INVALID_AI_SETTINGS',
      field: 'aiSprintLengthDays',
    });
  });
});

describe('projectAiSettingsService — tenancy + admin gates', () => {
  it('a key from ANOTHER workspace reads as not-found (no existence leak)', async () => {
    const mine = await makeFixture({ name: 'Mine', identifier: 'MINE' });
    const theirs = await makeFixture({ name: 'Theirs', identifier: 'THRS' });

    await expect(
      projectAiSettingsService.getAiSettings(theirs.projectIdentifier, ctxFor(mine)),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      projectAiSettingsService.updateAiSettings(
        theirs.projectIdentifier,
        { aiAutoPlanEnabled: true },
        ctxFor(mine),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    const untouched = await projectAiSettingsService.getAiSettings(
      theirs.projectIdentifier,
      ctxFor(theirs),
    );
    expect(untouched.aiAutoPlanEnabled).toBe(false);
  });

  it('a never-existed key reads as not-found', async () => {
    const fx = await makeFixture();
    await expect(projectAiSettingsService.getAiSettings('NOPE', ctxFor(fx))).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('a plain workspace member can READ the settings but cannot CHANGE them', async () => {
    const fx = await makeFixture();
    const member = await createTestUser({ email: 'member@example.com' });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });

    // Browse-scoped read: an ordinary member sees the configuration.
    const read = await projectAiSettingsService.getAiSettings(
      fx.projectIdentifier,
      ctxFor(fx, member.id),
    );
    expect(read.aiAutoPlanEnabled).toBe(false);

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiAutoPlanEnabled: true },
        ctxFor(fx, member.id),
      ),
    ).rejects.toBeInstanceOf(NotProjectAdminError);

    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiAutoPlanEnabled).toBe(false);
  });

  it('settings are per-project: changing one project leaves its sibling on the defaults', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Two projects' });
    const a = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
      identifier: 'ALPH',
    });
    const b = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Beta',
      identifier: 'BETA',
    });
    const ctx = { userId: owner.id, workspaceId: workspace.id };

    await projectAiSettingsService.updateAiSettings(
      a.identifier,
      { aiAutoPlanEnabled: true, aiSprintLengthDays: 5 },
      ctx,
    );

    expect(await projectAiSettingsService.getAiSettings(b.identifier, ctx)).toMatchObject({
      aiAutoPlanEnabled: false,
      aiSprintLengthDays: 2,
    });
  });
});
