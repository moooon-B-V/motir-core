// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Story MOTIR-1215 · Subtask MOTIR-3646 — the org Security PANE, and the org
// menu's door onto it.
//
// ⚠️ THIS IS THE STORY'S FIRST NEW ROUTE, SO IT LANDS THE SMOKE. A whole class
// of server/client-boundary defect is invisible to `tsc`, to a production build
// and to a component test: a bad import, a `server-only` module dragged into a
// client file, an export that moved. It only shows when something actually
// LOADS the page. So this file renders the route — not a component in isolation
// — and asserts a landmark from it. Every later card in Story 8.13 then has an
// instrument that opens the surface.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { resolveActiveOrganization } = vi.hoisted(() => ({
  resolveActiveOrganization: vi.fn(),
}));
const { getOrganizationPolicy } = vi.hoisted(() => ({ getOrganizationPolicy: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/organization/security',
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'org_acme' }) }),
}));
// `getTranslations` is next-intl's SERVER entry, and under happy-dom next-intl
// resolves to its client build ("not supported in Client Components"). Bind a
// synchronous translator over the REAL `en` catalogue instead of stubbing the
// key back — the assertions below are on production English, so a stub would
// make them assert nothing.
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  // Loosely typed on purpose: the real `getTranslations` is generic over the
  // catalogue's namespace keys, and a mock that reproduced that signature would
  // be asserting next-intl's types rather than this page's behaviour.
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/services/organizationsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/organizationsService')>()),
  organizationsService: { resolveActiveOrganization },
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { getOrganizationPolicy },
}));
// The Server Action the page hands the card. Importing the real module pulls
// `next/cache` into a unit render; the page's contract is that it PASSES this
// down, which the card's own suite covers.
vi.mock('@/app/(authed)/settings/organization/security/actions', () => ({
  setOrganizationRequireTwoFactorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/app/(authed)/_actions', () => ({
  switchOrganizationAction: vi.fn(async () => undefined),
  createOrganizationAction: vi.fn(async () => undefined),
  createWorkspaceAction: vi.fn(async () => undefined),
}));

const ORG = { id: 'org_acme', name: 'Acme', slug: 'acme' };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  resolveActiveOrganization.mockResolvedValue({ organization: ORG, role: 'owner' });
  getOrganizationPolicy.mockResolvedValue({
    organizationId: ORG.id,
    requiresTwoFactor: false,
  });
});
afterEach(cleanup);

/** Render the real page module's output. */
async function renderPage(): Promise<void> {
  const mod = await import('@/app/(authed)/settings/organization/security/page');
  const tree = (await mod.default()) as ReactElement;
  render(<ToastProvider>{tree}</ToastProvider>);
}

describe('the /settings/organization/security route renders', () => {
  it('paints its landmark heading for an org owner', async () => {
    await renderPage();
    // The landmark. It lives ABOVE the Suspense boundary, which is the whole
    // reason the pane needs no `loading.tsx`: the title is a constant and the
    // subtitle interpolates a name the gate already resolved.
    expect(screen.getByRole('heading', { name: 'Security', level: 1 })).toBeTruthy();
    expect(screen.getByText('Sign-in requirements for everyone in Acme.')).toBeTruthy();
  });

  it('paints the same landmark for an org ADMIN', async () => {
    resolveActiveOrganization.mockResolvedValue({ organization: ORG, role: 'admin' });
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Security', level: 1 })).toBeTruthy();
  });

  it('⚠️ refuses a plain member with a WHOLE-PANE refusal, header and all', async () => {
    // A DIFFERENT rule from its parent's. `settings/organization/page.tsx` gates
    // per SECTION (MOTIR-3519) because that page hosts workspace-scoped sections
    // below the tier-reveal threshold. This pane hosts nothing but org-scoped
    // controls, so it refuses the way `members/` and `usage/` do — one
    // EmptyState, no header above it.
    resolveActiveOrganization.mockResolvedValue({ organization: ORG, role: 'member' });
    await renderPage();

    expect(screen.queryByRole('heading', { name: 'Security', level: 1 })).toBeNull();
    expect(screen.getByText('Organization settings are admin-only')).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to/i }).getAttribute('href')).toBe('/dashboard');
  });

  it('shows the no-active-org state when none resolves', async () => {
    resolveActiveOrganization.mockResolvedValue(null);
    await renderPage();
    expect(screen.queryByRole('heading', { name: 'Security', level: 1 })).toBeNull();
    expect(screen.getByText('No organization')).toBeTruthy();
  });

  it('redirects an anonymous request to /sign-in', async () => {
    getSession.mockResolvedValue(null);
    const mod = await import('@/app/(authed)/settings/organization/security/page');
    await expect(mod.default()).rejects.toThrow('NEXT_REDIRECT:/sign-in');
  });

  it('reads the policy through twoFactorPolicyService, for the resolved org and actor', async () => {
    await renderPage();
    // The body is the Suspense child, so awaiting the page does not run it —
    // call it the way React would and assert the read it makes.
    const mod = await import('@/app/(authed)/settings/organization/security/page');
    const tree = (await mod.default()) as ReactElement;
    // Walk to the Suspense child and invoke it.
    const body = findSuspenseChild(tree);
    expect(body).not.toBeNull();
    render(<ToastProvider>{(await body!()) as ReactElement}</ToastProvider>);

    expect(getOrganizationPolicy).toHaveBeenCalledWith('org_acme', 'u1');
    expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not required').length).toBeGreaterThan(0);
  });
});

/**
 * The async function React would render inside the page's `<Suspense>`, already
 * bound to its props — so the test drives the real body rather than a stand-in.
 */
function findSuspenseChild(node: unknown): (() => Promise<unknown>) | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { props?: Record<string, unknown>; type?: unknown };
  const props = el.props ?? {};
  const children = props['children'];
  if (typeof el.type === 'function' && typeof props === 'object' && 'organizationId' in props) {
    const fn = el.type as (p: unknown) => Promise<unknown>;
    return () => fn(props);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findSuspenseChild(child);
    if (found) return found;
  }
  return null;
}

// ── The DOOR ────────────────────────────────────────────────────────────────
// A route with no door is not shipped, and this is the half that gets left for
// later and then never happens.

describe('the org menu carries the door onto it', () => {
  it('renders a Security row linking to /settings/organization/security', async () => {
    const { OrgControl } = await import('@/app/(authed)/_components/OrgControl');
    render(
      <ToastProvider>
        <OrgControl
          activeOrg={{ id: 'org_acme', name: 'Acme', role: 'owner' }}
          orgs={[{ id: 'org_acme', name: 'Acme', slug: 'acme', acceptanceVideoEnabled: true }]}
          cloudBilling={false}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));

    const row = await screen.findByRole('link', { name: 'Security' });
    expect(row.getAttribute('href')).toBe('/settings/organization/security');
  });

  it('sits directly under Settings, where the design puts it', async () => {
    // Position is part of the design, not a detail: it is a settings-shaped
    // destination, and keeping it above Members holds the two account-level
    // concerns together (design/org-admin/security-policy panel 1).
    const { OrgControl } = await import('@/app/(authed)/_components/OrgControl');
    render(
      <ToastProvider>
        <OrgControl
          activeOrg={{ id: 'org_acme', name: 'Acme', role: 'owner' }}
          orgs={[{ id: 'org_acme', name: 'Acme', slug: 'acme', acceptanceVideoEnabled: true }]}
          cloudBilling={false}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));

    const hrefs = (await screen.findAllByRole('link')).map((a) => a.getAttribute('href'));
    expect(hrefs.slice(0, 3)).toEqual([
      '/settings/organization',
      '/settings/organization/security',
      '/settings/organization/members',
    ]);
  });
});
