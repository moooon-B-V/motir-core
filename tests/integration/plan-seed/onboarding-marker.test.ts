import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { markDogfoodProjectEstablished } from '@/scripts/plan-seed/dogfoodProject';
import { seedGenerationTestProject } from '@/scripts/plan-seed/testProject';
import { stampOnboardingRan } from '@/scripts/stampOnboardingRan';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

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
  await adminDb.$disconnect();
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
  const row = await adminDb.project.findUnique({ where: { id: projectId } });
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
    const wrote = await withWorkspaceServiceContext(workspace.id, (tx) =>
      markDogfoodProjectEstablished(project.id, at, tx),
    );

    expect(wrote).toBe(true);
    expect(await readMarker(project.id)).toEqual(at);
    // THE CONTRAST — the whole point of the card's ⚠️: the test bed is the one
    // project that still lands in `/onboarding`.
    expect(testProject.onboardingRanAt).toBeNull();
    expect(await readMarker(testProject.id)).toBeNull();
  });

  it('is set-once — a reseed over an already-stamped project writes nothing', async () => {
    const { workspace, project } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'PROD',
    });
    const first = new Date('2026-07-31T12:00:00.000Z');
    const second = new Date('2026-08-05T09:30:00.000Z');

    expect(
      await withWorkspaceServiceContext(workspace.id, (tx) =>
        markDogfoodProjectEstablished(project.id, first, tx),
      ),
    ).toBe(true);
    expect(
      await withWorkspaceServiceContext(workspace.id, (tx) =>
        markDogfoodProjectEstablished(project.id, second, tx),
      ),
    ).toBe(false);

    // The ORIGINAL timestamp survives — the second call never overwrote it.
    expect(await readMarker(project.id)).toEqual(first);
  });
});

describe('the operator script — stampOnboardingRan (MOTIR-1799)', () => {
  it('--dry-run reports exactly what it would stamp and writes nothing', async () => {
    const { project, workspace } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'MOTIR',
    });

    // Through the `--workspace` arm (MOTIR-2813): it binds `app.bootstrap_slug`,
    // so this asserts the SAME behaviour under either role. The bare form needs
    // the operator connection and is covered on its own below.
    const outcome = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: workspace.slug,
      dryRun: true,
    });

    expect(outcome.kind).toBe('would_stamp');
    if (outcome.kind === 'would_stamp') expect(outcome.project.id).toBe(project.id);
    // The load-bearing half of a dry run.
    expect(await readMarker(project.id)).toBeNull();
  });

  it('a real run stamps the project; a second consecutive run reports zero writes', async () => {
    const { project, workspace } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'MOTIR',
    });
    const at = new Date('2026-07-31T12:00:00.000Z');

    const first = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: workspace.slug,
      dryRun: false,
      now: at,
    });
    expect(first.kind).toBe('stamped');
    expect(await readMarker(project.id)).toEqual(at);

    const second = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: workspace.slug,
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

    const outcome = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: workspace.slug,
      dryRun: false,
    });

    expect(outcome.kind).toBe('stamped');
    expect(await readMarker(project.id)).not.toBeNull();
    expect(await readMarker(sibling.id)).toBeNull();
  });

  it('REFUSES an ambiguous key rather than guessing a tenant, and writes nothing', async () => {
    const a = await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });
    const b = await makeTenant({ workspaceName: 'other-tenant', projectKey: 'MOTIR' });

    // Ambiguity is a property of the CROSS-TENANT search, which only the
    // operator connection can run (MOTIR-2813). `@/lib/db` is `motir_app`
    // (MOTIR-2734), which is not that connection, so the refusal — not the
    // `ambiguous` verdict — is what this run can reach. The `ambiguous` branch
    // is exercised by the operator-connection cases above.
    const run = stampOnboardingRan({ projectKey: 'MOTIR', dryRun: false });
    await expect(run).rejects.toThrow(/OPERATOR connection/);

    // Either way, nothing is written.
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
    const { project, workspace } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'MOTIR',
    });

    const outcome = await stampOnboardingRan({
      projectKey: 'NOPE',
      workspaceSlug: workspace.slug,
      dryRun: false,
    });

    expect(outcome.kind).toBe('project_not_found');
    expect(await readMarker(project.id)).toBeNull();
  });

  it('reports an unknown workspace slug without writing', async () => {
    const { project } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'MOTIR',
    });

    const outcome = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: 'no-such-workspace',
      dryRun: false,
    });

    expect(outcome.kind).toBe('workspace_not_found');
    expect(await readMarker(project.id)).toBeNull();
  });

  // ── MOTIR-2813: the ROLE posture the script's header used to get wrong ──────

  it('resolves by --workspace slug under the NON-BYPASS role', async () => {
    // The `--workspace` arm binds `app.bootstrap_slug`, and
    // `workspace_visible_bootstrap` admits exactly the row carrying it. So this
    // arm works under EITHER role — which is the point: before MOTIR-2813 the
    // slug resolve was unbound, returned null under `motir_app`, and the script
    // reported `workspace_not_found` for a workspace that plainly exists.
    const { workspace, project } = await makeTenant({
      workspaceName: 'moooon',
      projectKey: 'MOTIR',
    });

    const outcome = await stampOnboardingRan({
      projectKey: 'MOTIR',
      workspaceSlug: workspace.slug,
      dryRun: false,
    });

    expect(outcome.kind).toBe('stamped');
    expect(await readMarker(project.id)).not.toBeNull();
  });

  it('the cross-tenant key search REFUSES a non-bypass connection, loudly', async () => {
    // The other half. `findAllByIdentifier` searches every workspace, and there
    // is no policy arm for that — so under `motir_app` it would silently find
    // nothing and report the project missing. `assertOperatorConnection` reads
    // `pg_roles.rolbypassrls` and turns that into an accurate error instead.
    //
    // ⚠️ The refusal IS the assertion. Under the owner connection the search
    // would run and report `would_stamp`; `@/lib/db` is `motir_app` since
    // MOTIR-2734, so what must be proved is that the helper REFUSES rather than
    // silently finding nothing and reporting the project missing.
    await makeTenant({ workspaceName: 'moooon', projectKey: 'MOTIR' });

    const run = stampOnboardingRan({ projectKey: 'MOTIR', dryRun: true });
    await expect(run).rejects.toThrow(/OPERATOR connection/);
  });
});
