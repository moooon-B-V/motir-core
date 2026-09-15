// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { DesignAssetDTO, DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// DesignResultPanel (Story MOTIR-2664 · Subtask MOTIR-2670; redrawn as WHAT TO
// REVIEW by Story MOTIR-5488 · MOTIR-5498, design
// `design/work-items/design-result--what-to-review.mock.html`) rendered in
// happy-dom. The panel is READ-ONLY, so there is no action to mock: what is under
// test is its branching, the frame's security posture, and that the note is a
// LINK — never rendered inline — with no screenshot strip.

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

/** A new-format result's one note file (AMENDMENT 4). */
const NOTE = asset({
  kind: 'note_file',
  position: 1,
  url: '/api/attachments/att-note/content',
  mimeType: 'text/markdown',
  sourcePath: 'design/work-items/design-notes.md',
});

/** An EARLIER-format result: inline note + a screenshot, as stored before AMENDMENT 4. */
function olderEvidence(p: Partial<DesignEvidenceDTO> = {}): DesignEvidenceDTO {
  return evidence({
    noteMd: '## The Design result panel\n\nProse the reviewer read inline.',
    assets: [asset({ kind: 'mock' }), asset({ kind: 'image', position: 1 }), NOTE],
    ...p,
  });
}

function evidence(p: Partial<DesignEvidenceDTO> = {}): DesignEvidenceDTO {
  return {
    id: 'ev-1',
    workItemId: 'wi-1',
    noteMd: null,
    noteTruncated: false,
    assets: [asset({ kind: 'mock' }), NOTE],
    commitSha: 'cafe1234567',
    ciRunUrl: 'https://ci.example/run/9',
    producedByKey: 'MOTIR-2669',
    createdAt: '2026-08-11T00:00:00.000Z',
    // A row the panel can render is by definition not withdrawn (MOTIR-3215):
    // a withdrawal clears `is_current`, so `getCurrentForWorkItem` returns null
    // and the panel takes its empty branch instead of this one.
    withdrawnAt: null,
    withdrawnById: null,
    withdrawnReason: null,
    ...p,
  };
}

// The frame PROBES its content URL before rendering (an iframe never fires
// `error` for an HTTP error response — the browser renders the error body
// inside it — so the failure state has to be reached some other way).
const probe = vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 }));
beforeEach(() => {
  probe.mockResolvedValue({ type: 'opaqueredirect', ok: false, status: 0 });
  vi.stubGlobal('fetch', probe);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Render and let the frame's probe settle. */
async function renderReady(ui: Parameters<typeof render>[0]) {
  const out = render(ui);
  await waitFor(() => expect(out.container.querySelector('iframe')).toBeTruthy());
  return out;
}

describe('nothing published yet', () => {
  it('says a result is published only when work waits on the design', () => {
    render(<DesignResultPanel evidence={null} isDesignCard />);

    expect(screen.getByText('No design result published yet')).toBeTruthy();
    // AMENDMENT 4 Q2: an empty panel is often CORRECT, so the copy says when a
    // result exists and where an un-waited-on design is reviewed instead.
    expect(screen.getByText(/only when other work waits on this design/)).toBeTruthy();
    expect(screen.getByText(/the pull request is where the design is reviewed/)).toBeTruthy();
    // No retired three-file detail and no screenshot.
    expect(screen.queryByText(/screenshot/i)).toBeNull();
    expect(screen.queryByText(/runs CI/)).toBeNull();
    // Not an error surface: no retry, no warning.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('tells a NON-design card the same thing in its own words', () => {
    render(<DesignResultPanel evidence={null} isDesignCard={false} />);
    expect(screen.getByText('No design result published yet')).toBeTruthy();
    expect(screen.getByText(/the agent working this work item publishes it/)).toBeTruthy();
    expect(screen.queryByText(/only when other work waits/)).toBeNull();
  });
});

describe('a current result — what to review', () => {
  it('leads with the mock and puts the note ONE LINK away, under it', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard />,
    );

    const noteLink = screen.getByRole('link', { name: /Open note/ });
    expect(noteLink.getAttribute('href')).toBe('/api/attachments/att-note/content');
    expect(noteLink.getAttribute('target')).toBe('_blank');
    expect(noteLink.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('design/work-items/design-notes.md')).toBeTruthy();

    // The mock comes FIRST: the frame precedes the note row in document order.
    const frame = container.querySelector('iframe')!;
    expect(frame.compareDocumentPosition(noteLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders NO inline Markdown and NO image', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard />,
    );
    expect(container.querySelector('.motir-prose')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByText('Earlier format')).toBeNull();
    expect(screen.queryByText(/mocks — the panels that changed/)).toBeNull();
  });

  it('stacks SEVERAL mocks with a count line above them and still ONE note row', async () => {
    const { container } = await renderReady(
      <DesignResultPanel
        evidence={evidence({
          assets: [
            asset({ kind: 'mock', id: 'm1' }),
            asset({
              kind: 'mock',
              id: 'm2',
              position: 1,
              sourcePath: 'design/workbench/approval-overlay.mock.html',
            }),
            NOTE,
          ],
        })}
        isDesignCard
      />,
    );
    await waitFor(() => expect(container.querySelectorAll('iframe')).toHaveLength(2));
    expect(screen.getByText('2 mocks — the panels that changed')).toBeTruthy();
    expect(screen.getByText('design/workbench/approval-overlay.mock.html')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Open note/ })).toHaveLength(1);
  });

  it('keeps the note row when its file is reclaimed, with no link that 404s', async () => {
    await renderReady(
      <DesignResultPanel
        evidence={evidence({ assets: [asset({ kind: 'mock' }), { ...NOTE, url: null }] })}
        isDesignCard
      />,
    );
    expect(screen.getByText('design/work-items/design-notes.md')).toBeTruthy();
    expect(screen.getByText('No longer stored')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open note/ })).toBeNull();
  });

  it('shows the provenance the publish recorded', async () => {
    await renderReady(<DesignResultPanel evidence={evidence()} isDesignCard />);
    expect(screen.getByText('cafe123')).toBeTruthy(); // short sha
    expect(screen.getByRole('link', { name: /CI run/ }).getAttribute('href')).toBe(
      'https://ci.example/run/9',
    );
    expect(screen.getByText('MOTIR-2669')).toBeTruthy();
  });

  it('renders a MINIMAL result — no provenance — without empty chrome', async () => {
    const { container } = await renderReady(
      <DesignResultPanel
        evidence={evidence({ commitSha: null, ciRunUrl: null, producedByKey: null })}
        isDesignCard
      />,
    );
    expect(screen.queryByRole('link', { name: /CI run/ })).toBeNull();
    expect(container.querySelector('iframe')).toBeTruthy();
  });

  it('is READ-ONLY — it exposes no control that writes', async () => {
    await renderReady(<DesignResultPanel evidence={evidence()} isDesignCard />);
    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent).not.toMatch(/approve|request|publish|delete/i);
    }
  });
});

describe('an EARLIER-format result', () => {
  it('lists its note and screenshots as FILE links — nothing inline', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={olderEvidence()} isDesignCard />,
    );

    expect(screen.getByText('Earlier format')).toBeTruthy();
    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open note/ })).toBeTruthy();
    const screenshot = screen.getByRole('link', { name: /Open file/ });
    expect(screenshot.getAttribute('href')).toBe('/api/attachments/att-image/content');
    expect(screenshot.getAttribute('target')).toBe('_blank');
    // No rendered Markdown, no thumbnail, no lightbox.
    expect(container.querySelector('.motir-prose')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'The Design result panel' })).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Its mock still renders in the frame.
    expect(container.querySelector('iframe')).toBeTruthy();
  });

  it('renders two screenshots as two file rows, and a reclaimed one says so', async () => {
    await renderReady(
      <DesignResultPanel
        evidence={olderEvidence({
          assets: [
            asset({ kind: 'mock' }),
            asset({ kind: 'image', id: 'i1', position: 1 }),
            asset({ kind: 'image', id: 'i2', position: 2, url: null }),
            NOTE,
          ],
        })}
        isDesignCard
      />,
    );
    expect(screen.getAllByText('Screenshot')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /Open file/ })).toHaveLength(1);
    expect(screen.getByText('No longer stored')).toBeTruthy();
  });
});

describe('inside the Development block (Q8)', () => {
  it('renders as the SLOT: its own heading, a one-line provenance, no chips', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard placement="development" />,
    );
    const slot = screen.getByRole('group', { name: 'Design result' });
    expect(slot.querySelector('h4')!.textContent).toBe('Design result');
    expect(slot.textContent).toContain('Published by MOTIR-2669');
    expect(slot.textContent).toContain('cafe123');
    // The section's chips are not drawn in the slot.
    expect(screen.queryByRole('link', { name: /CI run/ })).toBeNull();
    // The same frame and note link.
    expect(slot.contains(container.querySelector('iframe'))).toBe(true);
    expect(screen.getByRole('link', { name: /Open note/ })).toBeTruthy();
  });
});

describe('the mock frame', () => {
  it('is SANDBOXED with neither allow-scripts nor allow-same-origin', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard />,
    );
    const frame = container.querySelector('iframe')!;

    // The whole safety of rendering repository HTML to a signed-in user. The
    // two attributes that make an iframe convenient are the two that make it
    // dangerous, and nothing in a shipped mock needs either.
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('loads through the AUTHENTICATED content route, never a raw blob URL', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard />,
    );
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/api/attachments/att-mock/content');
  });

  it('carries an accessible title naming the mock, and an open-in-new-tab escape', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard />,
    );
    expect(container.querySelector('iframe')!.getAttribute('title')).toContain(
      'design-result.mock.html',
    );

    const openLink = screen.getByRole('link', { name: /Open in new tab/ });
    expect(openLink.getAttribute('href')).toBe('/api/attachments/att-mock/content');
    expect(openLink.getAttribute('target')).toBe('_blank');
    expect(openLink.getAttribute('rel')).toContain('noopener');
  });

  it('shows a loading state until the probe settles', async () => {
    let settle: (v: unknown) => void = () => {};
    probe.mockReturnValueOnce(new Promise((r) => (settle = r)) as never);

    const { container } = render(<DesignResultPanel evidence={evidence()} isDesignCard />);
    expect(screen.getByRole('status').textContent).toContain('Loading the mock');
    expect(container.querySelector('iframe')).toBeNull();

    settle({ type: 'opaqueredirect', ok: false, status: 0 });
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
  });

  it('offers a retry when the content is unreachable, and keeps the note readable', async () => {
    probe.mockResolvedValueOnce({ type: 'basic', ok: false, status: 404 } as never);

    const { container } = render(<DesignResultPanel evidence={evidence()} isDesignCard />);

    await waitFor(() => expect(screen.getByText('The mock could not be loaded')).toBeTruthy());
    expect(container.querySelector('iframe')).toBeNull();
    // Never a blank rectangle, and the rest of the panel survives the failure.
    expect(screen.getByRole('link', { name: /Open note/ })).toBeTruthy();
    // The escape still works while the frame is down.
    expect(screen.getByRole('link', { name: /Open in new tab/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    expect(screen.queryByText('The mock could not be loaded')).toBeNull();
  });

  it('shows the failure when the probe REJECTS, not only on a bad status', async () => {
    probe.mockRejectedValueOnce(new Error('offline'));
    render(<DesignResultPanel evidence={evidence()} isDesignCard />);
    await waitFor(() => expect(screen.getByText('The mock could not be loaded')).toBeTruthy());
  });

  it('renders one frame per published mock', async () => {
    const { container } = await renderReady(
      <DesignResultPanel
        evidence={evidence({
          assets: [
            asset({ kind: 'mock', id: 'm1' }),
            asset({ kind: 'mock', id: 'm2', position: 1 }),
          ],
        })}
        isDesignCard
      />,
    );
    await waitFor(() => expect(container.querySelectorAll('iframe')).toHaveLength(2));
  });

  it('renders no frame when the mock blob has been GC-reclaimed', () => {
    const { container } = render(
      <DesignResultPanel
        evidence={evidence({ assets: [asset({ kind: 'mock', url: null })] })}
        isDesignCard
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('an unmount while the probe is in flight', () => {
  it('sets no state on a gone component', async () => {
    let settle: (v: unknown) => void = () => {};
    probe.mockReturnValueOnce(new Promise((r) => (settle = r)) as never);
    const { unmount } = render(<DesignResultPanel evidence={evidence()} isDesignCard />);
    unmount();
    settle({ type: 'opaqueredirect', ok: false, status: 0 });
    await renderReady(<DesignResultPanel evidence={evidence()} isDesignCard />);
  });
});

describe('the edges a reader rarely meets', () => {
  it('the slot drops the separator when only a sha — or nothing — was recorded', () => {
    const { unmount } = render(
      <DesignResultPanel
        evidence={evidence({ producedByKey: null, assets: [NOTE] })}
        isDesignCard
        placement="development"
      />,
    );
    const slot = screen.getByRole('group', { name: 'Design result' });
    expect(slot.textContent).toContain('cafe123');
    expect(slot.textContent).not.toContain('Published by');
    expect(slot.textContent).not.toContain(' · ');
    unmount();

    render(
      <DesignResultPanel
        evidence={evidence({ producedByKey: null, commitSha: null, assets: [NOTE] })}
        isDesignCard
        placement="development"
      />,
    );
    const bare = screen.getByRole('group', { name: 'Design result' });
    expect(bare.querySelector('h4 + span')).toBeNull();
  });

  it('a new result whose mock is reclaimed still offers its note, with no frame above it', () => {
    const { container } = render(
      <DesignResultPanel
        evidence={evidence({ assets: [asset({ kind: 'mock', url: null }), NOTE] })}
        isDesignCard
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('link', { name: /Open note/ })).toBeTruthy();
  });
});
