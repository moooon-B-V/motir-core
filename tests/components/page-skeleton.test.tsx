// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import AuthedLoading from '@/app/(authed)/loading';

// MOTIR-3433 — the pending frame, and the boundary that renders it.
//
// What is worth asserting here is narrow and deliberate: this component has no
// behaviour, so a test that walks its markup would only restate it. Three
// things CAN break silently and are checked instead:
//
//   1. The REVEAL class. It is the single carrier of the 120ms delay, declared
//      once in `app/globals.css` and referenced by every boundary. Drop the
//      class and the frame paints on the click — the flicker the delay exists
//      to remove — with no type error and no visual difference in any test
//      that does not run a browser.
//   2. The ANNOUNCEMENT. `aria-busy` plus one screen-reader label for the whole
//      region, with the placeholder blocks hidden. Losing the `aria-hidden`
//      would read eight rows of nothing to a screen reader.
//   3. The COMPOSITION seam. `children` is what lets a route-shaped boundary
//      inherit the wrapper, header and reveal instead of copying them
//      (MOTIR-3435 uses it). If it stopped being honoured, the next nearer
//      boundary would quietly go back to copying.

afterEach(cleanup);

describe('PageSkeleton (MOTIR-3433)', () => {
  it('carries the shared reveal class, so the 120ms delay is never re-declared per boundary', () => {
    const { container } = renderWithIntl(<PageSkeleton />);
    const frame = container.querySelector('[data-testid="page-skeleton"]');
    expect(frame).not.toBeNull();
    // Both classes matter: `nav-pending-reveal` is the delay, `nav-pending-frame`
    // is what the reduced-motion rule keys off to stop the pulse.
    expect(frame!.className).toContain('nav-pending-reveal');
    expect(frame!.className).toContain('nav-pending-frame');
  });

  it('announces the region ONCE and hides the decorative blocks', () => {
    const { container } = renderWithIntl(<PageSkeleton />);
    const frame = container.querySelector('[data-testid="page-skeleton"]')!;
    expect(frame.getAttribute('aria-busy')).toBe('true');
    // Exactly one label, from the real catalog — not one per block.
    expect(screen.getByText('Loading page')).toBeTruthy();
    const pulse = container.querySelector('.animate-pulse')!;
    expect(pulse.getAttribute('aria-hidden')).toBe('true');
  });

  it('adds NO horizontal gutter — the authed layout wrapper already pays it', () => {
    // A frame that re-applied `px-*` would double the gutter at every
    // breakpoint, because it renders inside the layout's own padded wrapper.
    const { container } = renderWithIntl(<PageSkeleton />);
    const frame = container.querySelector('[data-testid="page-skeleton"]')!;
    expect(frame.className).not.toMatch(/(^|\s)p[xlr]?-/);
    expect(frame.className).toContain('gap-6');
  });

  it('renders the generic body by default and the caller’s body when given one', () => {
    const { container: withDefault } = renderWithIntl(<PageSkeleton />);
    // The generic body is the bordered region: a header band plus eight rows.
    expect(withDefault.querySelectorAll('.rounded-\\(--radius-card\\)').length).toBe(1);

    cleanup();

    const { container: withChild } = renderWithIntl(
      <PageSkeleton>
        <div data-testid="route-shaped-body" />
      </PageSkeleton>,
    );
    expect(withChild.querySelector('[data-testid="route-shaped-body"]')).not.toBeNull();
    // The route's body REPLACES the generic one rather than joining it.
    expect(withChild.querySelectorAll('.rounded-\\(--radius-card\\)').length).toBe(0);
    // …while the three inherited parts are still the primitive's.
    const frame = withChild.querySelector('[data-testid="page-skeleton"]')!;
    expect(frame.className).toContain('nav-pending-reveal');
    expect(frame.querySelector('header')).not.toBeNull();
  });

  it('drops the subtitle block when a route says its page has none', () => {
    const { container: withSub } = renderWithIntl(<PageSkeleton />);
    expect(withSub.querySelector('header')!.children.length).toBe(2);
    cleanup();
    const { container: noSub } = renderWithIntl(<PageSkeleton subtitle={false} />);
    expect(noSub.querySelector('header')!.children.length).toBe(1);
  });
});

describe('app/(authed)/loading.tsx (MOTIR-3433)', () => {
  it('renders the shared PageSkeleton, so all 58 routes inherit one frame', () => {
    const { container } = renderWithIntl(<AuthedLoading />);
    const frame = container.querySelector('[data-testid="page-skeleton"]');
    expect(frame).not.toBeNull();
    expect(frame!.className).toContain('nav-pending-reveal');
  });
});
