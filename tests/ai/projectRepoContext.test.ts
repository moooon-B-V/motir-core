import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The PRODUCER seam of repository-aware planning (Story MOTIR-2732 · MOTIR-3044):
// a planning-job submit carries the PROJECT's repository set on the envelope as
// `context.repositories.repos[]` — the cross-repo contract with MOTIR-3045's
// consumer. Real Postgres (the motir-core convention): seed a workspace, project
// and repository rows for real; mock ONLY the boundary client (no network).
//
// Exact-shape assertions per the seam-test convention, and for a reason this seam
// makes sharp: the ABSENT case must leave the envelope BYTE-IDENTICAL to today's,
// because "this project records no repositories" and "nobody asked" are different
// answers and a `{ repos: [] }` collapses them.
//
// The four things only this file is positioned to see:
//
//   1. The set crosses with the field a role CANNOT carry — the row's identity,
//      which is what makes two repositories of one role sayable at all.
//   2. Absent vs populated, as two separate envelopes.
//   3. The WORKSPACE grant list (`context.code`) is untouched beside it.
//   4. EVERY planning operation carries it, not the one a test drove.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveProjectRepoContext } from '@/lib/ai/projectRepoContext';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import type { ProjectContext } from '@/lib/projects';

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
  vi.mocked(submitJob).mockReset();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job-1' } as never);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedWorkspace(): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({
    email: `repo-ctx-${randomToken(6)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

async function seedProject(
  seed: { userId: string; workspaceId: string },
  identifier: string,
): Promise<ProjectContext> {
  const project = await projectsService.createProject({
    workspaceId: seed.workspaceId,
    actorUserId: seed.userId,
    name: identifier,
    identifier,
  });
  return {
    userId: seed.userId,
    workspaceId: seed.workspaceId,
    projectId: project.id,
    project,
  };
}

/** Add one row to a project's set, optionally realized against a connected repo. */
/** Monotonic per-call, so a fixture's SET ORDER is the order it was written in —
 *  `project_repository.position` is a fractional index and a random one would make
 *  the ordering assertions below meaningless. */
let nextPosition = 0;

async function addRow(
  ctx: ProjectContext,
  opts: {
    name: string;
    role: 'web' | 'api' | 'mobile' | 'shared' | 'infra' | 'other';
    label?: string | null;
    state?: 'proposed' | 'creating' | 'created' | 'connected' | 'skipped' | 'failed';
    realizedName?: string;
  },
): Promise<string> {
  let githubRepoId: string | undefined;
  if (opts.realizedName) {
    const inst = await adminDb.githubInstallation.upsert({
      where: { installationId: `inst-${ctx.workspaceId}` },
      create: {
        installationId: `inst-${ctx.workspaceId}`,
        workspaceId: ctx.workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
      update: {},
    });
    const gh = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: ctx.workspaceId,
        repoId: `repo-${randomToken(8)}`,
        owner: 'moooon',
        name: opts.realizedName,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    githubRepoId = gh.id;
  }
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      role: opts.role,
      label: opts.label ?? null,
      name: opts.name,
      seedSource: 'blank',
      state: opts.state ?? (opts.realizedName ? 'connected' : 'proposed'),
      position: `a${(nextPosition++).toString(36).padStart(4, '0')}`,
      ...(githubRepoId ? { githubRepoId } : {}),
    },
  });
  return row.id;
}

describe('resolveProjectRepoContext', () => {
  it('carries the identity a ROLE cannot — two `api` rows, told apart', async () => {
    // The ceiling this card lifts. `ProjectRepo.role`'s own comment says a role
    // MAY repeat, and §5.3 makes a repeated role resolve to NULL — so on this
    // project the planner could not mean the billing API rather than the search
    // API, and every card landed unpinned. The `ref` is what makes it sayable.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'ALPHA');
    const billing = await addRow(ctx, {
      name: 'billing-api',
      role: 'api',
      label: 'billing',
      realizedName: 'billing-api',
    });
    const search = await addRow(ctx, { name: 'search-api', role: 'api', label: 'search' });

    const repositories = await resolveProjectRepoContext(ctx.projectId, ctx);

    expect(repositories).toEqual({
      repos: [
        {
          ref: billing,
          name: 'billing-api',
          role: 'api',
          label: 'billing',
          state: 'connected',
        },
        { ref: search, name: 'search-api', role: 'api', label: 'search', state: 'proposed' },
      ],
    });
    // Two DISTINCT refs for one role — the property the whole field exists for.
    expect(new Set(repositories!.repos.map((r) => r.ref)).size).toBe(2);
  });

  it('prefers the REALIZED repository’s own name over the row’s authored intent', async () => {
    // A rename on the host must not make the planner name a checkout that no
    // longer answers — the same rule `lib/projectRepos/names.ts` applies.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'BETA');
    await addRow(ctx, { name: 'acme-web', role: 'web', realizedName: 'acme-storefront' });

    const repositories = await resolveProjectRepoContext(ctx.projectId, ctx);
    expect(repositories!.repos[0]!.name).toBe('acme-storefront');
  });

  it('includes UNESTABLISHED rows with their state, rather than filtering them out', async () => {
    // A plan is written before its repositories exist. A planner shown only
    // established rows would be blind to every repository the plan itself
    // proposed, which is most of them at generation.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'GAMMA');
    await addRow(ctx, { name: 'planned-api', role: 'api' });
    await addRow(ctx, { name: 'declined-mobile', role: 'mobile', state: 'skipped' });

    const repositories = await resolveProjectRepoContext(ctx.projectId, ctx);
    expect(repositories!.repos.map((r) => r.state).sort()).toEqual(['proposed', 'skipped']);
  });

  it('DROPS a row whose name normalizes to nothing rather than sending a blank one', async () => {
    // `normalizeTargetRepo` reads a blank as "no name", and a planner handed
    // `name: ''` would either pin to it or have to re-derive that rule. The row's
    // identity survives in the set only if it can be NAMED to a reader.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'KAPPA');
    await addRow(ctx, { name: '   ', role: 'other' });
    await addRow(ctx, { name: 'real-one', role: 'web' });

    const repositories = await resolveProjectRepoContext(ctx.projectId, ctx);
    expect(repositories!.repos.map((r) => r.name)).toEqual(['real-one']);
  });

  it('resolves UNDEFINED — not an empty set — for a project that records no repositories', async () => {
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'DELTA');
    expect(await resolveProjectRepoContext(ctx.projectId, ctx)).toBeUndefined();
  });

  it('is PROJECT-scoped: a sibling project’s rows never leak in', async () => {
    const seed = await seedWorkspace();
    const a = await seedProject(seed, 'AONE');
    const b = await seedProject(seed, 'BTWO');
    await addRow(a, { name: 'a-web', role: 'web' });
    await addRow(b, { name: 'b-web', role: 'web' });

    expect((await resolveProjectRepoContext(a.projectId, a))!.repos.map((r) => r.name)).toEqual([
      'a-web',
    ]);
    expect((await resolveProjectRepoContext(b.projectId, b))!.repos.map((r) => r.name)).toEqual([
      'b-web',
    ]);
  });
});

describe('the planning-job ENVELOPE', () => {
  it('carries context.repositories on generate_tree, BESIDE an untouched context.code', async () => {
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'EPS');
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-code',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '101',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    const web = await addRow(ctx, { name: 'motir-core', role: 'web' });

    await aiGenerationService.startGeneration(ctx, { prompt: 'extend the tracker' });

    const [jobKind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(jobKind).toBe('plan');
    // The WHOLE bag, exact shape. The two repository fields are DIFFERENT things
    // at different scopes and both are present, unmerged: `code` is the
    // workspace's grant list (an `owner/name` ref, for code-graph reads),
    // `repositories` is the project's set (an identity, a role, a state).
    expect(context).toEqual({
      prompt: 'extend the tracker',
      generateExplanations: false,
      // The consent flag rides every planning submit (MOTIR-4343), generation
      // included — ON here because this fixture never touches the setting.
      recordPlanningMistakes: true,
      // The onboarding marker (MOTIR-4736) — `true` here because this fixture's
      // project has never had a plan approved (`onboardingRanAt` is null).
      onboarding: true,
      code: {
        repos: [{ provider: 'github', repoRef: 'moooon/motir-core', defaultBranch: 'main' }],
      },
      repositories: {
        repos: [{ ref: web, name: 'motir-core', role: 'web', label: null, state: 'proposed' }],
      },
    });
  });

  it('OMITS context.repositories entirely for a project with no set — byte-identical to today', async () => {
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'ZETA');

    await aiGenerationService.startGeneration(ctx, { prompt: 'start fresh' });

    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    // `repositories` is absent (this project has no set); the consent flag is
    // PRESENT, because absence there means ON rather than none (MOTIR-4343).
    expect(context).toEqual({
      prompt: 'start fresh',
      generateExplanations: false,
      recordPlanningMistakes: true,
      // The onboarding marker (MOTIR-4736) — `true` here because this fixture's
      // project has never had a plan approved (`onboardingRanAt` is null).
      onboarding: true,
    });
    expect(Object.keys(context as object)).not.toContain('repositories');
  });

  it('carries it on EVERY plan-edit operation — augment, expand_item and replan', async () => {
    // AC 5 is a claim about the CODE, not about which operation a test drove, so
    // it is asserted over all three. They share one submit precisely so a
    // per-kind site cannot drop the field on the contextual path.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'ETA');
    const api = await addRow(ctx, { name: 'acme-api', role: 'api', realizedName: 'acme-api' });
    // `submitExpand` / `submitReplan` resolve a real target, so the fixture needs
    // a real container to point them at.
    const target = await workItemsService.createWorkItem(
      { projectId: ctx.projectId, kind: 'story', title: 'A container to expand' },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    const expected = {
      repos: [{ ref: api, name: 'acme-api', role: 'api', label: null, state: 'connected' }],
    };

    await aiPlanEditsService.submitAugment('add billing', ctx);
    expect(vi.mocked(submitJob).mock.calls.at(-1)![2]).toMatchObject({ repositories: expected });

    await aiPlanEditsService.submitExpand(target.identifier, ctx);
    expect(vi.mocked(submitJob).mock.calls.at(-1)![2]).toMatchObject({ repositories: expected });

    await aiPlanEditsService.submitReplan(target.identifier, ctx);
    expect(vi.mocked(submitJob).mock.calls.at(-1)![2]).toMatchObject({ repositories: expected });

    // Every planning submit this service makes carried it — counted, so a fourth
    // operation added later without the field fails here rather than silently.
    //
    // ⚠️ THE DISCRIMINATOR MOVED (MOTIR-4304). This filtered `kind !== 'generate_tree'`
    // to isolate the plan-EDIT calls from the generation one. After the switch
    // every planning submit sends `plan`, so a filter on the KIND selects
    // nothing — and a filter written to exclude one kind would silently pass by
    // matching everything or nothing, which is worse than failing. The three
    // calls in THIS test are all `aiPlanEditsService`'s, so the count is taken
    // over the calls this test made, and the kind is asserted rather than used
    // to partition.
    const planningCalls = vi.mocked(submitJob).mock.calls;
    expect(planningCalls.length).toBeGreaterThanOrEqual(3);
    for (const [kind, , context] of planningCalls) {
      expect(kind).toBe('plan');
      expect(context).toMatchObject({ repositories: expected });
    }
  });

  it('leaves the WORKSPACE grant list byte-identical for a job that carried one before', async () => {
    // The boundary this card must not cross: `context.code` is MOTIR-1598's and
    // is not re-scoped here, however tempting the adjacency.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'THETA');
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-untouched',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '201',
          owner: 'moooon',
          name: 'motir-ai',
          defaultBranch: 'trunk',
          archived: false,
        },
      ],
    });
    // A project row that names something ENTIRELY different from the grant list —
    // if the two were merged, this is where it would show.
    await addRow(ctx, { name: 'unrelated-service', role: 'infra' });

    await aiGenerationService.startGeneration(ctx, { prompt: 'go' });
    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect((context as { code: unknown }).code).toEqual({
      repos: [{ provider: 'github', repoRef: 'moooon/motir-ai', defaultBranch: 'trunk' }],
    });
  });
});

describe('the set service read this rides on', () => {
  it('is the same rows the establish surface lists, in set order', async () => {
    // Not a second query with its own ordering — a drift here would let the
    // planner and the settings page disagree about what the project has.
    const seed = await seedWorkspace();
    const ctx = await seedProject(seed, 'IOTA');
    await addRow(ctx, { name: 'one', role: 'web' });
    await addRow(ctx, { name: 'two', role: 'api' });

    const listed = await projectRepoSetService.listByProject(ctx.projectId, ctx);
    const envelope = await resolveProjectRepoContext(ctx.projectId, ctx);
    expect(envelope!.repos.map((r) => r.ref)).toEqual(listed.map((r) => r.id));
  });
});
