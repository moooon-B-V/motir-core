import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling cadence / sprint / plan-edit
// suites). Everything below it is real: a real Postgres, the real settings
// write path, the real cross-workspace cadence scan.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { aiSprintPlanningService } from '@/lib/services/aiSprintPlanningService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { InvalidAiSettingsError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  PLANNER_MODEL_OPTIONS,
  choiceToPlannerModel,
  plannerModelToChoice,
} from '@/lib/projectAiSettings/plannerModels';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// Story 7.13 · Subtask 7.13.7 (MOTIR-920) — the STORY-LEVEL gate over the merged
// 7.13 surface. The implementation subtasks (MOTIR-915/916/918/919/1740) each
// shipped their own suite under the "code + tests are one deliverable" floor, and
// those suites are thorough — so this card deliberately does NOT re-derive their
// matrices (notes.html #69/#90/#102/#145: a story-level test card that re-covers
// the per-subtask floors is the recurring failure, not the deliverable).
//
// What it adds is the residue those floors cannot reach, found by MEASURING
// coverage over the merged surface rather than by re-reading the card's prose:
//
//   1. The PICKER ↔ VALIDATOR seam. `plannerModels.ts` (client, MOTIR-919) and
//      `projectAiSettingsService` (server, MOTIR-915) are two modules with no
//      compiler between them; the panel's component test drives the rendered
//      Combobox and the service's suite drives raw strings, so nothing proves a
//      value the picker OFFERS actually persists and reads back as the same
//      choice. Driven here end to end through the real service.
//   2. The ERROR-PATH branches each suite's happy fixtures miss — a non-Error
//      rejection out of the motir-ai boundary, a non-string planner model off an
//      untyped JSON body, and the sprint submit's cross-tenant project read.
//      Each is a REAL production shape, not a coverage-chasing synthetic.
//   3. The OPEN-CORE boundary guard coverage cannot see (structural, not
//      executed): the 7.13 surface crosses to motir-ai through the ONE HTTP
//      client module and nothing else.
//
// The cadence trigger's own boundaries (threshold / opt-in / pending-proposal
// gate of either origin / actor / provenance / proposal-only / failure isolation)
// and the shared-predicate seam are already driven by
// `tests/integration/ai/autoPlanCadence.test.ts`; the sprint persist +
// re-validation + atomicity by `aiSprintPlanning.test.ts`; the settings columns +
// auth matrix by `projectAiSettings.test.ts` / `projectAiSettingsRoutes.test.ts`.
// They are not repeated here.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The workspace-scoped context the settings service takes. */
function ctxFor(fx: WorkItemFixture) {
  return { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

/** The `ProjectContext` the sprint-planning service takes. */
function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

describe('7.13 seam — the planner-model picker round-trips through the REAL service (MOTIR-920)', () => {
  it('every choice the panel offers persists and reads back as the SAME choice', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });

    for (const option of PLANNER_MODEL_OPTIONS) {
      // The panel's save direction: chosen value → the stored override.
      const stored = choiceToPlannerModel(option.value);

      const written = await projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiPlannerModel: stored },
        ctxFor(fx),
      );
      expect(written.aiPlannerModel).toBe(stored);

      // The panel's load direction: read the column back and re-derive the
      // picker value. Anything but the original choice is silent data loss —
      // the tenant's pinned model swapped under them on the next save.
      const read = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
      expect(plannerModelToChoice(read.aiPlannerModel)).toBe(option.value);
    }
  });

  it('the Default choice CLEARS a previously pinned override, rather than storing a sentinel', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });

    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiPlannerModel: 'deepseek-v4-pro' },
      ctxFor(fx),
    );
    // Now pick "Default" in the panel.
    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiPlannerModel: choiceToPlannerModel('default') },
      ctxFor(fx),
    );

    // The COLUMN is null — the deployment's PLANNER_MODEL applies. If the
    // sentinel string ever reached the DB, motir-ai would be asked to run a
    // model literally named "default".
    const row = await db.project.findUnique({
      where: { id: fx.projectId },
      select: { aiPlannerModel: true },
    });
    expect(row?.aiPlannerModel).toBeNull();
  });
});

describe('7.13 residue — the boundary error paths the happy fixtures miss (MOTIR-920)', () => {
  it('isolates a submit that rejects with a NON-Error value, and reports it readably', async () => {
    // Real shape, not a synthetic: a rejected fetch / a thrown string / a
    // provider SDK rejecting with a plain object all reach the sweep's catch as
    // a non-Error. If `errorMessage` assumed `.message`, the run-ledger summary
    // the 1.6.5 dashboard renders would read "undefined" for every such outage.
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    await db.project.update({
      where: { id: fx.projectId },
      data: { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 },
    });
    // One childless epic = the expandable stub AND the whole (drained) ready set.
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Unexpanded epic' },
      fx.ctx,
    );

    // The sweep logs the failure; keep the suite output clean while asserting it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const summary = await autoPlanCadenceService.runCadenceSweep({
        deps: { submitExpand: () => Promise.reject('motir-ai is unreachable') },
      });

      expect(summary.failed).toBe(1);
      expect(summary.fired).toBe(0);
      const outcome = summary.outcomes.find((o) => o.projectId === fx.projectId);
      expect(outcome).toEqual({
        projectId: fx.projectId,
        status: 'failed',
        // Stringified, not `undefined` — the point of the branch.
        error: 'motir-ai is unreachable',
      });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }

    // And the failure wrote nothing: no Plan opened, no tree change.
    expect(await db.plan.count()).toBe(0);
    expect(await db.workItem.count()).toBe(1);
  });

  it('rejects a NON-STRING planner model with the typed error, and writes nothing', async () => {
    // The route hands the service a parsed JSON body, so a client can send
    // `{"aiPlannerModel": 42}` — a shape TypeScript cannot rule out at runtime.
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiPlannerModel: 42 as unknown as string },
        ctxFor(fx),
      ),
    ).rejects.toThrowError(InvalidAiSettingsError);

    // Validation runs BEFORE the transaction opens — the column is untouched.
    const row = await db.project.findUnique({
      where: { id: fx.projectId },
      select: { aiPlannerModel: true },
    });
    expect(row?.aiPlannerModel).toBeNull();
  });

  it('names the offending FIELD on the typed error, so the panel can slot the message', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiPlannerModel: true as unknown as string },
        ctxFor(fx),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AI_SETTINGS', field: 'aiPlannerModel' });
  });

  it('the sprint submit reads its settings TENANT-SCOPED — a cross-workspace project is not-found', async () => {
    // `ProjectContext` carries a projectId and a workspaceId independently, so a
    // stale/forged active-project cookie can pair one tenant's workspace with
    // another's project. The submit must refuse before it ever reaches motir-ai.
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHR' });
    await db.project.update({
      where: { id: theirs.projectId },
      data: { aiSprintPlanningEnabled: true },
    });

    const crossTenant: ProjectContext = {
      ...projectCtx(mine),
      projectId: theirs.projectId,
    };

    await expect(aiSprintPlanningService.submitSprintPlan(crossTenant)).rejects.toThrowError(
      ProjectNotFoundError,
    );

    const { submitJob } = await import('@/lib/ai/motirAiClient');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });

  it('the sprint submit refuses a project that VANISHED between context build and submit', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const ctx: ProjectContext = { ...projectCtx(fx), projectId: 'prj_does_not_exist' };

    await expect(aiSprintPlanningService.submitSprintPlan(ctx)).rejects.toThrowError(
      ProjectNotFoundError,
    );
  });
});

describe('Open-core boundary guard — the 7.13 surface crosses to motir-ai ONCE (MOTIR-920)', () => {
  // Structural, not executed — coverage proves lines RAN, it cannot prove an
  // import does not exist. motir-core is the GPL-3.0 open half (Principle #19):
  // it may CALL motir-ai over HTTP, but importing its source would fold the
  // closed half into the open one. The single sanctioned crossing is
  // `@/lib/ai/motirAiClient`, which is also the one module every suite here
  // mocks — so an unnoticed second crossing would be untested AND unmockable.
  const SURFACE = [
    'lib/services/autoPlanCadenceService.ts',
    'lib/services/aiSprintPlanningService.ts',
    'lib/services/projectAiSettingsService.ts',
    'lib/ai/sprintAssignment.ts',
    'lib/projectAiSettings/limits.ts',
    'lib/projectAiSettings/plannerModels.ts',
    'lib/mappers/projectAiSettingsMappers.ts',
    'lib/jobs/definitions/autoPlanCadenceTick.ts',
  ];

  /** Every module specifier the file imports (static imports + `await import`). */
  function importsOf(relPath: string): string[] {
    const source = readFileSync(resolve(process.cwd(), relPath), 'utf8');
    return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  }

  it('no 7.13 module imports motir-ai source — only the HTTP client may cross', () => {
    for (const file of SURFACE) {
      const offenders = importsOf(file).filter(
        (spec) =>
          // A path escape out of this repo, or a motir-ai package specifier.
          /(^|\/)motir-ai(\/|$)/.test(spec) || spec.startsWith('@motir/ai'),
      );
      expect(offenders, `${file} must not import motir-ai source`).toEqual([]);
    }
  });

  it('the guard BITES — the matcher really does catch a motir-ai import', () => {
    // Proves the assertion above is not vacuous (the `billingBoundaryContract`
    // drift-simulation pattern): if the matcher were wrong, "no offenders" would
    // be meaningless. These are the specifier shapes a real breach would take.
    const isBreach = (spec: string) =>
      /(^|\/)motir-ai(\/|$)/.test(spec) || spec.startsWith('@motir/ai');

    expect(isBreach('../../../motir-ai/src/services/usageService')).toBe(true);
    expect(isBreach('motir-ai/src/llm/gatewayClient')).toBe(true);
    expect(isBreach('@motir/ai')).toBe(true);
    // …and does not fire on the sanctioned crossing or ordinary core imports.
    expect(isBreach('@/lib/ai/motirAiClient')).toBe(false);
    expect(isBreach('@/lib/ai/types')).toBe(false);
  });

  it('exactly ONE module in the surface reaches the client — the sprint submit', () => {
    const crossers = SURFACE.filter((file) =>
      importsOf(file).some((spec) => spec === '@/lib/ai/motirAiClient'),
    );
    // The settings / limits / picker / mapper modules and the cron definition are
    // pure core concerns and must not reach the boundary at all. The cadence
    // service reaches motir-ai only INDIRECTLY, by delegating to the shipped
    // `aiPlanEditsService.submitExpand` — it holds no client import of its own,
    // which is why its sweep is drivable through an injected `submitExpand`.
    expect(crossers).toEqual(['lib/services/aiSprintPlanningService.ts']);
  });

  it('the two picker modules stay dependency-free — importable by the client bundle', () => {
    // `limits.ts` / `plannerModels.ts` exist as their own modules precisely so
    // the settings PANEL can import the bounds and the options without pulling
    // the service layer (and `db`) into the browser bundle. A single runtime
    // import here would undo that, silently, with nothing else to catch it.
    for (const file of [
      'lib/projectAiSettings/limits.ts',
      'lib/projectAiSettings/plannerModels.ts',
    ]) {
      expect(importsOf(file), `${file} must stay dependency-free`).toEqual([]);
    }
  });

  it('the packing re-validation imports only the shared TYPE module — no data access', () => {
    // `sprintAssignment.ts` is the pure semantic pass the approve runs BEFORE
    // any write. It may name the wire types it validates, but reaching a
    // repository or `db` from here would move a write-gate decision out of the
    // service layer and make the pass untestable in isolation.
    expect(importsOf('lib/ai/sprintAssignment.ts')).toEqual(['@/lib/ai/types']);
  });

  it('the guard reads REAL files — a typo’d path fails loudly rather than passing vacuously', () => {
    for (const file of SURFACE) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source.length, `${file} should be a real, non-empty module`).toBeGreaterThan(0);
    }
  });
});
