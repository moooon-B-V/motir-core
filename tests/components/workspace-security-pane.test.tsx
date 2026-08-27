// @vitest-environment happy-dom
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Story MOTIR-1215 · Subtask MOTIR-3647 — the WORKSPACE tier's two homes.
//
// The control has two of them, because the tier is progressively disclosed
// (`docs/decisions/organization-tier.md` §6d): the standalone pane above the
// reveal threshold, and the `WorkspaceFoldInSection` mount on
// `/settings/organization` below it. Both must exist, exactly one at a time, and
// both must gate on the actor's WORKSPACE role rather than on their host's.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { resolveWorkspaceTierDisclosure } = vi.hoisted(() => ({
  resolveWorkspaceTierDisclosure: vi.fn(),
}));
const { getWorkspaceContext } = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
const { getWorkspaceSummary, listMembers, getMemberRole } = vi.hoisted(() => ({
  getWorkspaceSummary: vi.fn(),
  listMembers: vi.fn(),
  getMemberRole: vi.fn(),
}));
const { getWorkspacePolicy } = vi.hoisted(() => ({ getWorkspacePolicy: vi.fn() }));
const { notFound, redirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
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
  notFound,
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/workspace/security',
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/workspaces/tierDisclosure.server', () => ({ resolveWorkspaceTierDisclosure }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext,
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { getWorkspaceSummary, listMembers, getMemberRole },
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { getWorkspacePolicy },
}));
vi.mock('@/app/(authed)/settings/workspace/security/actions', () => ({
  setWorkspaceRequireTwoFactorAction: vi.fn(async () => ({ ok: true })),
}));

const WS = { id: 'ws_eng', name: 'Engineering' };
const UNLOCKED = {
  workspaceId: WS.id,
  requiresTwoFactor: false,
  organizationRequiresTwoFactor: false,
  organizationName: 'Acme',
  lockedByOrganization: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  resolveWorkspaceTierDisclosure.mockResolvedValue({
    activeOrgId: 'org_acme',
    workspaceCount: 2,
    revealed: true,
  });
  getWorkspaceContext.mockResolvedValue({ workspaceId: WS.id, userId: 'u1' });
  getWorkspaceSummary.mockResolvedValue({ ...WS, slug: 'engineering' });
  listMembers.mockResolvedValue([
    { userId: 'u1', name: 'Ada', email: 'ada@example.com', role: 'owner' },
    { userId: 'u2', name: 'Grace', email: 'grace@example.com', role: 'member' },
  ]);
  getMemberRole.mockResolvedValue('owner');
  getWorkspacePolicy.mockResolvedValue(UNLOCKED);
});
afterEach(cleanup);

/**
 * Invoke the async body React would render inside a `<Suspense>`, bound to its
 * props — so these tests drive the real component rather than a stand-in.
 */
function findAsyncChild(node: unknown, prop: string): (() => Promise<unknown>) | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { props?: Record<string, unknown>; type?: unknown };
  const props = el.props ?? {};
  if (typeof el.type === 'function' && prop in props) {
    const fn = el.type as (p: unknown) => Promise<unknown>;
    return () => fn(props);
  }
  const children = props['children'];
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findAsyncChild(child, prop);
    if (found) return found;
  }
  return null;
}

async function renderPane(): Promise<void> {
  const mod = await import('@/app/(authed)/settings/workspace/security/page');
  const tree = (await mod.default()) as ReactElement;
  render(<ToastProvider>{tree}</ToastProvider>);
}

async function renderPaneBody(): Promise<void> {
  const mod = await import('@/app/(authed)/settings/workspace/security/page');
  const tree = (await mod.default()) as ReactElement;
  const body = findAsyncChild(tree, 'workspaceId');
  expect(body).not.toBeNull();
  render(<ToastProvider>{(await body!()) as ReactElement}</ToastProvider>);
}

// ── HOME 1: the standalone pane ─────────────────────────────────────────────

describe('/settings/workspace/security', () => {
  it('paints its landmark heading when the tier is revealed', async () => {
    await renderPane();
    expect(screen.getByRole('heading', { name: 'Security', level: 1 })).toBeTruthy();
    expect(screen.getByText('Sign-in requirements for everyone in Engineering.')).toBeTruthy();
  });

  it('⚠️ 404s when the tier is HIDDEN — unlike /jobs, /github and /gitlab', async () => {
    // The pane is workspace-NAMED, so §6d hides it with the tier; its siblings
    // are workspace-SCOPED but not workspace-named and stay reachable. Copying
    // either neighbour blindly gets this wrong in one direction or the other.
    resolveWorkspaceTierDisclosure.mockResolvedValue({
      activeOrgId: 'org_acme',
      workspaceCount: 1,
      revealed: false,
    });
    const mod = await import('@/app/(authed)/settings/workspace/security/page');
    await expect(mod.default()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders the control for a workspace OWNER, operable', async () => {
    await renderPaneBody();
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('disabled')).toBeNull();
    expect(getWorkspacePolicy).toHaveBeenCalledWith('ws_eng', 'u1');
  });

  it('renders it LOCKED, naming the organization, when the org requires it', async () => {
    getWorkspacePolicy.mockResolvedValue({
      ...UNLOCKED,
      organizationRequiresTwoFactor: true,
      lockedByOrganization: true,
    });
    await renderPaneBody();
    expect(screen.getByRole('switch').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText('Required by Acme')).toBeTruthy();
  });

  it('redirects an anonymous request to /sign-in', async () => {
    getSession.mockResolvedValue(null);
    const mod = await import('@/app/(authed)/settings/workspace/security/page');
    await expect(mod.default()).rejects.toThrow('NEXT_REDIRECT:/sign-in');
  });
});

// ── HOME 2: the fold-in ─────────────────────────────────────────────────────

describe('the fold-in on /settings/organization', () => {
  async function renderFoldIn(): Promise<void> {
    const mod =
      await import('@/app/(authed)/settings/organization/_components/WorkspaceFoldInSection');
    const tree = (await mod.WorkspaceFoldInSection({
      workspaceId: WS.id,
      actorUserId: 'u1',
      workspaceCount: 1,
    })) as ReactElement;
    render(<ToastProvider>{tree}</ToastProvider>);
  }

  it('hosts the SAME control for a single-workspace org', async () => {
    await renderFoldIn();
    expect(screen.getByRole('switch', { name: 'Require two-factor authentication' })).toBeTruthy();
    expect(getWorkspacePolicy).toHaveBeenCalledWith('ws_eng', 'u1');
  });

  it('⚠️ gates on the actor’s WORKSPACE role, not on its host’s', async () => {
    // The host renders for ANY member — MOTIR-3519 moved the org refusal down to
    // the org-scoped cards precisely so a plain member could still reach Leave
    // workspace. A control that inherited that gate would let a `viewer` change
    // a security policy. All four `MemberRole` values, so neither direction can
    // regress unnoticed.
    for (const [role, operable] of [
      ['owner', true],
      ['admin', true],
      ['member', false],
      ['viewer', false],
    ] as const) {
      cleanup();
      getMemberRole.mockResolvedValue(role);
      await renderFoldIn();
      const sw = screen.getByRole('switch', { name: 'Require two-factor authentication' });
      expect(sw.getAttribute('disabled') === null, `role=${role}`).toBe(operable);
    }
  });

  it('renders the LOCKED state here too — the fold-in is not a lesser copy', async () => {
    // Below the reveal threshold this is the ONLY place the control exists, so a
    // locked state that rendered only on the standalone pane would be invisible
    // to exactly the single-workspace orgs that are the common case.
    getWorkspacePolicy.mockResolvedValue({
      ...UNLOCKED,
      organizationRequiresTwoFactor: true,
      lockedByOrganization: true,
    });
    await renderFoldIn();
    expect(
      screen
        .getByRole('switch', { name: 'Require two-factor authentication' })
        .getAttribute('disabled'),
    ).not.toBeNull();
    expect(screen.getByText('Required by Acme')).toBeTruthy();
  });

  it('renders NOTHING when the workspace vanished between the two reads', async () => {
    // The host's own guard: the caller resolved this workspace from the actor's
    // membership list, so a null here means it went away mid-request. Nothing to
    // host, and nothing to draw a broken card around.
    getWorkspaceSummary.mockResolvedValue(null);
    const mod =
      await import('@/app/(authed)/settings/organization/_components/WorkspaceFoldInSection');
    const tree = await mod.WorkspaceFoldInSection({
      workspaceId: WS.id,
      actorUserId: 'u1',
      workspaceCount: 1,
    });
    expect(tree).toBeNull();
  });

  it('the control is NOT drawn a second time — one component file in the tree', async () => {
    // "A MOUNT, not a rewrite." A forked copy would drift from the org tier's
    // within one card, and the locked state is the half that would drift first.
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry === 'RequireTwoFactorCard.tsx') found.push(p);
      }
    };
    walk(join(process.cwd(), 'app'));
    expect(found).toHaveLength(1);
    expect(found[0]!.endsWith('settings/organization/_components/RequireTwoFactorCard.tsx')).toBe(
      true,
    );
  });
});

// ── The org policy going on, then off ───────────────────────────────────────

describe("⚠️ the workspace's own value survives the organization's", () => {
  it('locks while the org requires it, and comes back UNCHANGED when it stops', async () => {
    // The reason MOTIR-3644 stores two columns rather than their OR. A workspace
    // that independently chose to require 2FA must still require it after the
    // organization switches its own policy off — so the lock may never overwrite
    // the stored value, only mask it.
    const withOwnValue = { ...UNLOCKED, requiresTwoFactor: true };

    getWorkspacePolicy.mockResolvedValue({
      ...withOwnValue,
      organizationRequiresTwoFactor: true,
      lockedByOrganization: true,
    });
    await renderPaneBody();
    expect(screen.getByRole('switch').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText('Required by Acme')).toBeTruthy();
    // The BOTH note, not the org-only one — the workspace's own value is still
    // being reported.
    expect(
      screen.getByText(/This workspace requires two-factor authentication, and so does Acme/),
    ).toBeTruthy();

    cleanup();
    getWorkspacePolicy.mockResolvedValue(withOwnValue);
    await renderPaneBody();
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('disabled')).toBeNull();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Required for every member of Engineering')).toBeTruthy();
  });
});
