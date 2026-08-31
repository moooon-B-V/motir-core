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
// The 2FA enforcement gate (MOTIR-3648) joins the SAME wave — see the fourth
// assertion below for why that placement is the property, not a detail.
const assertTwoFactorCompliance = deferred('twoFactor', undefined);

vi.mock('next/navigation', () => ({ redirect: (to: string) => redirected(to) }));
vi.mock('next/headers', () => ({ cookies: () => cookiesFn() }));
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/auth/twoFactorGate', () => ({
  assertTwoFactorCompliance: () => assertTwoFactorCompliance(),
}));
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
// Both predicates (MOTIR-4035): the shell asks the BILLING question for the org
// menu's plans row and the CLOUD question for the build-in-public slot. Mocking
// only the first leaves `isCloud` undefined and the layout throws at render.
vi.mock('@/lib/billing/availability', () => ({
  isCloudBilling: () => false,
  isCloud: () => false,
}));
vi.mock('@/lib/mappers/workspaceMappers', () => ({ toWorkspaceSummaryDTO: (w: unknown) => w }));
vi.mock('@/lib/permissions/catalog', () => ({}));

vi.mock('@/components/ui/Toast', () => ({ ToastProvider: () => null }));
vi.mock('@/components/ui/AppLayout', () => ({ AppLayout: () => null }));
vi.mock('@/app/(authed)/_components/AccountDeletionBanner', () => ({
  AccountDeletionBanner: () => null,
}));
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
import { AppLayout } from '@/components/ui/AppLayout';
import { AccountDeletionBanner } from '@/app/(authed)/_components/AccountDeletionBanner';
import { findFirst } from '../helpers/serverPageHarness';

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

    expect([...started].sort()).toEqual(['cookies', 'ctx', 'standing', 'twoFactor', 'workspaces']);

    release?.();
    await pending;
  });

  it('⚠️ the 2FA gate rides that wave — it is not a FIFTH sequential round trip', async () => {
    // MOTIR-3648. This gate runs on every signed-in page load in the product, so
    // an `await` of its own above the wave would add a round trip to every one
    // of them — undoing the fix this file exists to protect. The property is
    // that it is STARTED alongside the other four and before any of them
    // resolves, which a sequential `await` cannot produce.
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue', email: 'y@example.com' } });

    const pending = AuthedLayout({ children: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toContain('twoFactor');
    expect(started).toHaveLength(5);

    release?.();
    await pending;
  });

  it('⚠️ mounts the account-deletion banner in the shell — ONCE, for every authed route', async () => {
    // MOTIR-3704. Design DECISION 4 requires the cancel door on EVERY page —
    // *"a grace period is only reachable if the reader can find it"*, and a
    // reader who changes their mind on day nine opens the app rather than
    // Settings › Data & privacy. Mounting it here is what makes that a
    // property of the shell instead of something each route must remember, so
    // the assertion is that the LAYOUT fills the slot, not that some page does.
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue', email: 'y@example.com' } });

    const pending = AuthedLayout({ children: null });
    await Promise.resolve();
    await Promise.resolve();
    release?.();

    // The layout is CALLED, not rendered (this file's own preamble), so the
    // property lives in the element tree it returned rather than in a render.
    const shell = findFirst<{ banner?: { type?: unknown; props?: { userId?: string } } }>(
      await pending,
      AppLayout,
    );
    expect(shell).toBeTruthy();
    expect(shell!.props.banner?.type).toBe(AccountDeletionBanner);
    // It is given the SIGNED-IN reader's id — a banner resolved for anybody
    // else would show one person's deletion to another.
    expect(shell!.props.banner?.props?.userId).toBe('u1');
  });

  it('⚠️ the 2FA gate does NOT run for a request with no session', async () => {
    // It reads the policy for a USER, so running it before the session gate
    // would be both meaningless and a tenant read for an anonymous visitor —
    // the exact thing the first assertion protects.
    getSession.mockResolvedValue(null);

    await expect(AuthedLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT');
    expect(started).not.toContain('twoFactor');
  });
});
