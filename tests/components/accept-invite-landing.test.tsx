// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// MOTIR-5132 — ACCEPTING AN INVITE IS A CONTEXT SWITCH, and it used to answer
// "where does a reader land" for itself, with `router.push('/dashboard')`.
//
// It calls the SAME server action the workspace switcher calls
// (`switchWorkspaceAction`), and then bypassed `afterContextSwitchTarget`
// entirely — so the product had three answers to one question at once:
// `/workbench` on sign-in, `/items` on a switch, `/dashboard` here. This is the
// third one's regression test. The assertion composes from AUTHED_LANDING_PATH
// rather than naming a route, for the reason the whole card exists.
//
// The SECOND half of the criterion — "and does so via the shared helper, a
// literal in that file fails" — is a property of the SOURCE rather than of a
// render, because a component could push the right string for the wrong reason
// and pass a behavioural test for ever. The last `it` reads the file, and the
// landing guard's fifth scan defends the same axis across the whole tree.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
let pathnameValue = '/invite/accept';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathnameValue,
}));

const { switchWorkspaceAction } = vi.hoisted(() => ({
  switchWorkspaceAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_actions', () => ({
  switchWorkspaceAction,
  createWorkspaceAction: vi.fn(async () => undefined),
}));

import { AcceptInviteButton } from '@/app/(authed)/invite/accept/AcceptInviteButton';

const WORKSPACE_ID = 'ws_joined';

function acceptOk() {
  return Promise.resolve({
    ok: true,
    json: async () => ({ workspaceId: WORKSPACE_ID }),
  } as unknown as Response);
}

function accept() {
  fireEvent.click(screen.getByRole('button', { name: 'Accept invite' }));
}

beforeEach(() => {
  pathnameValue = '/invite/accept';
  vi.stubGlobal('fetch', vi.fn(acceptOk));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
  refresh.mockClear();
  switchWorkspaceAction.mockClear();
});

describe('AcceptInviteButton — where accepting an invite lands (MOTIR-5132)', () => {
  it('switches to the joined workspace and lands on the signed-in landing', async () => {
    renderWithIntl(<AcceptInviteButton token="tok_1" />);
    accept();

    await waitFor(() => expect(switchWorkspaceAction).toHaveBeenCalledWith(WORKSPACE_ID));
    await waitFor(() => expect(push).toHaveBeenCalledWith(AUTHED_LANDING_PATH));
  });

  it('does NOT land on /dashboard — the third answer this card retired', () => {
    renderWithIntl(<AcceptInviteButton token="tok_1" />);
    accept();

    return waitFor(() => {
      expect(push).toHaveBeenCalled();
      expect(push).not.toHaveBeenCalledWith('/dashboard');
    });
  });

  it('refreshes in place, with no push, when the reader is already on the landing', async () => {
    // Unreachable from `/invite/accept` today, and asserted anyway: the null
    // branch is the OTHER half of the helper's contract, and this site now
    // honours it like the other four callers rather than pushing regardless.
    pathnameValue = AUTHED_LANDING_PATH;
    renderWithIntl(<AcceptInviteButton token="tok_1" />);
    accept();

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it('neither switches nor navigates when the accept call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as unknown as Response),
    );
    renderWithIntl(<AcceptInviteButton token="tok_1" />);
    accept();

    await waitFor(() =>
      expect(screen.getByText('This invite could not be accepted. Refresh to see details.')),
    );
    expect(switchWorkspaceAction).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('resolves its destination through the shared helper — a route literal here fails', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'app', '(authed)', 'invite', 'accept', 'AcceptInviteButton.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    expect(source).toContain('afterContextSwitchTarget(pathname)');
    // Any quoted path OTHER than the `/api/…` endpoint it POSTs to. The
    // exclusion is the same one the landing guard's fifth scan makes, and for
    // the same reason: nobody LANDS on an API route.
    const routes = [...source.matchAll(/(['"`])(\/[A-Za-z][\w-]*(?:\/[\w-]+)*)\1/g)]
      .map((m) => m[2] ?? '')
      .filter((path) => !path.startsWith('/api'));
    expect(routes, 'this file must name no destination of its own').toEqual([]);
  });
});
