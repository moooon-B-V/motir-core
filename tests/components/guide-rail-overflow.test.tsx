// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { GuideRail } from '@/components/planning/GuideRail';
import { deriveGuideView } from '@/lib/planning/guideView';
import { guideReplyBody } from '@/lib/planning/guideReplyNotes';
import type { GuideAction, GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// MOTIR-8725 — an assistant reply in the guide rail may never push the log into
// a SIDEWAYS scroll.
//
// The defect had the same two halves as MOTIR-4578 on the review rail. The
// assistant bubble's message box was a flex item with `min-width: auto`, so it
// grew to the min-content of its widest token — an inline `code` span, a URL,
// the guided card's chip on a "Ticked step 2 on …" line — and the log stated
// only `overflow-y-auto`, whose unstated `overflow-x` computes to `auto`, so the
// over-wide bubble became a scrollbar along the whole log.
//
// ⚠️ WHAT THIS LANE CAN AND CANNOT ASSERT. The card asked for
// `scrollWidth <= clientWidth` on `guide-rail-log`, and happy-dom does no
// layout: every box is 0×0, so that assertion reads `0 <= 0` and is green on
// the UNFIXED component. A guard that cannot go red is not a guard. So this
// lane asserts the MECHANISM — the classes that produce the geometry — which
// goes red the moment either half is dropped. The geometry itself was measured
// in Chromium on a plain-CSS replica of the rail at 360px (scrollWidth 1023 →
// 360) and is recorded on the pull request.

/** A token with NO line-break opportunity — no space, `/` or `-`. */
const unbreakable = (label: string) => `${label}_${'X'.repeat(64)}`;

const INLINE_CODE = unbreakable('INLINECODE');
const PROSE_TOKEN = unbreakable('PROSETOKEN');
const BLOCK_CODE = unbreakable('BLOCKCODE');
const CARD_TITLE = `Install the App over the three private repositories ${unbreakable('CARDTITLE')}`;

const CARD = { id: 'w9', identifier: 'PAY-212', title: CARD_TITLE, kind: 'subtask' as const };
const ROWS = [
  { id: 'r1', text: 'One', position: 'a', done: true },
  { id: 'r2', text: 'Two', position: 'b', done: false },
] as WorkItemTodoDto[];

function assistantTurn(): PlanChangeTurnDto {
  const tick: GuideAction = { type: 'tick', rowId: 'r1' };
  const guide: GuideTurnRecord = {
    actions: [tick],
    outcomes: [{ type: 'tick', outcome: 'landed' }],
    temporary: false,
  };
  const message = [
    `Select \`${INLINE_CODE}\` and then ${PROSE_TOKEN}.`,
    '',
    '```sh',
    `echo ${BLOCK_CODE}`,
    '```',
  ].join('\n');
  return {
    id: 't1',
    seq: 1,
    role: 'assistant',
    body: guideReplyBody(message, guide.actions, guide.outcomes),
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: null,
    createdAt: '2026-10-15T22:27:00.000Z',
    guide,
  };
}

function renderRail() {
  const turns = [assistantTurn()];
  renderWithIntl(
    <GuideRail
      card={CARD}
      session={
        {
          id: 's1',
          projectId: 'p',
          targetKeys: [CARD.identifier],
          turnCount: turns.length,
          lastJobId: null,
          lastSubmittedAt: null,
          lastActivityAt: '2026-10-15T22:27:00.000Z',
          origin: 'guide',
          createdAt: '2026-10-15T22:27:00.000Z',
          updatedAt: '2026-10-15T22:27:00.000Z',
          turns,
          workItemRefs: {},
        } as PlanChangeSessionDto
      }
      view={deriveGuideView(turns, ROWS, { idle: true })}
      phase="idle"
      errorCode={null}
      outOfCredits={false}
      markers={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onReload={vi.fn()}
    />,
  );
}

/** Is `el` reached by `overflow-wrap: anywhere` from inside the log? The
 *  property INHERITS, so the element itself or any ancestor up to the log
 *  counts; a break opportunity set above the scroll box does not. */
function reachedByWrapGuard(el: HTMLElement, log: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.classList.contains('wrap-anywhere')) return true;
    if (node === log) return false;
  }
  return false;
}

/** Every element between `el` and the log that is a FLEX ITEM (its parent is a
 *  flex container) must be allowed to shrink, or the first one that is not
 *  grows to its content's min-content and widens everything above it. */
function unshrinkableFlexItems(el: HTMLElement, log: HTMLElement): HTMLElement[] {
  const offenders: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node && node !== log; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent || parent === log) continue;
    const parentIsFlex = /(^|\s)(inline-)?flex(\s|$)/.test(parent.className);
    if (!parentIsFlex) continue;
    // A `flex-none` / `shrink-0` item is a fixed-size glyph by design, not a
    // content box that can grow with a long token.
    const exempt = ['min-w-0', 'shrink-0', 'flex-none'].some((c) => node.classList.contains(c));
    if (!exempt) offenders.push(node);
  }
  return offenders;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GuideRail — an assistant reply cannot scroll the log sideways (MOTIR-8725)', () => {
  it('states BOTH overflow axes on the log', () => {
    renderRail();
    const log = screen.getByTestId('guide-rail-log');
    expect(log.className).toContain('overflow-y-auto');
    // `hidden`, not `auto`: the log holds prose that wraps, and `auto` is the
    // scrollbar this card is about (the review rail's MOTIR-4578 choice).
    expect(log.className).toContain('overflow-x-hidden');
  });

  it('lets the assistant message box shrink to the rail and break inside it', () => {
    renderRail();
    const bubble = screen.getByTestId('guide-turn');
    const message = bubble.lastElementChild as HTMLElement;
    expect(message.className).toContain('min-w-0');
    expect(message.className).toContain('wrap-anywhere');
  });

  it.each([
    ['an inline code span', INLINE_CODE],
    ['an unbroken token in prose', PROSE_TOKEN],
  ])('guards %s against an unbreakable token', (_label, text) => {
    renderRail();
    const log = screen.getByTestId('guide-rail-log');
    const rendered = within(log).getByText(text, { exact: false });
    expect(reachedByWrapGuard(rendered, log)).toBe(true);
    expect(unshrinkableFlexItems(rendered, log)).toEqual([]);
  });

  it('keeps a code BLOCK on one line, scrolling inside its own frame', () => {
    renderRail();
    const log = screen.getByTestId('guide-rail-log');
    // The block is syntax-highlighted into several spans, so find it by its text.
    const pre = Array.from(log.querySelectorAll('pre')).find((el) =>
      el.textContent?.includes(BLOCK_CODE),
    )!;
    expect(pre).toBeDefined();
    expect(pre.className).toContain('whitespace-pre');
    expect(pre.className).toContain('overflow-x-auto');
    // `white-space: pre` allows no soft wrap, so the inherited `wrap-anywhere`
    // cannot break the line; the block's frame is what must stay within the rail.
    expect(pre.closest('.motir-code-block')!.className).toContain('min-w-0');
  });

  it("truncates the guided card's chip on the outcome line instead of widening it", () => {
    renderRail();
    const log = screen.getByTestId('guide-rail-log');
    const [line] = within(log).getAllByTestId('guide-outcome');
    expect(line!.getAttribute('data-outcome')).toBe('ticked');
    const title = line!.querySelector('.wi-chip .wi-title') as HTMLElement;
    expect(title.textContent).toBe(CARD_TITLE);
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('min-w-0');
    expect((line!.querySelector('.wi-chip') as HTMLElement).className).toContain('max-w-full');
    expect(unshrinkableFlexItems(title, log)).toEqual([]);
  });
});
