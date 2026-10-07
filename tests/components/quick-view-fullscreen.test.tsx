// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';

// MOTIR-7658 — the canvas quick view in NATIVE full screen.
//
// While an element is in native full screen the browser paints only that
// element's subtree; a dialog portalled to <body> opens invisibly and still holds
// focus and scroll lock. Every canvas consumer renders its quick view as a SIBLING
// of the canvas (`useWorkItemQuickView`, `PlanReviewCanvas`), so the harness below
// does too, and the dialog has to find its way INTO the full-screen canvas root on
// its own.
//
// happy-dom has no Fullscreen API, so it is stubbed: `requestFullscreen` makes its
// element `document.fullscreenElement` and fires `fullscreenchange`, as a browser
// does. Without the fix the dialog mounts on <body> and the first test fails.

const nav = vi.hoisted(() => ({ pathname: '/roadmap', searchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

const level: RoadmapLevel = {
  nodes: [
    {
      id: 'V',
      parentId: null,
      searchText: 'View me',
      crumbLabel: 'MOTIR-12',
      drillable: false,
      viewable: true,
      content: <div>View me</div>,
    },
  ],
  deps: [],
};

function Harness() {
  const [peekKey, setPeekKey] = useState<string | null>(null);
  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        onView={() => setPeekKey('MOTIR-12')}
        fullScreenable
      />
      <WorkItemQuickView peekKey={peekKey} onClose={() => setPeekKey(null)} />
    </>
  );
}

let fullscreenElement: Element | null = null;

function setFullscreen(el: Element | null): Promise<void> {
  fullscreenElement = el;
  document.dispatchEvent(new Event('fullscreenchange'));
  return Promise.resolve();
}

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = function (
    this: Element,
  ) {
    return setFullscreen(this);
  };
  (document as unknown as { exitFullscreen: unknown }).exitFullscreen = () => setFullscreen(null);
  // The peek's read never resolves: the frame and its skeleton are what is asserted.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
  delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
});

async function openPeek() {
  fireEvent.keyDown(document.querySelector('[data-node-id="V"]')!, { key: 'Enter' });
  fireEvent.click(await screen.findByTestId('view-button'));
  return screen.findByRole('dialog');
}

describe('the canvas quick view in native full screen (MOTIR-7658)', () => {
  it('mounts inside the full-screen canvas root, and closes without leaving full screen', async () => {
    render(<Harness />);
    await screen.findByText('View me');
    const canvas = screen.getByTestId('roadmap-canvas');

    await act(async () => {
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
    });
    expect(document.fullscreenElement).toBe(canvas);

    const dialog = await openPeek();
    expect(canvas.contains(dialog)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.fullscreenElement).toBe(canvas);
    expect(canvas.getAttribute('data-fullscreen')).toBe('true');
  });

  it('Esc closes the quick view only, and a second Esc leaves full screen', async () => {
    render(<Harness />);
    await screen.findByText('View me');
    const canvas = screen.getByTestId('roadmap-canvas');
    await act(async () => {
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
    });
    await openPeek();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(canvas.getAttribute('data-fullscreen')).toBe('true');

    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(canvas.hasAttribute('data-fullscreen')).toBe(false);
    expect(document.fullscreenElement).toBeNull();
  });

  it('outside full screen, still portals to <body>, outside the canvas', async () => {
    render(<Harness />);
    await screen.findByText('View me');
    const canvas = screen.getByTestId('roadmap-canvas');

    const dialog = await openPeek();
    expect(canvas.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
