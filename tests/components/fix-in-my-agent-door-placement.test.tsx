// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE ITEM PAGE'S PLACEMENT OF THE SHARED CONTROL (Story MOTIR-8981 · MOTIR-9057) —
// `FixInMyAgentDoor` draws the control only where the provider mounts a door, and hands
// the provider's `notifyRunsChanged` to both of the control's callbacks.

const provider = vi.hoisted(() => ({
  value: null as null | { itemKey: string; viewerId: string; notifyRunsChanged: () => void },
}));
vi.mock('@/app/(authed)/items/[key]/_components/HostedRunProvider', () => ({
  useHostedRun: () => provider.value,
}));

import { FixInMyAgentDoor } from '@/app/(authed)/items/[key]/_components/FixInMyAgentDoor';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  provider.value = null;
});

describe('FixInMyAgentDoor', () => {
  it('draws nothing and reads nothing where no door is mounted', async () => {
    renderWithIntl(<FixInMyAgentDoor />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fix-my-agent-control')).toBeNull();
  });

  it('reads the provider’s card and notifies the provider when a stale press moves the state', async () => {
    const notifyRunsChanged = vi.fn();
    provider.value = { itemKey: 'PROD-7', viewerId: 'u1', notifyRunsChanged };
    const offered = {
      offered: true,
      agent: {
        id: 'ag1',
        name: 'yue-claude',
        profileId: 'claude',
        profileName: 'Claude Code',
        state: 'running',
      },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => offered });
    renderWithIntl(<FixInMyAgentDoor />);
    await act(async () => {});
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/work-items/PROD-7/fix-in-my-agent');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'agent_run_repair_refused',
        claim: { outcome: 'not_repairable', reason: 'not_failing' },
      }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => offered });
    await act(async () => {
      screen.getByTestId('fix-my-agent').click();
    });
    expect(notifyRunsChanged).toHaveBeenCalledTimes(1);
  });
});
