// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  PortRenderStatusProvider,
  type PortRenderReporter,
  type PortRenderStatus,
} from '@/components/approvals/portRenderStatus';
import type { DesignAssetDTO, DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// WHAT THE DESIGN PORT REPORTS TO THE APPROVAL FRAME (Story MOTIR-4778 ·
// Subtask MOTIR-5032).
//
// The FRAME's half of state `X` — that no verbs render when the port has not
// rendered — is `approval-gate-port.test.tsx`. This is the PORT's half: whether
// `DesignResultPanel` tells the truth about itself. They are separate files
// because they can fail independently, and because this one needs the panel's
// evidence fixtures while that one needs the frame's gate fixtures.
//
// `design-result-panel.test.tsx` is deliberately NOT touched — it pins the
// panel's own rendering, which this card does not change.

const { DesignResultPanel } =
  await import('@/app/(authed)/items/[key]/_components/DesignResultPanel');

function asset(p: Partial<DesignAssetDTO> & { kind: DesignAssetDTO['kind'] }): DesignAssetDTO {
  return {
    id: `a-${p.kind}-${p.position ?? 0}`,
    url: `/api/attachments/att-${p.kind}/content`,
    mimeType: p.kind === 'image' ? 'image/png' : 'text/html',
    sizeBytes: 2048,
    sourcePath: `design/work-items/design-result.${p.kind === 'image' ? 'png' : 'mock.html'}`,
    position: 0,
    ...p,
  };
}

function evidence(p: Partial<DesignEvidenceDTO> = {}): DesignEvidenceDTO {
  return {
    id: 'ev-1',
    workItemId: 'wi-1',
    noteMd: '## The Design result panel\n\nProse the reviewer reads.',
    noteTruncated: false,
    assets: [asset({ kind: 'mock' })],
    commitSha: 'cafe1234567',
    ciRunUrl: 'https://ci.example/run/9',
    producedByKey: 'MOTIR-2669',
    createdAt: '2026-08-11T00:00:00.000Z',
    withdrawnAt: null,
    withdrawnById: null,
    withdrawnReason: null,
    ...p,
  };
}

/**
 * Renders the panel where the frame would, and collects what it reports.
 * `latest()` is the AGGREGATE the frame would gate on, computed the same way.
 */
function renderReporting(ui: React.ReactElement) {
  const reports = new Map<string, PortRenderStatus>();
  const reporter: PortRenderReporter = {
    report(id, status) {
      if (status === null) reports.delete(id);
      else reports.set(id, status);
    },
  };
  const result = renderWithIntl(
    <PortRenderStatusProvider reporter={reporter}>{ui}</PortRenderStatusProvider>,
  );
  return {
    ...result,
    latest(): PortRenderStatus {
      const values = [...reports.values()];
      if (values.includes('failed')) return 'failed';
      if (values.includes('rendering')) return 'rendering';
      return 'rendered';
    },
  };
}

const probe = vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 }));
beforeEach(() => {
  probe.mockResolvedValue({ type: 'opaqueredirect', ok: false, status: 0 });
  vi.stubGlobal('fetch', probe);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the probe TIMEOUT — the third outcome `fetch` cannot give you', () => {
  it('reports FAILED when the probe never settles', async () => {
    // `fetch` settles or rejects; it does not report "still nothing". Before
    // this card that left the frame at `loading` for ever — harmless while the
    // panel was read-only, and a decision nobody can ever make once the verbs
    // are gated on it.
    vi.useFakeTimers();
    probe.mockReturnValueOnce(new Promise(() => {}) as never);

    const { latest } = renderReporting(<DesignResultPanel evidence={evidence()} isDesignCard />);
    expect(latest()).toBe('rendering');

    // Wrapped in `act` because a timer callback is not act-wrapped the way
    // `fireEvent` is (tests/helpers/actEnvironment.ts's contract).
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(latest()).toBe('failed');
    expect(screen.getByText('The mock could not be loaded')).toBeTruthy();
  });

  it('does NOT fire the timeout once the probe has settled', async () => {
    vi.useFakeTimers();
    const { latest } = renderReporting(<DesignResultPanel evidence={evidence()} isDesignCard />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(latest()).toBe('rendered');

    // ⚠️ THIS ASSERTION FOUND A REAL DEFECT, so it is worth saying what it
    // pins. A successful probe does not re-run the effect, so a timer cleared
    // ONLY in the effect's cleanup stays armed over an already-loaded frame and
    // fires `'failed'` ten seconds later — retracting a rendered port and
    // taking the verbs away from a reader looking straight at its subject. The
    // probe now disarms the timer in BOTH settle arms.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(latest()).toBe('rendered');
  });
});

describe('the SUBJECT the resolver returned as unavailable', () => {
  it('reports FAILED when there is no evidence at all', () => {
    const { latest } = renderReporting(<DesignResultPanel evidence={null} isDesignCard />);
    expect(latest()).toBe('failed');
    // The panel's own read-only answer is unchanged — this is a good state to
    // SHOW and a bad one to leave a live Approve button in.
    expect(screen.getByText('No design result published yet')).toBeTruthy();
  });

  it('reports FAILED for an evidence row with no note and not one asset carrying a URL', () => {
    // The reclaimed-blob case: the rows survive with their `sourcePath` and the
    // bytes are gone, so there is nothing in band 2 to look at. This is the arm
    // `MockFrame` cannot answer — the panel filters a url-less mock out before
    // it ever renders one.
    const { latest } = renderReporting(
      <DesignResultPanel
        evidence={evidence({
          noteMd: null,
          assets: [asset({ kind: 'mock', url: null }), asset({ kind: 'image', url: null })],
        })}
        isDesignCard
      />,
    );
    expect(latest()).toBe('failed');
  });

  it('reports RENDERED for a note-only result — no mock to probe, nothing to fail', async () => {
    const { latest } = renderReporting(
      <DesignResultPanel evidence={evidence({ assets: [] })} isDesignCard />,
    );
    await waitFor(() => expect(latest()).toBe('rendered'));
  });
});

describe('the probe FAILING is reported, not only drawn', () => {
  it('reports FAILED on an explicit bad status', async () => {
    probe.mockResolvedValueOnce({ type: 'basic', ok: false, status: 404 } as never);
    const { latest } = renderReporting(<DesignResultPanel evidence={evidence()} isDesignCard />);
    await waitFor(() => expect(latest()).toBe('failed'));
  });

  it('reports FAILED when the probe rejects', async () => {
    probe.mockRejectedValueOnce(new Error('offline'));
    const { latest } = renderReporting(<DesignResultPanel evidence={evidence()} isDesignCard />);
    await waitFor(() => expect(latest()).toBe('failed'));
  });

  it('reports RENDERED on the 302 the content route actually returns', async () => {
    const { latest } = renderReporting(<DesignResultPanel evidence={evidence()} isDesignCard />);
    await waitFor(() => expect(latest()).toBe('rendered'));
  });
});
