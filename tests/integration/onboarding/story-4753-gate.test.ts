import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readOnboardingSubstrate } from '@/lib/services/onboardingSubstrateService';
import { shouldRouteToMigrateWizard } from '@/lib/onboarding/migrateHandoff';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';
import { readOnboardingRoutingVerdict } from '@/lib/dto/onboardingRouting';
import { stepIsKept } from '@/lib/services/migrateOnboardingService';
import { pathToModule, REPO_ROOT } from '../../helpers/importGraph';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { randomToken } from '../../helpers/random';

// STORY MOTIR-4753's `motir-core` GATE (MOTIR-4761) — the seams BETWEEN this
// story's cards, and the guarantees a coverage percentage cannot see.
//
// Every card shipped its own units against a fixture its own author wrote. That
// is the expected normal, and it is exactly why this file exists: a fixture
// agrees with itself. What is asserted here is the CHAIN — the real substrate
// read driving the real predicate against a real Postgres — plus the four
// properties that are true of the STORY rather than of any one card, and that no
// percentage can report.

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

const read = (fx: WorkItemFixture, options: { itemCap?: number } = {}) =>
  readOnboardingSubstrate(
    fx.projectId,
    { userId: fx.ownerId, workspaceId: fx.workspaceId },
    options,
  );

const stripped = (rel: string) =>
  readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

beforeEach(async () => {
  await truncateJobRuns();
  await truncateAuthTables();
});

describe('SEAM · the REAL substrate read drives the REAL entrance predicate', () => {
  // The routing table's four rows, each built from committed database state
  // rather than from a hand-written DTO — which is what makes this a chain test
  // and not a second copy of the predicate's own fixture.
  it.each([
    ['nothing at all', false, 0, false],
    ['work items, no repository', false, 3, true],
    ['a repository, no work items', true, 0, true],
    ['both', true, 3, true],
  ] as const)('%s', async (_row, withRepo, items, expected) => {
    const fx = await makeWorkItemFixture();
    if (withRepo) await seedConnectedRepo(fx);
    for (let i = 0; i < items; i += 1) {
      await createTestWorkItem(fx, { kind: 'story', title: `Imported ${i}` });
    }

    const substrate = await read(fx);
    expect(
      shouldRouteToMigrateWizard({
        itemCount: substrate.itemCount,
        repositoryConnected: substrate.repositoryConnected,
        run: null,
      }),
    ).toBe(expected);
  });

  it('THE ROW THIS STORY IS FOR: a repository and no items still routes to migrate', async () => {
    // The defect MOTIR-4756 removed. `shouldRouteToMigrateWizard`'s first line
    // was `if (itemCount <= 0) return false`, with no repository input anywhere —
    // so a project with an indexed repository and an empty backlog fell through
    // to the start-fresh entrance, whose discovery is not code-grounded.
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const substrate = await read(fx);
    expect(substrate.itemCount).toBe(0);
    expect(substrate.repositoryConnected).toBe(true);
    expect(shouldRouteToMigrateWizard({ itemCount: 0, repositoryConnected: true, run: null })).toBe(
      true,
    );
  });
});

describe('GUARD · TRUNCATION IS NOT COMPLETENESS', () => {
  it('a capped read reports a FLOOR, and says so, on real rows', async () => {
    // The one input that turns a careful judgement into a confident wrong one.
    // Asserted through the read rather than on a fixture: the cap has to survive
    // a real `take` against a real table.
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 4; i += 1) await createTestWorkItem(fx, { kind: 'story', title: `S${i}` });

    const capped = await read(fx, { itemCap: 3 });
    expect(capped.itemCountTruncated).toBe(true);
    // NOT 4 — reporting the over-read's length would leak the `+1` probe and
    // tell a consumer a number the read is not entitled to claim.
    expect(capped.itemCount).toBe(3);

    const exact = await read(fx, { itemCap: 4 });
    expect(exact.itemCountTruncated).toBe(false);
    expect(exact.itemCount).toBe(4);
  });
});

describe('GUARD · THE WALL IS GONE — nothing navigates a never-onboarded project away', () => {
  it('the host gate has three verdicts and `onboarding` is not one', () => {
    const verdicts = new Set(
      [true, false].flatMap((hasActiveProject) =>
        [true, false].map((canBrowse) => resolvePlanningHostGate({ hasActiveProject, canBrowse })),
      ),
    );
    expect([...verdicts].sort()).toEqual(['no-access', 'no-project', 'workspace']);
  });

  it('and the plan surface performs no navigation before a verdict exists', () => {
    // Asserted on the source because it is a property of what is NOT there. The
    // defect was a `router.push` fired from an effect on arrival; a push a USER
    // presses is the opposite of it, so the guard is scoped to effects.
    const overlay = readFileSync(
      join(REPO_ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'),
      'utf8',
    );
    for (const block of overlay.split('useEffect(').slice(1)) {
      const body = block.slice(0, block.indexOf('\n  }, ['));
      expect(body).not.toMatch(/router\.push\(/);
    }
    expect(overlay).not.toMatch(/ONBOARDING_ENTRY_PATH/);
  });
});

describe('GUARD · MOTIR-CORE HAS NO OPINION — the one the whole model rests on', () => {
  it('no threshold, count or substrate comparison exists on the verdict’s path', () => {
    // A consuming surface that adds its own sanity check — *the planner said this
    // is plannable but the item count looks low* — reinstates exactly the proxy
    // this story removed, in a place nobody will look for it, and it would be
    // added in good faith by somebody defending against a bad verdict.
    const reader = stripped('lib/dto/onboardingRouting.ts');
    for (const tell of ['itemCount', 'repositoryConnected', 'repositoryIndexed', 'substrate']) {
      expect(reader, tell).not.toContain(tell);
    }
  });

  it('an INVALID verdict is ROUTED, not repaired', () => {
    // Declining a malformed answer and disagreeing with a well-formed one are
    // different acts, and that distinction is the whole of what this side has to
    // get right.
    const declined = readOnboardingRoutingVerdict({
      onboardingRouting: { outcome: 'onboard', message: 'm' },
    });
    expect(declined?.ok).toBe(false);
    expect(declined?.ok === false && declined.outcome).toBe('onboard_new_project');
  });

  it('and a well-formed verdict is carried EXACTLY as given', () => {
    expect(
      readOnboardingRoutingVerdict({
        onboardingRouting: { outcome: 'continue', message: 'What shall we plan?' },
      }),
    ).toEqual({ ok: true, verdict: { outcome: 'continue', message: 'What shall we plan?' } });
  });

  it('the wizard renders the set and decides none of it', () => {
    // Same property one surface along: `stepIsKept` asks whether a step is in the
    // set and nothing else, and an EMPTY set means every step — which is what a
    // run no verdict reached has.
    expect(stepIsKept({ keptSteps: [] }, 'discovery')).toBe(true);
    expect(stepIsKept({ keptSteps: ['connect'] }, 'discovery')).toBe(false);
    const service = stripped('lib/services/migrateOnboardingService.ts');
    const gate = service.slice(
      service.indexOf('if (!stepIsKept(run, wiring.from))'),
      service.indexOf('// (1) Kick the current step'),
    );
    expect(gate.length).toBeGreaterThan(40);
    expect(gate).not.toMatch(/readOnboardingSubstrate|itemCount|repositoryConnected/);
  });
});

describe('GUARD · the MARKER stays ONE-WAY', () => {
  it('nothing this story added writes, clears or re-derives `onboardingRanAt`', () => {
    // Asserted as a property over the surfaces this story TOUCHED rather than by
    // re-testing `markOnboardingRan`: the tempting shortcut for *this project no
    // longer needs onboarding* is to stamp the thing that means it, and that
    // would be a one-way write on somebody else's fact.
    for (const rel of [
      'lib/planning/workspaceHost.ts',
      'lib/planning/onboardingRoutingClient.ts',
      'lib/planning/onboardingHandoff.ts',
      'lib/planning/onboardingReturn.ts',
      'lib/dto/onboardingRouting.ts',
      'lib/services/onboardingSubstrateService.ts',
      'components/planning/PlanningWorkspaceOverlay.tsx',
      'components/planning/PlanningReadingState.tsx',
      'components/planning/PlanningHandOff.tsx',
    ]) {
      const code = stripped(rel);
      expect(code, rel).not.toContain('markOnboardingRan');
      expect(code, rel).not.toContain('onboardingRanAt');
    }
  });
});

describe('GUARD · the entrance predicate stays PURE', () => {
  it('no I/O is reachable from `migrateHandoff.ts`’s import graph', () => {
    // Both Server Components share one decision, and a predicate that could read
    // would be a predicate two callers could disagree about.
    expect(pathToModule('lib/onboarding/migrateHandoff.ts')).toBeNull();
    // Comments stripped: the file SAYS it is pure, at length, and the property is
    // about what it imports.
    expect(stripped('lib/onboarding/migrateHandoff.ts')).not.toContain('server-only');
  });

  it('and so does the host gate — it has no imports at all', () => {
    expect(readFileSync(join(REPO_ROOT, 'lib/planning/workspaceHost.ts'), 'utf8')).not.toMatch(
      /^\s*import\s/m,
    );
  });
});
