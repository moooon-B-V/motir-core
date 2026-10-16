// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useHoldReaderPlace } from '../../app/(authed)/workbench/_components/useHoldReaderPlace';

// THE READER'S PLACE ON A BURST (Story MOTIR-8542 · Subtask MOTIR-8731;
// design-notes § 39 rule 3).
//
// happy-dom lays nothing out, so this file supplies the one piece of layout the
// rule is about: each row is ROW_H tall, stacked in DOM order inside a scroller
// whose `scrollTop` the browser would move. `getBoundingClientRect().top` is then
// exactly what a real page reports — the row's offset minus the scroll — and the
// assertion is the design's: the row the reader was looking at keeps its
// on-screen top when several rows land above it.

const ROW_H = 44;
let scrollTop = 0;
let scrollBy: ReturnType<typeof vi.fn>;

function List({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useHoldReaderPlace(ref, ids.join(','));
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div ref={ref}>
        {ids.map((id) => (
          <div key={id} data-testid={`workbench-row-${id}`} />
        ))}
      </div>
    </div>
  );
}

function topOf(id: string): number {
  return document.querySelector(`[data-testid="workbench-row-${id}"]`)!.getBoundingClientRect().top;
}

beforeEach(() => {
  scrollTop = 0;
  scrollBy = vi.fn((_x: number, y: number) => {
    scrollTop += y;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const testid = this.dataset.testid ?? '';
    if (!testid.startsWith('workbench-row-')) return new DOMRect(0, 0, 800, 600);
    const index = [...this.parentElement!.children].indexOf(this);
    return new DOMRect(0, index * ROW_H - scrollTop, 800, ROW_H);
  });
  // The scroller: scrollable, and its scroll position is the test's variable.
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(10_000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => scrollTop);
  proto.scrollBy = scrollBy;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollBy;
});

const BEFORE = ['a10', 'a09', 'a08', 'a07', 'a06', 'a05', 'a04', 'a03', 'a02', 'a01'];
const ARRIVED = ['n6', 'n5', 'n4', 'n3', 'n2', 'n1'];

async function scrollTo(y: number) {
  scrollTop = y;
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
}

describe('useHoldReaderPlace', () => {
  it('keeps the row in view at the same on-screen top when six rows land above it', async () => {
    const view = render(<List ids={BEFORE} />);
    // The reader has scrolled to row a05 (index 5).
    await scrollTo(5 * ROW_H);
    const before = topOf('a05');
    expect(before).toBe(0);

    // The catch-up: six arrivals at the top (`updatedAt desc`), in one apply.
    view.rerender(<List ids={[...ARRIVED, ...BEFORE]} />);

    expect(topOf('a05')).toBe(before);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith(0, ARRIVED.length * ROW_H);
  });

  it('moves nothing when rows are appended below the reader (To approve, createdAt asc)', async () => {
    const view = render(<List ids={BEFORE} />);
    await scrollTo(3 * ROW_H);
    const before = topOf('a07');

    view.rerender(<List ids={[...BEFORE, 'z1', 'z2', 'z3']} />);

    expect(topOf('a07')).toBe(before);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('leaves the top of the list where it is when the reader has not scrolled', async () => {
    const view = render(<List ids={BEFORE} />);
    await scrollTo(0);

    view.rerender(<List ids={[...ARRIVED, ...BEFORE]} />);

    // § 26 Panel 1: at the top, the arrivals ARE what the reader sees first.
    expect(scrollBy).not.toHaveBeenCalled();
    expect(topOf('n6')).toBe(0);
  });

  it('follows the reader: the place is re-measured after they scroll', async () => {
    const view = render(<List ids={BEFORE} />);
    await scrollTo(2 * ROW_H);
    await scrollTo(7 * ROW_H);
    const before = topOf('a03');

    view.rerender(<List ids={['n1', 'n2', ...BEFORE]} />);

    expect(topOf('a03')).toBe(before);
  });
});
