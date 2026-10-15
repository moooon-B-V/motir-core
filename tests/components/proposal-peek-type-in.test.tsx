// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { TYPEWRITER_CAP_MS } from '@/lib/planning/typeIn';

// FIELDS TYPE THEMSELVES IN (Story MOTIR-8590 · Subtask MOTIR-8595; design
// `design/ai-planning/design-notes.md` Part XXVIII §28.6 Table C, §28.7).
//
// The proposal quick view on the overlay, while the plan is written: a field that
// was unwritten when the quick view opened types in when it arrives; everything
// else shows at once. Driven with faked frames and a faked clock so a partial
// frame is observed deterministically, never raced.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { ProposalPeek } from '@/components/planning/ProposalPeek';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';

const BODY =
  'The planner wrote this description while the reader watched, one character after another.';

const ADD = planReviewItem({
  planItemId: 'pi_add',
  nodeId: 'pi_add',
  title: 'A card being written',
  descriptionMd: null,
  explanationMd: null,
  priority: null,
});
const WITH = (over: Partial<PlanReviewItemDto>) => ({ ...ADD, ...over });

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('reduce') ? reduced : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeFrames() {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date', 'setTimeout'],
  });
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function peek(item: PlanReviewItemDto | null, live = true) {
  return <ProposalPeek item={item} live={live} onClose={() => {}} />;
}

const field = (name: string) => screen.queryByTestId(`quick-view-typein-${name}`);
const phase = (name: string) => field(name)?.getAttribute('data-typewriter') ?? null;
const copyText = (name: string) =>
  field(name)?.querySelector('[data-typewriter-copy]')?.textContent ?? '';

describe('a field unwritten at open types in when it arrives', () => {
  it('shows part of the text before the cap, all of it after, never longer (AC 1, 7)', async () => {
    fakeFrames();
    const r = render(peek(ADD));
    expect(phase('descriptionMd')).toBe('waiting');
    expect(screen.getByText('No description yet.')).toBeTruthy();

    r.rerender(peek(WITH({ descriptionMd: BODY })));
    expect(phase('descriptionMd')).toBe('typing');
    await advance(TYPEWRITER_CAP_MS / 3);
    const partial = copyText('descriptionMd');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(BODY.length);
    expect(BODY.startsWith(partial)).toBe(true);

    // AT: the animating copy is hidden; the final value is present exactly once.
    const box = field('descriptionMd')!;
    const copy = box.querySelector('[data-typewriter-copy]')!;
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.querySelector('[data-typewriter-caret]')).not.toBeNull();
    const finalEl = box.firstElementChild!;
    expect(finalEl.className).toContain('sr-only');
    expect(finalEl.textContent).toBe(BODY);
    expect(box.querySelector('[aria-live]')).toBeNull();

    await advance(TYPEWRITER_CAP_MS);
    expect(phase('descriptionMd')).toBe('final');
    expect(box.firstElementChild).toBe(finalEl);
    expect(finalEl.className).not.toContain('sr-only');
    expect(box.querySelector('[data-typewriter-copy]')).toBeNull();
    expect(within(box).getByText(BODY)).toBeTruthy();
  });

  it('several arrive at once: one after another in reading order (title → description → explanation)', async () => {
    fakeFrames();
    const r = render(peek(WITH({ title: '' })));
    r.rerender(peek(WITH({ title: 'Now named', descriptionMd: BODY, explanationMd: 'Why.' })));
    expect(phase('title')).toBe('typing');
    expect(phase('descriptionMd')).toBe('waiting');
    expect(phase('explanationMd')).toBe('waiting');
    // A queued field shows the shipped empty treatment meanwhile.
    expect(screen.getByText('No description yet.')).toBeTruthy();
    await advance(TYPEWRITER_CAP_MS + 50);
    expect(phase('title')).toBe('final');
    expect(phase('descriptionMd')).toBe('typing');
    await advance(TYPEWRITER_CAP_MS + 50);
    expect(phase('explanationMd')).toBe('typing');
    await advance(TYPEWRITER_CAP_MS + 50);
    expect(phase('explanationMd')).toBe('final');
  });

  it('a field typed once and then changed jumps to the new value (AC 3)', async () => {
    fakeFrames();
    const r = render(peek(ADD));
    r.rerender(peek(WITH({ descriptionMd: BODY })));
    await advance(TYPEWRITER_CAP_MS / 3);
    r.rerender(peek(WITH({ descriptionMd: 'A revised body.' })));
    expect(phase('descriptionMd')).toBe('final');
    expect(screen.getByText('A revised body.')).toBeTruthy();
  });

  it('live turning false mid-type shows the full value at once (AC 9)', async () => {
    fakeFrames();
    const r = render(peek(ADD));
    r.rerender(peek(WITH({ descriptionMd: BODY })));
    await advance(TYPEWRITER_CAP_MS / 3);
    r.rerender(peek(WITH({ descriptionMd: BODY }), false));
    expect(field('descriptionMd')).toBeNull();
    expect(screen.getByText(BODY)).toBeTruthy();
  });

  it('under prefers-reduced-motion an arriving field simply appears (AC 6)', async () => {
    reduced = true;
    const r = render(peek(ADD));
    r.rerender(peek(WITH({ descriptionMd: BODY })));
    expect(phase('descriptionMd')).toBe('final');
    expect(screen.getByText(BODY)).toBeTruthy();
  });
});

describe('everything else shows at once', () => {
  it('a written field at open never types, and its change shows in full (AC 2)', () => {
    const written = WITH({ descriptionMd: BODY, explanationMd: 'Why.' });
    const r = render(peek(written));
    expect(field('descriptionMd')).toBeNull();
    expect(field('title')).toBeNull();
    r.rerender(peek({ ...written, descriptionMd: 'Changed in full.' }));
    expect(field('descriptionMd')).toBeNull();
    expect(screen.getByText('Changed in full.')).toBeTruthy();
  });

  it('closing and reopening shows everything at once — what types is decided per open (AC 4)', async () => {
    fakeFrames();
    const r = render(peek(ADD));
    r.rerender(peek(WITH({ descriptionMd: BODY })));
    expect(phase('descriptionMd')).toBe('typing');
    r.rerender(peek(null));
    r.rerender(peek(WITH({ descriptionMd: BODY })));
    expect(field('descriptionMd')).toBeNull();
    expect(screen.getByText(BODY)).toBeTruthy();
  });

  it('the rail scalars appear: a priority arriving later is never typed (AC 5)', () => {
    const r = render(peek(ADD));
    r.rerender(peek(WITH({ priority: 'high' })));
    expect(screen.queryByTestId('quick-view-typein-priority')).toBeNull();
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
  });

  it('off live (the plan page) nothing is armed at all', () => {
    const r = render(peek(ADD, false));
    r.rerender(peek(WITH({ descriptionMd: BODY }), false));
    expect(field('descriptionMd')).toBeNull();
    expect(screen.getByText(BODY)).toBeTruthy();
  });
});

describe('both doors follow the live item while live (AC 8)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({ nodes: [], edges: [], offLevelBlockers: [] }),
          }) as unknown as Response,
      ),
    );
  });

  it('the List door: live follows the current item; off live keeps the copy taken at open', async () => {
    reduced = true;
    for (const live of [true, false]) {
      const r = render(<PlanProposalList items={[ADD]} outcome={null} live={live} />);
      fireEvent.click(screen.getByRole('button', { name: /Open / }));
      await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
      r.rerender(
        <PlanProposalList items={[WITH({ descriptionMd: BODY })]} outcome={null} live={live} />,
      );
      const peekEl = screen.getByTestId('proposal-peek');
      expect(within(peekEl).queryByText(BODY) !== null).toBe(live);
      cleanup();
    }
  });

  it('the Canvas door: the same', async () => {
    reduced = true;
    for (const live of [true, false]) {
      const r = render(
        <PlanReviewCanvas items={[ADD]} projectKey="MOTIR" version={0} live={live} />,
      );
      const node = await waitFor(() => {
        const found = document.querySelector('[data-node-id="pi_add"]');
        if (!found) throw new Error('the canvas has not drawn its level yet');
        return found as HTMLElement;
      });
      fireEvent.keyDown(node, { key: 'Enter' });
      fireEvent.click(within(node).getByTestId('view-button'));
      await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
      r.rerender(
        <PlanReviewCanvas
          items={[WITH({ descriptionMd: BODY })]}
          projectKey="MOTIR"
          version={0}
          live={live}
        />,
      );
      const peekEl = screen.getByTestId('proposal-peek');
      expect(within(peekEl).queryByText(BODY) !== null).toBe(live);
      cleanup();
    }
  });

  it('a proposal withdrawn mid-view keeps its last copy while live', async () => {
    reduced = true;
    const r = render(<PlanProposalList items={[ADD]} outcome={null} live />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const other = planReviewItem({ planItemId: 'pi_other', nodeId: 'pi_other', title: 'Other' });
    r.rerender(<PlanProposalList items={[other]} outcome={null} live />);
    expect(
      within(screen.getByTestId('proposal-peek')).getByText('A card being written'),
    ).toBeTruthy();
  });
});
