// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { DesignAssetDTO, DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// DesignResultPanel (Story MOTIR-2664 · Subtask MOTIR-2670) — the three states
// the design draws, rendered in happy-dom. The panel is READ-ONLY, so there is
// no action to mock: what is under test is its branching, the frame's security
// posture, and that the note goes through the one shipped Markdown renderer.

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
    assets: [asset({ kind: 'mock' }), asset({ kind: 'image', position: 1 })],
    commitSha: 'cafe1234567',
    ciRunUrl: 'https://ci.example/run/9',
    producedByKey: 'MOTIR-2669',
    createdAt: '2026-08-11T00:00:00.000Z',
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
  it('reads as "this predates the feature", never as an error', () => {
    render(<DesignResultPanel evidence={null} isDesignCard />);

    expect(screen.getByText('No design result published yet')).toBeTruthy();
    // It says where a result comes from, so nobody hunts for an upload control.
    expect(screen.getByText(/runs CI/)).toBeTruthy();
    expect(screen.getByText(/Nothing to upload/)).toBeTruthy();
    // Not an error surface: no retry, no warning.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('tells a NON-design card the same thing in its own words', () => {
    render(<DesignResultPanel evidence={null} isDesignCard={false} />);
    expect(screen.getByText('No design result published yet')).toBeTruthy();
    expect(screen.queryByText(/Nothing to upload/)).toBeNull();
  });
});

describe('the published panel', () => {
  it('renders the note through the shipped Markdown renderer', async () => {
    const { container } = await renderReady(
      <DesignResultPanel evidence={evidence()} isDesignCard />,
    );

    // A real heading element, not the raw `## …` source — i.e. it went through
    // a Markdown render, and the `markdown-body` class is the shipped path's.
    expect(screen.getByRole('heading', { name: 'The Design result panel' })).toBeTruthy();
    expect(container.querySelector('.markdown-body')).toBeTruthy();
    expect(screen.queryByText(/^## /)).toBeNull();
  });

  it('shows the provenance the publish recorded', async () => {
    await renderReady(<DesignResultPanel evidence={evidence()} isDesignCard />);
    expect(screen.getByText('cafe123')).toBeTruthy(); // short sha
    expect(screen.getByRole('link', { name: /CI run/ }).getAttribute('href')).toBe(
      'https://ci.example/run/9',
    );
    expect(screen.getByText('MOTIR-2669')).toBeTruthy();
  });

  it('renders the truncation notice and a link to the complete note ONLY when truncated', () => {
    const { container, unmount } = render(<DesignResultPanel evidence={evidence()} isDesignCard />);
    expect(container.textContent).not.toContain('Shown in part');
    unmount();

    render(
      <DesignResultPanel
        evidence={evidence({
          noteTruncated: true,
          assets: [
            asset({ kind: 'mock' }),
            asset({
              kind: 'note_file',
              position: 2,
              sourcePath: 'design/work-items/design-notes.md',
            }),
          ],
        })}
        isDesignCard
      />,
    );
    expect(screen.getByText(/Shown in part/)).toBeTruthy();
    // The escape hatch points at the file that carries the WHOLE text.
    expect(
      screen.getByRole('link', { name: /Download design-notes/ }).getAttribute('href'),
    ).toContain('download=1');
  });

  it('renders a MINIMAL result — no note, no provenance — without empty chrome', async () => {
    // A PR that changed only a mock publishes exactly that. The panel must not
    // render an empty note block or a provenance row of blank chips.
    const { container } = await renderReady(
      <DesignResultPanel
        evidence={evidence({
          noteMd: null,
          commitSha: null,
          ciRunUrl: null,
          producedByKey: null,
          assets: [asset({ kind: 'mock' })],
        })}
        isDesignCard
      />,
    );

    expect(container.querySelector('.markdown-body')).toBeNull();
    expect(screen.queryByRole('link', { name: /CI run/ })).toBeNull();
    expect(screen.queryByText('Screenshot')).toBeNull();
    // The frame — the one thing that WAS published — is still there.
    expect(container.querySelector('iframe')).toBeTruthy();
  });

  it('renders the truncation notice without a download link when the note file is gone', async () => {
    // The inline copy is truncated but the `note_file` blob has been GC-reclaimed:
    // say so, and do not offer a link to nothing.
    await renderReady(
      <DesignResultPanel
        evidence={evidence({
          noteTruncated: true,
          assets: [asset({ kind: 'mock' }), asset({ kind: 'note_file', url: null, position: 2 })],
        })}
        isDesignCard
      />,
    );
    expect(screen.getByText(/Shown in part/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Download design-notes/ })).toBeNull();
  });

  it('skips a screenshot whose blob has been GC-reclaimed', async () => {
    await renderReady(
      <DesignResultPanel
        evidence={evidence({
          assets: [asset({ kind: 'mock' }), asset({ kind: 'image', url: null, position: 1 })],
        })}
        isDesignCard
      />,
    );
    expect(screen.queryByText('Screenshot')).toBeNull();
  });

  it('is READ-ONLY — it exposes no control that writes', async () => {
    await renderReady(<DesignResultPanel evidence={evidence()} isDesignCard />);
    // The only buttons are the screenshot thumbnails (which open the lightbox).
    // Approve / request-changes belong to the runtime gate, not here.
    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent).not.toMatch(/approve|request|publish|delete/i);
    }
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
    expect(screen.getByRole('heading', { name: 'The Design result panel' })).toBeTruthy();
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

describe('the screenshot', () => {
  it('opens in the shipped lightbox rather than a second image viewer', async () => {
    await renderReady(<DesignResultPanel evidence={evidence()} isDesignCard />);

    const thumb = screen.getByRole('button', { name: /design-result\.png/ });
    fireEvent.click(thumb);

    // The lightbox is the shipped AttachmentPreview: a dialog carrying the
    // filename and its own download control.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText('design-result.png').length).toBeGreaterThan(0);
  });

  it('survives an unmount while the probe is in flight, and a sizeless image', async () => {
    let settle: (v: unknown) => void = () => {};
    probe.mockReturnValueOnce(new Promise((r) => (settle = r)) as never);
    const { unmount } = render(<DesignResultPanel evidence={evidence()} isDesignCard />);
    unmount();
    // Settling AFTER unmount must not set state on a gone component.
    settle({ type: 'opaqueredirect', ok: false, status: 0 });

    await renderReady(
      <DesignResultPanel
        evidence={evidence({
          assets: [asset({ kind: 'mock' }), asset({ kind: 'image', sizeBytes: null, position: 1 })],
        })}
        isDesignCard
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /design-result\.png/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows no screenshot section when the result carries no image', () => {
    render(
      <DesignResultPanel evidence={evidence({ assets: [asset({ kind: 'mock' })] })} isDesignCard />,
    );
    expect(screen.queryByText('Screenshot')).toBeNull();
  });
});
