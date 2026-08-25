// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-3433 — the authed layout's GATE and its await SHAPE.
//
// Two properties, and neither is visible from reading the file once somebody
// has edited it:
//
//   1. THE GATE IS FIRST. `getSession()` is awaited and the redirect thrown
//      before ANY tenant read is started. This is what makes a group-level
//      `loading.tsx` safe: a `loading.tsx` is a fallback for the layout's
//      CHILDREN, so an unauthenticated visitor is bounced and never shown a
//      shell frame. Reorder the file so one read starts before the gate and
//      nothing type-errors, nothing renders differently for a signed-in user,
//      and the only symptom is an unauthenticated request doing tenant work.
//
//   2. THE FOUR INDEPENDENT READS ARE CONCURRENT. They were four sequential
//      round trips, which is what a TYPED URL pays before any HTML body
//      exists — and therefore before the skeleton that is meant to appear
//      immediately can be rendered at all. Asserting "there is a Promise.all"
//      by reading the source is inspection; asserting that all four are STARTED
//      before any of them RESOLVES is the property itself, and it goes red the
//      moment someone re-serialises them with an intervening `await`.
//
// Everything the layout imports is mocked at module level, so `lib/db` and the
// service tree never load and this stays a component-lane test. The layout is
// an async Server Component — a function returning JSX — so it is CALLED, not
// rendered: the child components are imported but never executed.

const redirected = vi.fn((_to: string) => {
  throw new Error('NEXT_REDIRECT');
});
const getSession = vi.fn();

/** Records call ORDER and resolution order so concurrency is observable. */
const started: string[] = [];
let release: (() => void) | null = null;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const deferred = <T,>(name: string, value: T) =>
  vi.fn(async () => {
    started.push(name);
    await gate;
    return value;
  });

const getWorkspaceContext = deferred('ctx', { userId: 'u1', workspaceId: 'w1' });
const listUserWorkspaces = deferred('workspaces', []);
const findStandingByUserId = deferred('standing', null);
const cookiesFn = deferred('cookies', { get: () => undefined });

vi.mock('next/navigation', () => ({ redirect: (to: string) => redirected(to) }));
vi.mock('next/headers', () => ({ cookies: () => cookiesFn() }));
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext: () => getWorkspaceContext() }));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { listUserWorkspaces: () => listUserWorkspaces() },
}));
vi.mock('@/lib/repositories/platformStaffRepository', () => ({
  platformStaffRepository: { findStandingByUserId: () => findStandingByUserId() },
}));

// The rest of the tree: imported, never executed. Stubbed so no service or db
// module loads behind them.
vi.mock('@/lib/services/organizationsService', () => ({
  organizationsService: {
    resolveActiveOrganization: vi.fn(async () => null),
    listUserOrganizations: vi.fn(async () => []),
  },
}));
vi.mock('@/lib/organizations/cookie', () => ({ ORGANIZATION_COOKIE_NAME: 'org' }));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: {
    listProjects: vi.fn(async () => []),
    getActiveProject: vi.fn(async () => null),
  },
}));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getPermissionsDTO: vi.fn(async () => null) },
}));
vi.mock('@/lib/services/notificationsService', () => ({
  notificationsService: { getUnreadCount: vi.fn(async () => ({ unreadCount: 0 })) },
}));
vi.mock('@/lib/ai/availability', () => ({ isMotirAiConfigured: () => false }));
vi.mock('@/lib/onboarding/resumeVisibility', () => ({ resumeGateEnabled: () => false }));
vi.mock('@/lib/billing/availability', () => ({ isCloudBilling: () => false }));
vi.mock('@/lib/mappers/workspaceMappers', () => ({ toWorkspaceSummaryDTO: (w: unknown) => w }));
vi.mock('@/lib/permissions/catalog', () => ({}));

vi.mock('@/components/ui/Toast', () => ({ ToastProvider: () => null }));
vi.mock('@/components/ui/AppLayout', () => ({ AppLayout: () => null }));
vi.mock('@/components/ui/SidebarDrawer', () => ({ SidebarDrawer: () => null }));
vi.mock('@/components/planning/PlanWithAIFab', () => ({ PlanWithAIFab: () => null }));
vi.mock('@/app/(authed)/_components/TopNav', () => ({ TopNav: () => null }));
vi.mock('@/app/(authed)/_components/SidebarNav', () => ({ SidebarNav: () => null }));
vi.mock('@/app/(authed)/_components/ShellTierNav', () => ({ ShellTierNav: () => null }));
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  CommandPaletteProvider: () => null,
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  CreateIssueProvider: () => null,
}));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  ProjectAccessProvider: () => null,
}));
vi.mock('@/app/(authed)/_components/ReportProvider', () => ({ ReportProvider: () => null }));
vi.mock('@/app/(authed)/_components/AppCommandPalette', () => ({ AppCommandPalette: () => null }));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  OnboardingResumeProvider: () => null,
}));
vi.mock('@/app/(authed)/_components/ReportButton', () => ({ ReportButton: () => null }));
vi.mock('@/app/(authed)/_components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/app/(authed)/_components/build-in-public/BuildInPublicButton', () => ({
  BuildInPublicButton: () => null,
}));
vi.mock('@/app/(authed)/_components/build-in-public/BuildingInPublicHeaderLink', () => ({
  BuildingInPublicHeaderLink: () => null,
}));

import AuthedLayout from '@/app/(authed)/layout';

beforeEach(() => {
  started.length = 0;
  redirected.mockClear();
  getSession.mockReset();
});

afterEach(() => {
  release?.();
});

describe('the authed layout gate (MOTIR-3433)', () => {
  it('redirects an unauthenticated request BEFORE starting any tenant read', async () => {
    getSession.mockResolvedValue(null);

    await expect(AuthedLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT');

    expect(redirected).toHaveBeenCalledWith('/sign-in');
    // The whole point: nothing tenant-scoped was even STARTED for a request
    // with no session.
    expect(started).toEqual([]);
  });

  it('starts the four independent reads CONCURRENTLY, not one after another', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue', email: 'y@example.com' } });

    const pending = AuthedLayout({ children: null });

    // Let the microtask queue drain up to the first real suspension point.
    // Every one of the four must already be in flight while NONE has resolved —
    // which is only true of a Promise.all. Serialised awaits would show one.
    await Promise.resolve();
    await Promise.resolve();

    expect([...started].sort()).toEqual(['cookies', 'ctx', 'standing', 'workspaces']);

    release?.();
    await pending;
  });
});
