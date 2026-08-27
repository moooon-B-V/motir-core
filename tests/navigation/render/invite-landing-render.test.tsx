// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferred,
  renderFirstFlush,
  renderToHtml,
  renderTree,
} from '../../helpers/serverPageHarness';

// FAMILY 2 of 5 — REPORTS + ONE-SHOTS (Story MOTIR-3440 · Task MOTIR-3568).
//
// `/invite/accept` is the family's decisive surface: MOTIR-3447 gave it the one
// FRAME OF ITS OWN in the whole story, because it is the only page reached cold
// from a mail client, and because `inspectInvite` is not a gate — all four of
// its outcomes answer 200, so the read may sit below a boundary.
//
// ⚠️ THIS FILE HOLDS THE ASSERTION THE ACCEPTANCE LANE HAD TO GIVE UP.
// `tests/e2e/acceptance-pages-stream.spec.ts` says so in its own words: "on a
// seeded item the late reads resolve before the first flush, so React renders
// the settled page in one go and no fallback ever reaches the DOM … An
// assertion that can only pass when the database is SLOW is a flake wearing a
// proof's clothes." Here the read is held open BY THE TEST, so the frame is not
// a race — it is the shell, in a string, deterministically. That is what a
// harness buys that neither a structural test nor a Playwright receipt can.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { inspectInvite } = vi.hoisted(() => ({ inspectInvite: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  redirect,
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/workspaceInvitesService', () => ({
  workspaceInvitesService: { inspectInvite },
}));

import InviteAcceptPage from '@/app/(authed)/invite/accept/page';

/** The three bodies that must never precede the real one (the E2E's own list). */
const NOT_THE_ACCEPT_CARD = ['inviteExpired', 'inviteUsed', 'signInWithInvitedEmail'];

const VALID = {
  status: 'valid' as const,
  email: 'ada@example.com',
  workspaceName: 'Acme',
  inviterName: 'Grace',
};

const search = (token?: string) => ({ searchParams: Promise.resolve(token ? { token } : {}) });

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1', email: 'Ada@Example.com' } });
  inspectInvite.mockResolvedValue(VALID);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/invite/accept — the frame is flushed, and no terminal state precedes the real one', () => {
  it('flushes the pending card while the token read is still open, with none of the four bodies in it', async () => {
    const inspect = deferred<typeof VALID>();
    inspectInvite.mockReturnValue(inspect.promise);

    const flush = await renderFirstFlush(await InviteAcceptPage(search('tok')));

    // The frame: the drawn placeholder, `aria-busy`, and nothing that names an
    // outcome. This is the negative claim the acceptance lane makes
    // non-deterministically and this file makes deterministically.
    expect(flush.shell).toContain('aria-busy="true"');
    expect(flush.shell).toContain('animate-pulse');
    for (const body of [...NOT_THE_ACCEPT_CARD, 'joinWorkspace']) {
      expect(flush.shell, `${body} must not be in the first flush`).not.toContain(body);
    }

    // …and the real outcome arrives after it, in the same response.
    inspect.resolve(VALID);
    const complete = await flush.complete();
    expect(complete).toContain('joinWorkspace');
    for (const body of NOT_THE_ACCEPT_CARD) {
      expect(complete, `${body} must never render`).not.toContain(body);
    }
  });

  it('renders the accept card for the invited reader once the read settles', async () => {
    const html = await renderToHtml(await InviteAcceptPage(search('tok')));

    expect(html).toContain('joinWorkspace');
    expect(html).toContain('invitedToCollaborate');
    // The session email is compared case-INSENSITIVELY (`Ada@Example.com` vs
    // `ada@example.com`); a regression there renders the wrong-account body,
    // which nothing reading the source would catch.
    expect(html).not.toContain('signInWithInvitedEmail');
  });
});

describe('/invite/accept — the other three bodies, each reached by its own read', () => {
  it('renders the EXPIRED body', async () => {
    inspectInvite.mockResolvedValue({ status: 'expired' });

    const html = await renderToHtml(await InviteAcceptPage(search('tok')));

    expect(html).toContain('inviteExpired');
    expect(html).not.toContain('joinWorkspace');
  });

  it('renders the USED body', async () => {
    inspectInvite.mockResolvedValue({ status: 'used' });

    const html = await renderToHtml(await InviteAcceptPage(search('tok')));

    expect(html).toContain('inviteUsed');
  });

  it('renders the WRONG-ACCOUNT body when the signed-in email is not the invited one', async () => {
    inspectInvite.mockResolvedValue({ ...VALID, email: 'grace@example.com' });

    const html = await renderToHtml(await InviteAcceptPage(search('tok')));

    expect(html).toContain('signInWithInvitedEmail');
    expect(html).not.toContain('joinWorkspace');
  });

  it('answers a MISSING token with the used body, above the boundary and with no read', async () => {
    const tree = await renderTree(InviteAcceptPage, search());

    expect(await renderToHtml(tree)).toContain('inviteUsed');
    expect(inspectInvite).not.toHaveBeenCalled();
  });

  it('bounces a signed-out visitor before it reads the token', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderTree(InviteAcceptPage, search('tok'))).rejects.toThrow('REDIRECT:/sign-in');
    expect(inspectInvite).not.toHaveBeenCalled();
  });
});
