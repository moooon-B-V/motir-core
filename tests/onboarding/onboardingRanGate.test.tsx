import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { MigrateOnboardingDto } from '@/lib/dto/migrateOnboarding';

// The onboarding-ran gate on the `(onboarding)` route group (bug MOTIR-2090).
//
// `onboardingRanAt` is the set-once marker meaning "this project's first plan was
// approved + materialized" (Subtask 7.4 / MOTIR-1264). `/onboarding` and
// `/onboarding/discovery` have always redirected an established project to
// `/roadmap` off it; `/onboarding/migrate` did not — its only redirect was for a
// `completed` run. The two signals are written by different things (the marker by
// `markOnboardingRan` at approve / seed / operator stamp; the run only by the
// wizard walking `review → done`), so a project whose marker was set any other way
// kept a permanently `active` run and could resume the set-up wizard over a
// shipped tree by typing the URL — the live MOTIR project's exact state
// (`onboarding_ran_at` set, run `active` at `index`).
//
// Two contracts, tested without a DOM (we inspect the redirect call / the returned
// React element, not rendered markup — the `entry-rework` pattern):
//   1. The migrate page, BOTH directions: an established project is redirected
//      away whatever step its run sits at; a project mid-journey (null marker)
//      still resumes at its saved step. The resume path is the regression risk.
//   2. A GROUP-WIDE guard: exactly which `(onboarding)` pages read the marker, as
//      a scan rather than a count, so it cannot go stale — a route added to the
//      group must be classified as gated or deliberately ungated, or this fails.

// `redirect()` throws in Next so control never falls through; mirror that with a
// tagged sentinel we can assert on.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`REDIRECT:${to}`);
  }
}
const redirect = vi.fn((to: string) => {
  throw new RedirectError(to);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

const getActiveProject = vi.fn();
vi.mock('@/lib/projects', () => ({ getActiveProject: () => getActiveProject() }));

const getForProject = vi.fn();
vi.mock('@/lib/services/migrateOnboardingService', () => ({
  migrateOnboardingService: {
    getForProject: (projectId: string, ctx: unknown) => getForProject(projectId, ctx),
  },
}));

// Sentinel for the wizard island so we can assert the page returned IT (and with
// which run) without rendering the real client component.
function MigrateWizardStub() {
  return null;
}
vi.mock('@/app/(onboarding)/onboarding/migrate/_components/MigrateWizard', () => ({
  MigrateWizard: MigrateWizardStub,
}));

import MigrateOnboardingPage from '@/app/(onboarding)/onboarding/migrate/page';

afterEach(() => {
  vi.clearAllMocks();
});

/** Every step BEFORE the terminal `done` — the states in which the wizard renders
 *  its stepped shell. The gate must catch an established project at all of them. */
const NON_TERMINAL_STEPS = [
  'connect',
  'index',
  'import',
  'audit_convention',
  'discovery',
  'generate',
  'review',
] as const;

function makeRun(overrides: Partial<MigrateOnboardingDto> = {}): MigrateOnboardingDto {
  return {
    id: 'run-1',
    projectId: 'proj-1',
    kind: 'migrate',
    step: 'index',
    status: 'active',
    connectedRepoRef: null,
    codeGraphReady: false,
    conventionApprovedAt: null,
    discoveryJobId: null,
    generateJobId: null,
    importSkipped: false,
    importCompleted: false,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

/** The active-project context the page reads: only the marker and the naming
 *  fields matter here. */
function mockProject(onboardingRanAt: Date | null) {
  getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
  getActiveProject.mockResolvedValue({
    userId: 'u1',
    workspaceId: 'ws1',
    projectId: 'proj-1',
    project: { id: 'proj-1', name: 'MOTIR', identifier: 'MOTIR', onboardingRanAt },
  });
}

describe('/onboarding/migrate — established projects are redirected away (MOTIR-2090)', () => {
  it.each(NON_TERMINAL_STEPS)(
    'redirects to /roadmap when the marker is set and the run is still active at %s',
    async (step) => {
      mockProject(new Date('2026-08-04T16:33:00.000Z'));
      getForProject.mockResolvedValue(makeRun({ step }));

      await expect(MigrateOnboardingPage()).rejects.toThrow(RedirectError);
      expect(redirect).toHaveBeenCalledWith('/roadmap');
    },
  );

  it('gates BEFORE reading the run — an established project costs no service call', async () => {
    mockProject(new Date('2026-08-04T16:33:00.000Z'));

    await expect(MigrateOnboardingPage()).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/roadmap');
    expect(getForProject).not.toHaveBeenCalled();
  });
});

describe('/onboarding/migrate — a project mid-journey still resumes (MOTIR-2090)', () => {
  it.each(NON_TERMINAL_STEPS)(
    'renders the wizard at the saved step %s when the marker is null',
    async (step) => {
      mockProject(null);
      const run = makeRun({ step });
      getForProject.mockResolvedValue(run);

      const result = await MigrateOnboardingPage();

      expect(redirect).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        type: MigrateWizardStub,
        props: { initialRun: run, projectName: 'MOTIR', userInitial: 'Y' },
      });
    },
  );

  it('renders the wizard from step one when the project has no run yet', async () => {
    mockProject(null);
    getForProject.mockResolvedValue(null);

    const result = await MigrateOnboardingPage();

    expect(redirect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: MigrateWizardStub, props: { initialRun: null } });
  });

  it('still forwards a COMPLETED run to /roadmap — the pre-existing gate is untouched', async () => {
    mockProject(null);
    getForProject.mockResolvedValue(makeRun({ step: 'done', status: 'completed' }));

    await expect(MigrateOnboardingPage()).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/roadmap');
  });
});

describe('/onboarding/migrate — the gates that precede the marker', () => {
  it('bounces a signed-out visitor to sign-in, preserving the return path', async () => {
    getSession.mockResolvedValue(null);

    await expect(MigrateOnboardingPage()).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2Fonboarding%2Fmigrate');
    expect(getActiveProject).not.toHaveBeenCalled();
  });

  it('sends a visitor with no active project to the entrance', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(null);

    await expect(MigrateOnboardingPage()).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/onboarding');
    expect(getForProject).not.toHaveBeenCalled();
  });
});

// ── The group-wide guard ─────────────────────────────────────────────────────
//
// Written as a SCAN of the route group rather than a count of gated routes, so a
// new page cannot quietly join the group ungated: every `page.tsx` under
// `app/(onboarding)` must appear in exactly one of the two lists below, and the
// gated list must be exactly the set whose source reads the marker.

const ROOT = process.cwd();
const GROUP_DIR = join(ROOT, 'app', '(onboarding)');
/** The marker READ as every gate spells it — `ctx.project.onboardingRanAt`. Matching
 *  the expression rather than the bare identifier keeps prose (this rule is discussed
 *  in comments on several of these files) out of the result; a gate written some other
 *  way — a destructure — must be added to the expression, not left to drift. */
const MARKER_READ_RE = /\bproject\.onboardingRanAt\b/;

/** Routes that MUST read `onboardingRanAt`: each renders (or resumes) the
 *  onboarding journey itself, so an established project has no business there. */
const GATED_PAGES = [
  'app/(onboarding)/onboarding/discovery/page.tsx',
  'app/(onboarding)/onboarding/migrate/page.tsx',
  'app/(onboarding)/onboarding/page.tsx',
];

/** Routes deliberately NOT gated, each with the reason it is not the same hole.
 *  Ungated is a decision recorded here — not an omission. */
const UNGATED_PAGES: Record<string, string> = {
  // The issue importer is a standalone tool, not a journey step: the shipped
  // per-vendor OAuth callbacks hardcode this as their return path (`IMPORT_PATH`)
  // and the design also mounts it under Settings › Project › Import. Importing a
  // backlog into an ESTABLISHED project is legitimate, and gating it would break
  // the OAuth round trip for exactly those projects.
  'app/(onboarding)/onboarding/import/page.tsx':
    'standalone importer — legitimate for an established project; also the OAuth return path',
  // A read-only tier-doc view with an in-shell twin at `/direction/[tier]`. It
  // renders no journey state and mutates nothing; the only difference from the
  // twin is the shell-less framing, so reaching it establishes no onboarding.
  'app/(onboarding)/onboarding/direction/[tier]/page.tsx':
    'read-only doc view with an authed twin — renders no journey state',
  // A static explainer behind the entrance header's link. No project read at all.
  'app/(onboarding)/onboarding/how-it-works/page.tsx': 'static explainer — reads no project state',
};

function collectPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectPages(full));
    else if (entry.name === 'page.tsx') out.push(full);
  }
  return out;
}

describe('the (onboarding) route group — which routes read the marker (MOTIR-2090)', () => {
  const pages = collectPages(GROUP_DIR)
    .map((file) => relative(ROOT, file).split(sep).join('/'))
    .sort();

  it('classifies every page in the group as gated or deliberately ungated', () => {
    expect(pages).toEqual([...GATED_PAGES, ...Object.keys(UNGATED_PAGES)].sort());
  });

  it('the pages reading onboardingRanAt are exactly the gated ones', () => {
    const reading = pages
      .filter((p) => MARKER_READ_RE.test(readFileSync(join(ROOT, p), 'utf8')))
      .sort();

    expect(reading).toEqual([...GATED_PAGES].sort());
  });
});
