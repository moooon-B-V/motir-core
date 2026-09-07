import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// ════════════════════════════════════════════════════════════════════════════
// MOTIR-4736 — THE ONBOARDING FACT RIDES EVERY PLANNING SUBMIT
// ════════════════════════════════════════════════════════════════════════════
//
// `Project.onboardingRanAt` is null from the moment a project exists until its
// FIRST plan is approved and materialised (`markOnboardingRan`, stamped by
// `plansService.approvePlan` — MOTIR-1264). Every onboarding surface in
// motir-core gates on exactly that column. motir-ai cannot read it, so before
// this field it INFERRED onboarding from an EMPTY COMMITTED TREE
// (`mayPlanTheFirstTree`, MOTIR-4178).
//
// ⚠️ THE INFERENCE IS WRONG FOR THE ONE ONBOARDING JOURNEY BUILT TO HAVE WORK
// ITEMS, and that is the defect. The migrate wizard's optional import step
// (MOTIR-934 / MOTIR-1643) writes a Jira / Linear / GitHub / Plane / CSV backlog
// into real work items and only THEN kicks the first plan — with a prompt that
// asks the planner to de-duplicate against it. A tree-shaped guess reads that
// run as continued planning, so it gets the continued-planning lesson bucket and
// the anchored arm, and the de-duplicate prompt is read as a target to settle
// rather than as the project's requirement. The consumer half is MOTIR-4737.
//
// The consequence is the reason this file exists, and it is the same one
// `planningSubmitCarriesConsentFlag.test.ts` was written for: **a submit that
// drops the field does not fail anywhere.** There is no shared type across the
// open-core boundary, so it is not a type error; it is not a runtime error; and
// it does not show up in a coverage report. It is a planner quietly reasoning
// about the wrong kind of run.
//
// ⚠️ WHAT EACH HALF CAN AND CANNOT SEE, because neither substitutes for the other:
//
//   1. THE VALUE ON THE WIRE (parts 1–3). Drives the real entrances and asserts
//      the submitted BOOLEAN — the marker, not merely the key's presence, and in
//      both directions, so a hard-coded `true` cannot pass. It cannot see an
//      entrance nobody has written yet.
//   2. THE CALL SITES (part 4). A static assertion over `lib/`, derived from the
//      call sites themselves rather than from a list of the entrances that
//      happen to exist today. It is what stops a FOURTH planning submit
//      reintroducing this. It cannot see what any of them actually SEND.
//
// ⚠️ ASSERTED ON THE REQUEST BODY, NOT ON A `submitJob` MOCK. The card asked for
// the `submitJob` mock; the HTTP seam is the same assertion one layer lower and
// strictly stronger — it is the JSON motir-ai would actually have received, so it
// additionally proves the envelope builder carries the field through. It is the
// discipline `storyGate.oneKindOnTheWire.test.ts` states in its own header, and
// the reason it is available here is that both callers reach the wire through the
// REAL client. Everything below the HTTP boundary is real: real Postgres, the
// real services, the real `plansService` transactions.

import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { ONBOARDING_CONTEXT_FIELD, onboardingContextFor } from '@/lib/ai/onboardingContext';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { MigrateOnboardingExitConditionError } from '@/lib/migrateOnboarding/errors';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { randomToken } from '../../helpers/random';
import {
  allSubmitSitesInLib,
  planningSitesMissing,
  submitSites,
} from '../../helpers/submitJobSites';
import type { ProjectContext } from '@/lib/projects';
import type { WorkItemFixture } from '../../fixtures';

const ORIGIN = 'http://motir-ai.onboarding-flag.test';

// The WIRE STRING, written out rather than imported from the code under test.
// motir-ai spells this same literal in its own repository and no shared type
// binds them, so a test that read the name out of the module would agree with
// itself about it and prove nothing about the contract.
const WIRE_KEY = 'onboarding';

/** Every request body the seam received, in order. */
const bodies: Record<string, unknown>[] = [];

let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-onboarding-flag-'));
  const fixture = join(dir, 'jobs.json');
  writeFileSync(fixture, JSON.stringify({}));
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixture);

  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);

  // ⚠️ INSTALLED ONCE, deliberately — `observeAiJobSubmit` keeps its subscribers
  // in module scope, so installing per-test would stack observers and double
  // every capture.
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
  observeAiJobSubmit((raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  bodies.length = 0;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "import" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateJobRuns();
  await truncateAuthTables();
});

const ctxOf = (b: Record<string, unknown>): Record<string, unknown> =>
  (b['context'] ?? {}) as Record<string, unknown>;

/**
 * Build the caller's `ProjectContext` the way BOTH real callers build it — from a
 * FRESH project row.
 *
 * ⚠️ Deliberately not `{ ...fx, project: { ...fx.project, onboardingRanAt } }`.
 * The service reads `ctx.project.onboardingRanAt`, so hand-editing the DTO would
 * assert that the service copies a field a test just wrote — which is true of any
 * implementation and says nothing. `app/api/ai/plan/generate/route.ts` gets its
 * context from `getActiveProject()` and `migrateOnboardingService` from
 * `resolveProjectContext` (`assertProjectInWorkspace` → `toProjectDTO`); both read
 * the row per request, and this mirrors the second.
 */
async function freshProjectCtx(fx: WorkItemFixture): Promise<ProjectContext> {
  const project = await projectsService.assertProjectInWorkspace(fx.projectId, fx.workspaceId);
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: toProjectDTO(project),
  };
}

/** Stamp the immutable onboarding marker — what a first plan's approve does. */
async function stampOnboardingRan(projectId: string): Promise<void> {
  await adminDb.project.update({
    where: { id: projectId },
    data: { onboardingRanAt: new Date() },
  });
}

/** A `planned` plan for a revision to be held against. */
async function plannedPlan(fx: WorkItemFixture, ctx = fx.ctx): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}

/** Seed a connected GitHub repo so `resolveCodeContext` resolves one. */
async function seedConnectedRepo(fx: WorkItemFixture, owner = 'acme', name = 'widgets') {
  const rand = randomToken(6);
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${rand}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return `${owner}/${name}`;
}

/** Directly write run fields to place a run at a given step. */
async function patchRun(
  fx: WorkItemFixture,
  id: string,
  data: Prisma.MigrateOnboardingUncheckedUpdateInput,
) {
  return withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    (tx) => migrateOnboardingRepository.update(id, data, tx),
  );
}

/**
 * Drive the migrate wizard's GENERATE step and hand back the body it put on the
 * wire. `withImport` seeds a COMPLETED import first, which is what makes
 * `ensureKicked` enrich the prompt (MOTIR-1643) — and what makes this run the one
 * an empty-tree inference gets wrong.
 *
 * The advance throws `MigrateOnboardingExitConditionError` because the plan it
 * just opened is still `generating`; the submit has already happened by then,
 * which is what this drives it for.
 */
async function driveMigrateGenerate(
  fx: WorkItemFixture,
  withImport: boolean,
): Promise<Record<string, unknown>> {
  await seedConnectedRepo(fx);
  if (withImport) {
    await adminDb.import.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: 'jira',
        status: 'succeeded',
        createdCount: 10,
        updatedCount: 2,
        skippedCount: 1,
      },
    });
  }
  const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
  await patchRun(fx, run.id, {
    step: 'generate',
    connectedRepoRef: 'acme/widgets',
    codeGraphReady: true,
    conventionApprovedAt: new Date(),
    discoveryJobId: 'job-discovery',
    importCompleted: withImport,
  });

  bodies.length = 0;
  await expect(migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx)).rejects.toBeInstanceOf(
    MigrateOnboardingExitConditionError,
  );
  return bodies[0]!;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE GENERATION SUBMIT — the marker, in both directions
// ════════════════════════════════════════════════════════════════════════════

describe('`startGeneration` sends the project’s onboarding marker', () => {
  it('a project that has NEVER had a plan approved sends `onboarding: true`', async () => {
    const fx = await makeFixture();
    // The real unset case, asserted on the ROW rather than on a written null —
    // otherwise this measures the fixture, not the product.
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.onboardingRanAt, 'a fresh project should carry no marker').toBeNull();

    bodies.length = 0;
    await aiGenerationService.startGeneration(await freshProjectCtx(fx), {
      prompt: 'build a thing',
    });

    const context = ctxOf(bodies[0]!);
    // PRESENT — asserted separately from the value, because they fail
    // differently. `JSON.stringify` drops a key whose value is `undefined`, so a
    // producer that resolved the answer to `undefined` would look correct at the
    // call site and send nothing at all — and an ABSENT field sends motir-ai back
    // to inferring onboarding from the tree, which is the guess this replaces.
    expect(
      Object.prototype.hasOwnProperty.call(context, WIRE_KEY),
      `the generation submit did not send ${WIRE_KEY} at all`,
    ).toBe(true);
    expect(context[WIRE_KEY]).toBe(true);
  });

  it('and `false` once the marker is stamped — so `true` was not a constant', async () => {
    // The counterfactual. Without it a producer that hard-coded `true` would pass
    // the case above, and the assertion would be measuring the literal rather
    // than the marker.
    const fx = await makeFixture();
    await stampOnboardingRan(fx.projectId);

    bodies.length = 0;
    await aiGenerationService.startGeneration(await freshProjectCtx(fx), {
      prompt: 'build a thing',
    });

    expect(ctxOf(bodies[0]!)[WIRE_KEY]).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE OTHER TWO PLANNING SUBMITS — the shared one, and the one that bypasses it
// ════════════════════════════════════════════════════════════════════════════

describe('every OTHER planning entrance carries it too', () => {
  it('the shared plan-edit submit and `submitRevise` both send the marker', async () => {
    // ⚠️ `submitRevise` is asserted for the same reason MOTIR-4343 exists: it
    // BYPASSES `submitPlanEditJob` (a revision holds a lease and opens no plan),
    // so a field resolved only inside the shared submit never reaches it. That is
    // the exact shape that has already happened once on this envelope.
    const fx = await makeFixture();
    const c = await freshProjectCtx(fx);
    const planId = await plannedPlan(fx);

    bodies.length = 0;
    await aiPlanEditsService.submitAugment('add a login flow', c);
    const augment = ctxOf(bodies[0]!);

    bodies.length = 0;
    await aiPlanEditsService.submitRevise(planId, 'split the second story', c);
    const revise = ctxOf(bodies[0]!);

    for (const [name, context] of [
      ['augment', augment],
      ['revise', revise],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(context, WIRE_KEY),
        `${name} dropped ${WIRE_KEY}`,
      ).toBe(true);
      expect(context[WIRE_KEY], name).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE MIGRATE WIZARD — the run the empty-tree inference got wrong
// ════════════════════════════════════════════════════════════════════════════

describe('the migrate wizard’s GENERATE step sends `onboarding: true` over an imported backlog', () => {
  it('the de-duplicate prompt and the marker ride the SAME submit', async () => {
    // ⚠️ THIS IS THE DEFECT'S OWN CASE. The wizard has already written a backlog
    // into real work items, so the committed tree is NOT empty and motir-ai's
    // `mayPlanTheFirstTree` reads the run as continued planning — while the
    // prompt beside it says, verbatim, that this is a first plan over an imported
    // backlog. Asserting the two TOGETHER is the point: either alone is a run
    // shape that already existed.
    const fx = await makeFixture();
    const body = await driveMigrateGenerate(fx, true);
    const context = ctxOf(body);

    expect(body['jobKind'], 'the migrate wizard must submit the one planning kind').toBe('plan');
    expect(context['prompt'], 'the MOTIR-1643 reconcile prompt').toEqual(
      expect.stringContaining('imported from jira'),
    );
    expect(String(context['prompt'])).toContain('de-duplicate');
    expect(
      Object.prototype.hasOwnProperty.call(context, WIRE_KEY),
      `the migrate GENERATE step did not send ${WIRE_KEY} at all`,
    ).toBe(true);
    expect(context[WIRE_KEY], 'a migrate onboarding IS an onboarding').toBe(true);
  });

  it('and WITHOUT an import too — the field names the FACT, not the wizard step', async () => {
    const fx = await makeFixture();
    const context = ctxOf(await driveMigrateGenerate(fx, false));
    expect(context['prompt'] ?? null, 'no import ⇒ no reconcile prompt').toBeNull();
    expect(context[WIRE_KEY]).toBe(true);
  });

  it('and `false` on a migrate run whose project already onboarded — the fresh read', async () => {
    // The counterfactual for THIS caller specifically. `migrateOnboardingService`
    // builds its own `ProjectContext` from the row (`resolveProjectContext`), so
    // this is what says the marker is read at submit time rather than inherited
    // from whatever the caller happened to hold.
    const fx = await makeFixture();
    await stampOnboardingRan(fx.projectId);
    expect(ctxOf(await driveMigrateGenerate(fx, true))[WIRE_KEY]).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE CALL SITES — derived from the source, not from a list of entrances
// ════════════════════════════════════════════════════════════════════════════

/**
 * The token a planning submit must carry: the COMPUTED KEY form
 * (`[ONBOARDING_CONTEXT_FIELD]: …`) rather than the bare string, because that is
 * the discipline `lib/ai/onboardingContext.ts` states in its own words — there is
 * no shared type across the boundary, so the name is a string agreement between
 * two codebases and a typo on either side is not a type error. A site spelling
 * the literal instead is flagged, correctly.
 */
const REQUIRED_TOKEN = '[ONBOARDING_CONTEXT_FIELD]';

describe('no `submitJob` call site can send a planning kind without the onboarding marker', () => {
  it('every planning `submitJob` in `lib/` names the onboarding constant', async () => {
    const { files, sites } = await allSubmitSitesInLib();
    // The walker itself is asserted, because a walker that finds nothing passes
    // every absence: this is the tautology check that makes the assertion below
    // evidence rather than a green tick.
    expect(files.length, 'the source walk found no files').toBeGreaterThan(50);
    expect(files).toContain('lib/services/aiGenerationService.ts');
    expect(files).toContain('lib/services/aiPlanEditsService.ts');

    const offenders = planningSitesMissing(sites, REQUIRED_TOKEN);
    expect(
      offenders,
      `a planning submit drops the onboarding marker. motir-ai then falls back to ` +
        `inferring onboarding from an EMPTY COMMITTED TREE (MOTIR-4178), which is wrong ` +
        `for every migrate onboarding that imported a backlog first (MOTIR-4736). Send it ` +
        `unconditionally with onboardingContextFor(ctx.project):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the walk actually FOUND the planning submits — an absence over an empty set is vacuous', async () => {
    const { sites } = await allSubmitSitesInLib();
    const planning = sites.filter((s) => s.kind === 'plan');

    // Three today: `submitPlanEditJob` (the shared submit the four plan-edit
    // entrances route through), `submitRevise`, and `startGeneration`. A FLOOR
    // rather than an equality, so a legitimate fourth entrance does not fail this
    // line — it is caught by the guard above if it drops the field, which is the
    // property; this line only says the guard had something to read.
    expect(
      planning.length,
      'found no planning submit at all — the extractor stopped matching',
    ).toBeGreaterThanOrEqual(3);
    const inFiles = new Set(planning.map((s) => s.file));
    expect(inFiles).toContain('lib/services/aiGenerationService.ts');
    expect(inFiles).toContain('lib/services/aiPlanEditsService.ts');

    // …and the NON-planning submits are still seen and still excluded — this is
    // what says the filter is a filter rather than an accident of the extractor
    // failing to parse them. `ask_project`, `analyze_bug`, `discovery`,
    // `plan_sprint`, `propose_convention`, `noop` and `generate_explanation` are
    // correct submits and none of this card's business: onboarding is a fact
    // about PLANNING a project, and claiming it on a job whose handler has no
    // planning arm would assert a gate that does not exist.
    const nonPlanning = sites.filter((s) => s.kind !== null && s.kind !== 'plan');
    expect(nonPlanning.length, 'the extractor saw no non-planning submits').toBeGreaterThan(0);
    expect(planningSitesMissing(nonPlanning, REQUIRED_TOKEN)).toEqual([]);
  });

  it('THE DETECTOR CAN GO RED — the same extractor, over sources it should and should not flag', () => {
    // ⚠️ THE COUNTERFACTUAL. Everything above asserts an EMPTY list, and an empty
    // list is what a broken extractor returns too — so a guard that has never
    // been shown failing is not evidence, it is a tautology. These fixtures run
    // the SAME walker the real scan runs, so a change that stops it matching
    // fails HERE rather than passing everywhere.

    // (a) A fourth entrance that forgot the field — the exact regression.
    const bypassing = `
      const { jobId } = await submitJob(
        'plan',
        tenant,
        { prompt, generateExplanations: p.aiGenerateExplanations },
        { userId: ctx.userId },
      );`;
    expect(
      planningSitesMissing(submitSites('fake/bypass.ts', bypassing), REQUIRED_TOKEN),
    ).toHaveLength(1);

    // (b) The same site, fixed.
    const fixed = bypassing.replace(
      '{ prompt,',
      '{ prompt, [ONBOARDING_CONTEXT_FIELD]: onboardingContextFor(ctx.project),',
    );
    expect(planningSitesMissing(submitSites('fake/fixed.ts', fixed), REQUIRED_TOKEN)).toEqual([]);

    // (c) ⚠️ THE FIELD NAMED ONLY IN A COMMENT IS STILL AN OFFENDER. Every real
    // call site is wrapped in prose about this field — including the constant's
    // own name — so a `grep`-shaped guard would pass a site that documents the
    // contract and sends nothing.
    const commentedOnly = `
      const { jobId } = await submitJob(
        'plan',
        tenant,
        {
          // [ONBOARDING_CONTEXT_FIELD] rides every planning submit.
          prompt,
        },
        { userId: ctx.userId },
      );`;
    expect(
      planningSitesMissing(submitSites('fake/commented.ts', commentedOnly), REQUIRED_TOKEN),
    ).toHaveLength(1);

    // (d) A NON-planning submit with no field is correct and must not be flagged.
    const nonPlanning = `await submitJob('ask_project', tenant, { prompt }, { userId });`;
    expect(planningSitesMissing(submitSites('fake/ask.ts', nonPlanning), REQUIRED_TOKEN)).toEqual(
      [],
    );

    // (e) ⚠️ A QUOTE-BEARING REGEX EARLIER IN THE FILE MUST NOT HIDE THE SITE.
    // `lib/email.ts` contains exactly this pattern, and a walker that read its
    // `["']` as a string delimiter desynchronises for the rest of the file — so
    // every submit AFTER it silently leaves the population and the absence
    // assertion passes over a set that quietly shrank.
    const afterRegex = `
      const links = html.match(/<a\\s+[^>]*href=["']([^"']+)["'][^>]*>/gi);
      const label = text.replace(/\`([^\`]*)\`/g, '$1');
      ${bypassing}`;
    expect(
      planningSitesMissing(submitSites('fake/afterRegex.ts', afterRegex), REQUIRED_TOKEN),
    ).toHaveLength(1);
  });

  it('the required token IS the exported constant’s name, and the helper reads the marker', () => {
    // The guard checks for an identifier, so it is only meaningful while that
    // identifier is what the call sites use. A rename that left this unchanged
    // would make the guard match nothing and pass silently.
    expect(REQUIRED_TOKEN).toBe('[ONBOARDING_CONTEXT_FIELD]');
    expect(ONBOARDING_CONTEXT_FIELD).toBe(WIRE_KEY);

    // …and the helper's own contract, at the unit altitude: null ⇒ onboarding.
    expect(onboardingContextFor({ onboardingRanAt: null })).toBe(true);
    expect(onboardingContextFor({ onboardingRanAt: '2026-09-06T00:00:00.000Z' })).toBe(false);
    expect(onboardingContextFor({ onboardingRanAt: new Date() })).toBe(false);
  });
});
