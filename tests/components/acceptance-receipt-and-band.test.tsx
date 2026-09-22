// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';

// THE SHARED PIECES THE ACCEPTANCE GATE COMPOSES (Story MOTIR-4949 · Subtasks MOTIR-4950 /
// MOTIR-5790), in happy-dom: the RECEIPT player the story page and the overlay both render,
// and the call-to-action BAND the design and acceptance sections share. The navigation is
// the one mock — the band's whole job is to push the overlay's address.

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-20',
  useSearchParams: () => new URLSearchParams('tab=activity'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush }));

const { AcceptanceReceiptPlayer, AcceptanceReceiptProvenance } =
  await import('@/components/acceptance/AcceptanceReceiptPlayer');
const { GateCallToActionBand } = await import('@/components/approvals/GateCallToActionBand');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RECEIPT: AcceptanceEvidenceDTO = {
  id: 'ae-1',
  workItemId: 'wi-1',
  status: 'pending',
  videoUrl: 'https://blob.example/run.webm',
  mimeType: 'video/webm',
  sizeBytes: 1024,
  traceUrl: 'https://blob.example/trace.zip',
  chapters: [
    { label: 'Open the story', tSeconds: 0 },
    { label: 'Approve and merge', tSeconds: 75 },
  ],
  commitSha: 'c0ffee1234',
  ciRunUrl: 'https://ci.example/run/1',
  producedByKey: 'ACME-24',
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-09-19T14:40:00.000Z',
};

describe('the receipt player (MOTIR-4950)', () => {
  it('scrubs to a chapter and changes the playback speed on the video it holds', () => {
    const { container } = render(<AcceptanceReceiptPlayer evidence={RECEIPT} />);
    const video = container.querySelector('video')!;

    fireEvent.click(screen.getByRole('button', { name: /Approve and merge/ }));
    expect(video.currentTime).toBe(75);
    // m:ss, as the chapter list prints it.
    expect(screen.getByText('1:15')).toBeTruthy();

    const fast = screen.getByRole('button', { name: '2×' });
    fireEvent.click(fast);
    expect(video.playbackRate).toBe(2);
    expect(fast.getAttribute('aria-pressed')).toBe('true');
  });

  it('sizes the video by WIDTH by default, and by the VIEWPORT inside the overlay (MOTIR-6042)', () => {
    // The item page scrolls as a whole, so the default keeps the column-wide 16:9 video.
    const page = render(<AcceptanceReceiptPlayer evidence={RECEIPT} />);
    expect(page.container.querySelector('video')!.className).toContain('w-full');
    expect(page.container.querySelector('video')!.className).not.toContain('100dvh');
    page.unmount();

    // The overlay's port is height-bounded: the width is capped by the viewport's height,
    // so the whole video — and its native controls — is on screen without scrolling. The
    // speed row and the chapters still drive THIS video.
    const { container } = render(<AcceptanceReceiptPlayer evidence={RECEIPT} fit="viewport" />);
    const video = container.querySelector('video')!;
    expect(video.className).toContain('w-[min(100%,calc((100dvh-17rem)*16/9))]');
    expect(video.className).toContain('aspect-video');
    expect(video.parentElement!.className).toContain('bg-black');
    fireEvent.click(screen.getByRole('button', { name: /Approve and merge/ }));
    expect(video.currentTime).toBe(75);
    fireEvent.click(screen.getByRole('button', { name: '1.5×' }));
    expect(video.playbackRate).toBe(1.5);
  });

  it('a BARE receipt — no video yet, no chapters, no trace, no CI run — renders without them', () => {
    // The publish path allows each of these to be absent (a clip whose blob was reclaimed,
    // a run with no chapters, a keyless publish), so the port must not assume any of them.
    const bare: AcceptanceEvidenceDTO = {
      ...RECEIPT,
      videoUrl: null,
      chapters: [],
      traceUrl: null,
      ciRunUrl: null,
      commitSha: null,
      producedByKey: null,
    };
    const { container } = render(
      <>
        <AcceptanceReceiptPlayer evidence={bare} />
        <AcceptanceReceiptProvenance evidence={bare} />
      </>,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    // The speed row is still there: it is the player's own control, not the clip's.
    expect(screen.getByRole('button', { name: '1×' })).toBeTruthy();
  });

  it('names where the recording came from — the commit, the CI run, the trace and the recording card', () => {
    render(<AcceptanceReceiptProvenance evidence={RECEIPT} />);
    expect(screen.getByText('c0ffee1')).toBeTruthy();
    expect(screen.getByText('ACME-24')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});

describe('the call-to-action band (MOTIR-5790) — a door into the overlay, never a verb', () => {
  const band = (routedElsewhereName: string | null = null) =>
    render(
      <GateCallToActionBand
        kind="acceptance_result"
        subjectLabel="recorded at c0ffee12"
        askedAt="2026-09-19T14:40:00.000Z"
        itemIdentifier="ACME-20"
        routedElsewhereName={routedElsewhereName}
      />,
    );

  it('a plain click pushes the overlay address for THIS kind, keeping the page it opened over', () => {
    band();
    const door = screen.getByRole('link', { name: /review & approve/i });
    expect(door.getAttribute('href')).toBe(
      '/items/ACME-20?tab=activity&approval=ACME-20&approvalKind=acceptance_result',
    );
    fireEvent.click(door);
    expect(shallowPush).toHaveBeenCalledWith(door.getAttribute('href'));
  });

  it('a MODIFIED click keeps its native meaning — a new tab — and pushes nothing', () => {
    band();
    fireEvent.click(screen.getByRole('link', { name: /review & approve/i }), { metaKey: true });
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('says who the question is routed to when that is somebody else', () => {
    band('Ada L.');
    expect(screen.getByText('Ada L.')).toBeTruthy();
  });
});
