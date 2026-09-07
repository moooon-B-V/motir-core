import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { isMigrateOnboardingStep, MIGRATE_ONBOARDING_STEPS } from '@/lib/dto/migrateOnboarding';

// THE PLANNER-DECIDED STEP SET (Story MOTIR-4753 · MOTIR-4759).
//
// ⚠️ THE CARD WAS RE-SCOPED, AND THE ORIGINAL SHAPE IS THE THING TO AVOID. It
// asked for `discovery` to grow its own second exit condition — *satisfied by the
// substrate* — which would have been one special case to generalise later. The
// corrected model is the generalisation: **the planner returns which steps this
// onboarding should KEEP, and the wizard runs exactly that set.** `discovery` is
// one member of it, beside `connect`, `index` and `import`.
//
// ⚠️ SO THERE IS ONE GATE FOR THE WHOLE MACHINE, and these assertions are about
// that gate rather than about any step: a step the verdict did not keep does not
// KICK and does not POLL — it hops. Skipping the kick is the load-bearing half:
// `DISCOVERY.ensureKicked` submits the discovery turn, so a run that merely
// skipped the exit CHECK would still have started the interview this exists to
// spare the user.

const mocks = vi.hoisted(() => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'audit-1', conventionJobId: 'conv-1' })),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [] as unknown[], catalog: null })),
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: mocks.submitJob,
  refreshCodeAudit: mocks.refreshCodeAudit,
  getPreplanState: mocks.getPreplanState,
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  submitDiscoveryTurn: vi.fn(async () => ({ jobId: 'job-discovery' })),
}));

const { migrateOnboardingService, stepIsKept } =
  await import('@/lib/services/migrateOnboardingService');

const patch = (fx: WorkItemFixture, id: string, data: Record<string, unknown>) =>
  withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    (tx) => migrateOnboardingRepository.update(id, data, tx),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateJobRuns();
  await truncateAuthTables();
});

describe('`stepIsKept` — an EMPTY set means EVERY step', () => {
  it('is the whole compatibility story: a run no verdict reached is untouched', () => {
    // Nothing to backfill, and no flag to remember. Every run created by a door
    // other than the routing hand-off walks the wizard exactly as it always did.
    for (const step of MIGRATE_ONBOARDING_STEPS) {
      expect(stepIsKept({ keptSteps: [] }, step)).toBe(true);
    }
  });

  it('and a non-empty set is exactly its membership', () => {
    const run = { keptSteps: ['connect', 'discovery'] as const };
    expect(stepIsKept({ keptSteps: [...run.keptSteps] }, 'connect')).toBe(true);
    expect(stepIsKept({ keptSteps: [...run.keptSteps] }, 'discovery')).toBe(true);
    expect(stepIsKept({ keptSteps: [...run.keptSteps] }, 'index')).toBe(false);
    expect(stepIsKept({ keptSteps: [...run.keptSteps] }, 'import')).toBe(false);
  });
});

describe('the run PERSISTS the set it was opened with', () => {
  it('startMigration carries it, and a run with no verdict gets `[]`', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx, {
      keptSteps: ['connect', 'discovery'],
    });
    expect(run.keptSteps).toEqual(['connect', 'discovery']);

    const other = await makeWorkItemFixture();
    expect(
      (await migrateOnboardingService.startMigration(other.projectId, other.ctx)).keptSteps,
    ).toEqual([]);
  });

  it('the set is READ AT CREATE and nowhere else', async () => {
    // It describes the verdict that OPENED this run. Letting a later write
    // re-scope a journey in flight would mean a stale address could change which
    // questions a user is asked half-way through one.
    const service = (await import('node:fs')).readFileSync(
      new URL('../../lib/services/migrateOnboardingService.ts', import.meta.url),
      'utf8',
    );
    // Exactly one write of the field, and it is the create.
    expect((service.match(/keptSteps:/g) ?? []).length).toBe(1);
  });
});

describe('a step the verdict did NOT keep does not run', () => {
  it('hops without kicking the discovery interview — which is the point', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx, {
      // Everything the project already answers is absent; only `generate` and
      // `review` (machine steps) remain, plus nothing to ask the user.
      keptSteps: ['generate', 'review'],
    });
    await patch(fx, run.id, {
      step: 'discovery',
      codeGraphReady: true,
      conventionApprovedAt: new Date(),
    });

    const advanced = await migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx);

    expect(advanced.step).toBe('generate');
    // ⚠️ NO DISCOVERY TURN WAS SUBMITTED. A run that skipped only the exit CHECK
    // would still have started the interview.
    const client = await import('@/lib/ai/motirAiClient');
    expect(client.submitDiscoveryTurn).not.toHaveBeenCalled();
    // …and the exit poll never ran either — the pre-plan state was not read.
    expect(mocks.getPreplanState).not.toHaveBeenCalled();
  });

  it('and it hops even where the step’s own exit condition is UNMET', async () => {
    // The proof that the set is what decided it: `import` polls for a completed
    // import and there is none, so the ordinary path would refuse.
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx, {
      keptSteps: ['discovery'],
    });
    await patch(fx, run.id, { step: 'import' });

    expect((await migrateOnboardingService.advanceFromImport(run.id, fx.ctx)).step).toBe(
      'audit_convention',
    );
  });
});

describe('a step the verdict DID keep behaves exactly as before', () => {
  it('`discovery` still refuses until its own exit condition is met', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx, {
      keptSteps: ['discovery'],
    });
    await patch(fx, run.id, { step: 'discovery' });

    mocks.getPreplanState.mockResolvedValue({ session: null, docs: [], catalog: null });
    await expect(migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx)).rejects.toThrow();

    // …and exits on docs, the arm this card must not have touched.
    mocks.getPreplanState.mockResolvedValue({
      session: null,
      docs: [
        {
          kind: 'discovery',
          currentBody: 'direction',
          currentVersion: 1,
          summary: [],
          versions: [],
        },
      ],
      catalog: null,
    });
    expect((await migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx)).step).toBe(
      'generate',
    );
  });
});

describe('THE FLOOR, where it lives now', () => {
  it('motir-core validates MEMBERSHIP and nothing else', () => {
    // The re-scope is explicit: this side does not decide which steps to keep and
    // does not second-guess a set it is handed. What it may refuse is a set
    // naming a step this product does not have — a refusal, never a silent
    // repair — and that is a question about the ENUM, not about the project.
    expect(isMigrateOnboardingStep('discovery')).toBe(true);
    for (const notAStep of ['interview', 'Discovery', '', 'plan']) {
      expect(isMigrateOnboardingStep(notAStep)).toBe(false);
    }
  });

  it('the substrate floor is NOT re-checked here, and that is by design', async () => {
    // A project only reaches this wizard when the planner routed it here, which
    // requires a connected repository or an understandable work-item tree
    // (MOTIR-4767's precondition). Re-deriving that from the substrate would be
    // motir-core forming the opinion the story removed — so the service reads no
    // substrate at all on this path.
    const service = (await import('node:fs')).readFileSync(
      new URL('../../lib/services/migrateOnboardingService.ts', import.meta.url),
      'utf8',
    );
    const gate = service.slice(
      service.indexOf('if (!stepIsKept(run, wiring.from))'),
      service.indexOf('// (1) Kick the current step'),
    );
    expect(gate.length).toBeGreaterThan(50);
    expect(gate).not.toMatch(/readOnboardingSubstrate|itemCount|repositoryConnected/);
  });
});
