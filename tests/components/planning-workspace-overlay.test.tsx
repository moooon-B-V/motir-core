// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { withoutPlanningOverlay } from '@/lib/planning/launcher';

// THE PLANNING WORKSPACE OVERLAY (MOTIR-4729, under story MOTIR-4725).
//
// What this file holds in place is not "a dialog renders" — it is the four
// properties the story is FOR, each of which fails silently:
//
//   · the open state is the ADDRESS and nothing else, so Back closes it and no
//     second source of truth can disagree with the address bar;
//   · closing writes the four overlay parameters away and leaves every host
//     parameter byte-identical, with `shallowPush` — because the page underneath
//     must not unmount;
//   · the anchor read degrades to the project conversation, never to an error;
//   · the gates the ROUTE ran on the server still run, from the shell's own
//     provider rather than from a prop.

// The address, mutable — this IS the component's input.
let params = new URLSearchParams();
let pathname = '/backlog';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));

// The actor's permission set — the shell's provider, which is the whole reason
// the overlay needs no `canManage` prop.
let granted = new Set<string>(['project:browse']);
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => granted.has(key) }),
}));

// The host has its OWN suite. Here it stands in for itself so every assertion is
// about the OVERLAY's decision to mount it, and with what.
//
// ⚠️ The stub carries a per-MOUNT id, seeded in a `useState` initializer — the
// same mechanism the real host seeds its three props with, which is exactly what
// the keyed-remount contract is about. Counting RENDERS instead would report a
// remount on every re-render and prove nothing.
let mountSeq = 0;
/** Stands in for "the host has a pending proposal and raised its guard". */
let vetoClose = false;
vi.mock('@/components/planning/PlanningWorkspaceHost', () => ({
  PlanningWorkspaceHost: ({
    launch,
    anchorId,
    canManage,
    initialTarget,
    initialCanvasTrail,
    onClose,
    closeGuardRef,
    onKeepPlanningAfterBack,
  }: {
    launch: { mode: string; from: string; itemKey: string | null };
    anchorId: string | null;
    canManage?: boolean;
    initialTarget?: { identifier: string } | null;
    initialCanvasTrail?: readonly { id: string }[];
    onClose?: () => void;
    closeGuardRef?: { current: (() => boolean) | null };
    onKeepPlanningAfterBack?: () => void;
  }) => {
    const [mountId] = useState(() => ++mountSeq);
    // The host registers the close VETO (MOTIR-4731). `vetoClose` lets a test
    // stand in for "there is a pending proposal" without a conversation.
    useEffect(() => {
      if (!closeGuardRef) return;
      closeGuardRef.current = () => !vetoClose;
      return () => {
        closeGuardRef.current = null;
      };
    });
    return (
      <div
        data-testid="host"
        data-mount={String(mountId)}
        data-mode={launch.mode}
        data-from={launch.from}
        data-anchor-id={anchorId ?? ''}
        data-target={initialTarget?.identifier ?? ''}
        data-trail={(initialCanvasTrail ?? []).map((c) => c.id).join(',')}
        data-can-manage={String(canManage ?? false)}
      >
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" onClick={onKeepPlanningAfterBack}>
          Keep planning
        </button>
      </div>
    );
  },
}));

vi.mock('@/components/planning/PlanningWorkspaceSkeleton', () => ({
  PlanningWorkspaceSkeleton: () => <div data-testid="skeleton" />,
  PlanningCanvasSkeleton: () => <div />,
}));

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');

const ANCHOR = {
  anchor: { id: 'wi_7', identifier: 'MOTIR-7', title: 'The anchor', kind: 'subtask' as const },
  ancestors: [
    { id: 'wi_1', identifier: 'MOTIR-1', title: 'Epic 8' },
    { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story' },
  ],
};

beforeEach(() => {
  params = new URLSearchParams();
  pathname = '/backlog';
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  fetchPlanningAnchor.mockReset();
  fetchPlanningAnchor.mockResolvedValue(ANCHOR);
  granted = new Set(['project:browse']);
  mountSeq = 0;
  vetoClose = false;
});
afterEach(cleanup);

function mount(over: { onboardingRanAt?: string | null } = {}) {
  return render(
    <PlanningWorkspaceOverlay
      projectKey="ACME"
      projectName="Acme"
      onboardingRanAt={
        'onboardingRanAt' in over ? (over.onboardingRanAt ?? null) : '2026-01-01T00:00:00.000Z'
      }
    />,
  );
}

/** Put the overlay in the address, as a door's `shallowPush` would. */
function openAt(search: string, path = '/backlog') {
  pathname = path;
  params = new URLSearchParams(search);
}

describe('the OPEN state is the address, and nothing else', () => {
  it('mounts NOTHING when the address does not carry the overlay', async () => {
    openAt('filter=type%3Acode');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('mounts NOTHING for the ROUTE era address — that is the forward’s job', async () => {
    openAt('mode=project&from=project');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
  });

  it('renders the workspace inside a dialog on ANY authed route', async () => {
    for (const path of ['/backlog', '/boards', '/items/MOTIR-9', '/home']) {
      openAt('plan=project&planFrom=project', path);
      const view = mount();
      await act(async () => {});

      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByTestId('host').getAttribute('data-mode')).toBe('project');
      view.unmount();
    }
  });

  it('carries the launch through — mode and origin both', async () => {
    openAt('plan=replan&planFrom=roadmap');
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('replan');
    expect(host.getAttribute('data-from')).toBe('roadmap');
  });
});

describe('closing writes the address, and only the address', () => {
  it('strips exactly the four overlay parameters and keeps the host’s', async () => {
    openAt('filter=type%3Acode&sort=rank&plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(shallowPush).toHaveBeenCalledTimes(1);
    const written = shallowPush.mock.calls[0]![0] as string;
    expect(written).toBe('/backlog?filter=type%3Acode&sort=rank');
    // …and it is exactly what the launcher's own stripper produces, so the two
    // cannot drift.
    expect(written).toBe(
      withoutPlanningOverlay('/backlog?filter=type%3Acode&sort=rank&plan=project&planFrom=project'),
    );
  });

  it('keeps the roadmap’s drilled level and the quick view', async () => {
    openAt('item=MOTIR-12&plan=replan&planFrom=roadmap', '/roadmap');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(shallowPush).toHaveBeenCalledWith('/roadmap?item=MOTIR-12');
  });

  it('NEVER navigates — the page underneath must not unmount', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Escape reaches the same one close', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});

    expect(shallowPush).toHaveBeenCalledWith('/backlog');
  });

  it('a history pop that drops the parameters closes it with NO second write', async () => {
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});
    expect(screen.getByTestId('host')).toBeTruthy();

    // Back: the address changes under the component, exactly as Next syncs
    // `useSearchParams` with a `popstate`.
    params = new URLSearchParams('');
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    // The pop already happened; writing again would push a second entry and make
    // Back need two presses.
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('returns focus to the door that opened it', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Plan with AI';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams('');
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('the ANCHOR read', () => {
  it('is not made at all for a project launch', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
    expect(screen.getByTestId('host').getAttribute('data-anchor-id')).toBe('');
  });

  it('shows the skeleton until it settles, then seeds all three from it', async () => {
    let settle: (v: typeof ANCHOR) => void = () => {};
    fetchPlanningAnchor.mockReturnValue(
      new Promise<typeof ANCHOR>((resolve) => {
        settle = resolve;
      }),
    );
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-7');
    mount();
    await act(async () => {});

    expect(screen.getByTestId('skeleton')).toBeTruthy();
    expect(screen.queryByTestId('host')).toBeNull();

    await act(async () => {
      settle(ANCHOR);
    });

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-anchor-id')).toBe('wi_7');
    expect(host.getAttribute('data-target')).toBe('MOTIR-7');
    // ANCESTORS ONLY — the last crumb is the level the canvas loads, so the
    // workspace opens on the anchor's OWN level, not inside it.
    expect(host.getAttribute('data-trail')).toBe('wi_1,wi_3');
    expect(fetchPlanningAnchor).toHaveBeenCalledTimes(1);
    expect(fetchPlanningAnchor.mock.calls[0]![0]).toBe('MOTIR-7');
  });

  it('a 404 opens the PROJECT conversation at the root, with no error surface', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-99999');
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-anchor-id')).toBe('');
    expect(host.getAttribute('data-target')).toBe('');
    expect(host.getAttribute('data-trail')).toBe('');
    // Never a dead workspace and never an error panel inside a planning surface.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a thrown read degrades the same way — an outage is not an error panel', async () => {
    fetchPlanningAnchor.mockRejectedValue(new Error('502'));
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-7');
    mount();
    await act(async () => {});

    expect(screen.getByTestId('host').getAttribute('data-anchor-id')).toBe('');
  });

  it('a DIFFERENT anchor remounts the host; the same one does not', async () => {
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-7');
    const view = mount();
    await act(async () => {});
    const firstMount = screen.getByTestId('host').getAttribute('data-mount');
    expect(firstMount).toBeTruthy();

    // An approve's `router.refresh()` re-renders with the SAME address. The host
    // seeds three things in `useState` initializers, so a remount here would
    // throw away the conversation and the canvas's drill state.
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-mount')).toBe(firstMount);

    // Re-targeting from inside the workspace IS a different workspace.
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_8', identifier: 'MOTIR-8', title: 'Another', kind: 'subtask' as const },
      ancestors: [],
    });
    params = new URLSearchParams('plan=contextual&planFrom=work-item&planItem=MOTIR-8');
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    expect(screen.getByTestId('host').getAttribute('data-mount')).not.toBe(firstMount);
    expect(screen.getByTestId('host').getAttribute('data-anchor-id')).toBe('wi_8');
  });
});

describe('the GATES the route ran on the server', () => {
  it('a viewer who cannot browse gets the statement, not a workspace', async () => {
    granted = new Set();
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    // The statement is IN the dialog — the page underneath is still usable, and
    // there is no route to 404.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /access/i })).toBeTruthy();
  });

  it('a never-onboarded project forwards, and mounts nothing', async () => {
    openAt('plan=project&planFrom=project');
    mount({ onboardingRanAt: null });
    await act(async () => {});

    expect(push).toHaveBeenCalledWith('/onboarding');
    expect(screen.queryByTestId('host')).toBeNull();
  });

  it('does not forward when the overlay is closed', async () => {
    openAt('filter=type%3Acode');
    mount({ onboardingRanAt: null });
    await act(async () => {});

    expect(push).not.toHaveBeenCalled();
  });

  it('gates the audit banner on the permission the SERVER gate asserts, with no prop', async () => {
    // `auditCoverageService.getCoverage` asserts `ai:configure` — so that, and
    // not a rank, is what decides whether the banner is an invitation or a 403.
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-can-manage')).toBe('false');
    view.unmount();

    granted = new Set(['project:browse', 'ai:configure']);
    mount();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-can-manage')).toBe('true');
  });
});

describe('the host may VETO a close (the pending guard’s seam, MOTIR-4731)', () => {
  it('writes nothing when the host refuses', async () => {
    vetoClose = true;
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // The address is untouched, so the workspace is still open and the guard —
    // rendered by the host — is what the reader is answering.
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.getByTestId('host')).toBeTruthy();
  });

  it('HOLDS the workspace up after a browser Back the host refuses', async () => {
    vetoClose = true;
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    // Back: the browser has already navigated by the time `popstate` fires, so
    // the overlay reads an address that no longer carries it.
    window.history.pushState(null, '', '/backlog');
    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    // Still mounted — the guard needs a workspace to ask over.
    expect(screen.getByTestId('host')).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('KEEP PLANNING after a Back puts the address back, with ONE write', async () => {
    vetoClose = true;
    openAt('plan=replan&planFrom=roadmap', '/roadmap');
    const view = mount();
    await act(async () => {});

    window.history.pushState(null, '', '/roadmap');
    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));

    // ONE `shallowPush`, so Back means what it says again rather than needing
    // two presses.
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush.mock.calls[0]![0]).toBe('/roadmap?plan=roadmap&planFrom=roadmap');
  });

  it('a Back the host ALLOWS just closes — no hold, no write', async () => {
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('coverage · Keep planning after a Back, for every launch shape', () => {
  // `launchContext` turns a parsed launch back into the context the re-push
  // needs. Each origin is its own arm, and only the reader who goes Back on that
  // kind of launch reaches it — so each is driven.
  const CASES = [
    {
      name: 'a work-item launch',
      search: 'plan=replan&planFrom=work-item&planItem=MOTIR-7',
      path: '/items/MOTIR-7',
      expected: '/items/MOTIR-7?plan=replan&planFrom=work-item&planItem=MOTIR-7',
    },
    {
      name: 'a convention-refine launch',
      search: 'plan=contextual&planFrom=convention-refine&planRepo=motir-core',
      path: '/code-health',
      expected: '/code-health?plan=contextual&planFrom=convention-refine&planRepo=motir-core',
    },
    {
      name: 'a roadmap launch',
      search: 'plan=roadmap&planFrom=roadmap',
      path: '/roadmap',
      expected: '/roadmap?plan=roadmap&planFrom=roadmap',
    },
    {
      name: 'a project re-plan',
      search: 'plan=replan&planFrom=project',
      path: '/backlog',
      expected: '/backlog?plan=replan&planFrom=project',
    },
  ];

  it.each(CASES)('re-pushes $name unchanged', async ({ search, path, expected }) => {
    vetoClose = true;
    openAt(search, path);
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay
        projectKey="ACME"
        projectName="Acme"
        onboardingRanAt="2026-01-01T00:00:00.000Z"
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));

    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush.mock.calls[0]![0]).toBe(expected);
  });

  it('is a no-op when there was no Back to answer', async () => {
    // *Keep planning* is also what Esc and the scrim mean on the guard. On those
    // vectors the address never changed, so there is nothing to put back — and
    // pushing anyway would add a history entry Back would then have to eat.
    vetoClose = true;
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));
    expect(shallowPush).not.toHaveBeenCalled();
  });
});
