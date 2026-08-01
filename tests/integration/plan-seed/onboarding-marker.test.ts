import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { markDogfoodProjectEstablished } from '@/scripts/plan-seed/dogfoodProject';
import { seedGenerationTestProject } from '@/scripts/plan-seed/testProject';
import { stampOnboardingRan } from '@/scripts/stampOnboardingRan';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-1799 — the onboarding-ran marker for the dogfood project. Two
// deliverables, both covered here against a real Postgres (the seed-test
// convention):
//
//   1. THE SEED CHANGE — `markDogfoodProjectEstablished`, which the seed calls
//      for the `motir` project. Pins the load-bearing CONTRAST: the dogfood
//      project is stamped, the generation TEST BED's marker stays NULL.
//   2. THE OPERATOR SCRIPT — `stampOnboardingRan`, the one-off stamp for the
//      live tenant (which can never be reseeded). Pins dry-run-writes-nothing,
//      idempotence, key scoping, and the refuse-on-ambiguity guard.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The seed's shape in miniature: a `moooon` workspace + its `motir` project. */
async function makeTenant(opts: { workspaceName: string; projectKey: string }) {
  const owner = await usersService.createUser({
    email: `owner-${opts.workspaceName}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: opts.workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: opts.projectKey,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  return { owner, workspace, project };
}

async function readMarker(projectId: string): Promise<Date | null> {
  const row = await db.project.findUnique({ where: { id: projectId } });
  return row?.onboardingRanAt ?? null;
}

describe('the seed change — markDogfoodProjectEstablished (MOTIR-1799)', () => {
  it('stamps the dogfood project while the generation test bed stays NULL', async () => {
    const { owner, workspace, project } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'PROD',
    });
    // The seed's SECOND project, created by the same helper the seed calls.
    const testProject = await seedGenerationTestProject({
      workspaceId: workspace.id,
      ownerUserId: owner.id,
      memberUserIds: [owner.id],
    });

    const at = new Date('2026-07-31T12:00:00.000Z');
    const wrote = await db.$transaction((tx) => markDogfoodProjectEstablished(project.id, at, tx));

    expect(wrote).toBe(true);
    expect(await readMarker(project.id)).toEqual(at);
    // THE CONTRAST — the whole point of the card's ⚠️: the test bed is the one
    // project that still lands in `/onboarding`.
    expect(testProject.onboardingRanAt).toBeNull();
    expect(await readMarker(testProject.id)).toBeNull();
  });

  it('is set-once — a reseed over an already-stamped project writes nothing', async () => {
    const { project } = await makeTenant({ workspaceName: 'moooon', projectKey: 'PROD' });
    const first = new Date('2026-07-31T12:00:00.000Z');
    const second = new Date('2026-08-05T09:30:00.000Z');

    expect(
      await db.$transaction((tx) => markDogfoodProjectEstablished(project.id, first, tx)),
    ).toBe(true);
    expect(
      await db.$transaction((tx) => markDogfoodProjectEstablished(project.id, second, tx)),
    ).toBe(false);

    // The ORIGINAL timestamp survives — the second call never overwrote it.
    expect(await readMarker(project.id)).toEqual(first);
  });
});

describe('the operator script — stampOnboardingRan (MOTIR-1799)', () => {
  it('--dry-run reports exactly what it would stamp and writes nothing', async () => {
    const { project } = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });

    const outcome = await stampOnboardingRan({ projectKey: 'MOTIR', dryRun: true });

    expect(outcome.kind).toBe('would_stamp');
    if (outcome.kind === 'would_stamp') expect(outcome.project.id).toBe(project.id);
    // The load-bearing half of a dry run.
    expect(await readMarker(project.id)).toBeNull();
  });

  it('a real run stamps the project; a second consecutive run reports zero writes', async () => {
    const { project } = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });
    const at = new Date('2026-07-31T12:00:00.000Z');

    const first = await stampOnboardingRan({ projectKey: 'MOTIR', dryRun: false, now: at });
    expect(first.kind).toBe('stamped');
    expect(await readMarker(project.id)).toEqual(at);

    const second = await stampOnboardingRan({
      projectKey: 'MOTIR',
      dryRun: false,
      now: new Date('2026-08-05T09:30:00.000Z'),
    });
    expect(second.kind).toBe('already_stamped');
    if (second.kind === 'already_stamped') expect(second.onboardingRanAt).toEqual(at);
    // Idempotent: the original stamp is intact, not overwritten.
    expect(await readMarker(project.id)).toEqual(at);
  });

  it('is scoped to the named project — a sibling in the same workspace is untouched', async () => {
    const { owner, workspace, project } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'MOTIR',
    });
    const sibling = await projectsService.createProject({
      name: 'Other',
      identifier: 'OTHER',
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const outcome = await stampOnboardingRan({ projectKey: 'MOTIR', dryRun: false });

    expect(outcome.kind).toBe('stamped');
    expect(await readMarker(project.id)).not.toBeNull();
    expect(await readMarker(sibling.id)).toBeNull();
  });

  it('REFUSES an ambiguous key rather than guessing a tenant, and writes nothing', async () => {
    const a = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });
    const b = await makeTenant({ workspaceName: 'other-tenant', projectKey: 'MOTIR' });

    const outcome = await stampOnboardingRan({ projectKey: 'MOTIR', dryRun: false });

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.candidates.map((c) => c.projectId).sort()).toEqual(
        [a.project.id, b.project.id].sort(),
      );
    }
    expect(await readMarker(a.project.id)).toBeNull();
    expect(await readMarker(b.project.id)).toBeNull();
  });

  it('--workspace disambiguates, stamping only the named tenant', async () => {
    const a = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });
    const b = await makeTenant({ workspaceName: 'other-tenant', projectKey: 'MOTIR' });

    const outcome = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: a.workspace.slug,
      dryRun: false,
    });

    expect(outcome.kind).toBe('stamped');
    expect(await readMarker(a.project.id)).not.toBeNull();
    expect(await readMarker(b.project.id)).toBeNull();
  });

  it('reports an unknown project key without writing', async () => {
    const { project } = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });

    const outcome = await stampOnboardingRan({ projectKey: 'NOPE', dryRun: false });

    expect(outcome.kind).toBe('project_not_found');
    expect(await readMarker(project.id)).toBeNull();
  });

  it('reports an unknown workspace slug without writing', async () => {
    const { project } = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });

    const outcome = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: 'no-such-workspace',
      dryRun: false,
    });

    expect(outcome.kind).toBe('workspace_not_found');
    expect(await readMarker(project.id)).toBeNull();
  });
});
