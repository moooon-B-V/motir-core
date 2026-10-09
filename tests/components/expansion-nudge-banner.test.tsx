// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The `/ready` expansion nudge (MOTIR-904) — since story MOTIR-5266 a LAUNCHER:
// Expand opens the planning overlay over `/ready` on the stub, with the start-turn
// request (MOTIR-7973), and the banner runs no job, polls nothing and reviews
// nothing (design MOTIR-7875). The inline review, approve, decline and poll this
// file used to drive are deleted with the code that drew them.

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/ready',
  useSearchParams: () => new URLSearchParams('lane=main'),
}));

import { ExpansionNudgeBanner } from '@/app/(authed)/ready/_components/ExpansionNudgeBanner';
import { withPlanningOverlay } from '@/lib/planning/launcher';

const NUDGE = {
  nominatedKey: 'MOTIR-7',
  nominatedTitle: 'Billing',
  readyCount: 1,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => NUDGE }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cleanup();
});

describe('ExpansionNudgeBanner', () => {
  it('says what Expand will do, under the button', async () => {
    renderWithIntl(<ExpansionNudgeBanner />);
    expect(
      await screen.findByText(
        'Opens Motir AI planning on MOTIR-7. It may ask what you want planned first.',
      ),
    ).toBeTruthy();
  });

  it('Expand opens the planning overlay over the same /ready address, starting on the stub', async () => {
    renderWithIntl(<ExpansionNudgeBanner />);
    const expand = await screen.findByRole('button', { name: 'Expand' });
    fireEvent.click(expand);

    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay('/ready?lane=main', {
        kind: 'work-item',
        itemKey: 'MOTIR-7',
        startTurn: true,
      }),
    );
    // The banner has no post-Expand state: no Expanding…, no review, no error.
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve|Decline/ })).toBeNull();
    // Only the nudge read went out — Expand itself makes no request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('✕ hides the nudge for this session and makes no request', async () => {
    renderWithIntl(<ExpansionNudgeBanner />);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss expansion nudge' });
    await act(async () => {
      fireEvent.click(dismiss);
    });

    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(sessionStorage.getItem('motir_expansion_nudge_dismissed_MOTIR-7_1')).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shallowPush).not.toHaveBeenCalled();
  });
});
