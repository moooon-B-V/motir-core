// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// THE RAIL LANDS ON ITS DECISION (MOTIR-4023, design Part XIII §8).
//
// The rail was ONE `overflow-y-auto` column with the decision held at its bottom
// by `mt-auto` — which reads right on a short plan and disappears on a long one.
// Measured in Chromium with a long generated title and a nine-turn timeline: the
// rail's scroll height is 1011px and Approve's bottom sits at 1037, which is
// 361px below the fold at 1366x768, 337 at 1280x800, 237 at 1440x900 and 57px
// below it EVEN AT 1920x1080. The page a reviewer arrived at to make a decision
// showed no decision, and nothing scrolled to it.
//
// The GEOMETRY is measured in the pull request — happy-dom does no layout, so
// "inside the visible box" cannot be asserted here. What IS assertable, and what
// a later edit would silently undo, is the STRUCTURE the geometry rests on: which
// region scrolls, which does not, what each holds, and where the room for the orb
// comes from.

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    summary: null,
    itemCount: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    plannedAt: '2026-08-19T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...over,
  };
}

function renderRail(over: Partial<PlanReviewDto> = {}, extra: Record<string, unknown> = {}) {
  return renderWithIntl(
    <PlanReviewRail
      review={review(over)}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
      {...extra}
    />,
  );
}

const transcript = () => screen.getByTestId('plan-review-transcript');
const rail = () => screen.getByRole('complementary');
/** The pinned footer: the rail's last element child, and not the scroller. */
const footer = () => rail().lastElementChild as HTMLElement;

describe('the rail is a scroll region PLUS a pinned footer', () => {
  it('scrolls the TRANSCRIPT and not the rail', () => {
    renderRail();
    // The `<aside>` itself must stop scrolling, or the footer scrolls with it and
    // nothing has changed.
    expect(rail().className).not.toContain('overflow-y-auto');
    expect(transcript().className).toContain('overflow-y-auto');
    expect(transcript().className).toContain('flex-1');
    // `min-h-0` is what lets a flex child shrink below its content — without it
    // the region grows and pushes the footer out of the rail, which is the bug
    // wearing a different shape.
    expect(transcript().className).toContain('min-h-0');
  });

  it('keeps the footer OUT of the scroller, and stops it shrinking', () => {
    renderRail();
    expect(footer().contains(transcript())).toBe(false);
    expect(transcript().contains(footer())).toBe(false);
    expect(footer().className).toContain('shrink-0');
  });

  it('separates the two with a top HAIRLINE and no shadow', () => {
    renderRail();
    // `--el-surface` on `--el-surface`: a hairline is the whole separation
    // needed, and a shadow would imply the footer floats over a different
    // surface, which it does not.
    expect(footer().className).toContain('border-t');
    expect(footer().className).toContain('border-(--el-border)');
    expect(footer().className).not.toContain('shadow');
  });

  it('reserves the ORB’s room in the footer’s own bottom padding', () => {
    renderRail();
    // ⚠️ The SHELL's property, read directly. `--canvas-fold-inset` is the
    // canvas's indirection for a SHARED component so its other mounts inherit
    // nothing; this rail is not shared. Measured at 1440x900: the orb's top is
    // 824 and the rail's bottom becomes 900 once the pane spends the band
    // (MOTIR-4019), so without this the orb covers Decline.
    expect(footer().className).toContain(
      'pb-[calc(var(--spacing-control-y)+var(--shell-bottom-clearance,1.5rem))]',
    );
  });
});

describe('what each region holds', () => {
  it('puts APPROVE and DECLINE in the footer', () => {
    renderRail();
    const approve = screen.getByRole('button', { name: /Approve/ });
    const decline = screen.getByRole('button', { name: /Decline/ });
    expect(footer().contains(approve)).toBe(true);
    expect(footer().contains(decline)).toBe(true);
    expect(transcript().contains(approve)).toBe(false);
  });

  it('leaves the revise COMPOSER at the END of the transcript, not in the footer', () => {
    renderRail({}, { onRevise: () => {}, reviseDraft: '', onReviseDraftChange: () => {} });
    const composer = screen.getByPlaceholderText(/Ask Motir/i);
    // A pinned footer must have a bounded height and a composer grows with its
    // draft. Part XII §A's *inside the decision block, above the two verbs* was an
    // ORDER and an adjacency, and both survive: last in the transcript, with the
    // verbs directly beneath it.
    expect(transcript().contains(composer)).toBe(true);
    expect(footer().contains(composer)).toBe(false);
    expect(transcript().lastElementChild!.contains(composer)).toBe(true);
  });

  it('keeps the history and the staleness summary in the transcript', () => {
    renderRail({ stale: true, staleCount: 1, items: [] });
    expect(transcript().contains(screen.getByTestId('stale-summary'))).toBe(true);
  });
});

describe('the transcript opens at its LATEST turn', () => {
  it('is scrolled to its end on first render, and moves no focus', () => {
    // happy-dom reports 0 for both, so the region is given a height to scroll.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 1011;
      },
    });
    renderRail();
    expect(transcript().scrollTop).toBe(1011);
    // Scrolling to the latest turn must not steal focus — a reader who lands and
    // types is typing into the page, not into whatever the scroll passed over.
    expect(document.activeElement).toBe(document.body);
    // @ts-expect-error — restore the prototype the harness patched.
    delete HTMLElement.prototype.scrollHeight;
  });
});

describe('the footer per PlanStatus member — the state set run WHOLE', () => {
  // Five members, and the two decided ones are the reason this is a table rather
  // than three cases: `DecidedOutcome` moves INTO the footer rather than being
  // exempted from it, so the rail's shape does not change under the reader.
  const cases: [PlanStatusDto, (f: HTMLElement) => void][] = [
    [
      'generating',
      (f) => {
        expect(f.textContent).toContain('Discard this plan');
        expect(f.querySelector('button[disabled]')).toBeTruthy();
      },
    ],
    ['planned', (f) => expect(f.textContent).toContain('Approve')],
    ['stale', (f) => expect(f.textContent).toContain('Approve')],
    ['approved', (f) => expect(f.querySelector('button')).toBeNull()],
    ['declined', (f) => expect(f.querySelector('button')).toBeNull()],
  ];

  for (const [status, assertion] of cases) {
    it(`holds the right controls at \`${status}\``, () => {
      renderRail({
        status,
        ...(status === 'generating' ? { plannedAt: null } : {}),
        ...(status === 'stale' ? { stale: true, staleCount: 1 } : {}),
        ...(status === 'approved' || status === 'declined'
          ? { decidedAt: '2026-08-20T00:00:00.000Z' }
          : {}),
      });
      // The band and its padding are kept in every state, so nothing moves.
      expect(footer().className).toContain('border-t');
      assertion(footer());
    });
  }
});
