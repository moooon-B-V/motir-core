// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { Modal } from '@/components/ui/Modal';
import { MAX_PLANNING_TARGETS, type PlanningTarget } from '@/lib/planning/planningTargets';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// The planning composer — its TARGET search (Subtask MOTIR-1491, rebuilt by
// MOTIR-6897 to `design/ai-chat/target-picker--search-and-canvas.mock.html`:
// the Search control, the popover with its OWN field, every state, the `@`
// shortcut and the keyboard hand-off) and, since
// MOTIR-6238, its MULTI-LINE keys (design
// `design/ai-chat/planning-workspace--multiline-composer.mock.html`).
//
// `fetch` is the boundary that gets stubbed, and nothing else: the picker rides
// the SHIPPED `GET /api/work-items/mention-search` (5.8.5), so the URL these
// tests assert is the product's URL — a picker that quietly grew its own search
// endpoint would fail here.
//
// `scrollHeight` and the computed style are stubbed for the same reason
// MOTIR-6237's own spec stubs them: happy-dom lays nothing out, so every
// measurement would read "empty" and every height assertion would pass for the
// wrong reason.

const ROWS: Partial<WorkItemSummaryDto>[] = [
  {
    id: 'w-812',
    identifier: 'MOTIR-812',
    title: 'Billing — automated invoicing',
    kind: 'story',
    status: 'todo',
  },
  {
    id: 'w-918',
    identifier: 'MOTIR-918',
    title: 'Migrate billing from legacy',
    kind: 'subtask',
    status: 'done',
  },
];

const fetchMock = vi.fn<typeof fetch>();

const LINE = 20; // --text-sm's line-height, the number the composer is drawn on
const PAD = 22; // the derived 11px top + 11px bottom
const BORDER = 2; // 1px each side
/** One row is `--height-input` exactly — 44px — which is the whole point of the
 *  derived padding rather than the `--spacing-input-y` token's 12px. */
const ONE_ROW = LINE + PAD + BORDER;

/** Drive `scrollHeight` as a browser would for `n` wrapped lines. */
function stubScrollHeight(el: HTMLTextAreaElement, lines: number) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => lines * LINE + PAD,
  });
}

/**
 * The computed style the field has under the design system's tokens. Stubbed on
 * the GLOBAL because the primitive calls the bare `getComputedStyle`; a spy on
 * the `window` property is not guaranteed to be the same function object, and
 * getting it wrong makes every measurement `NaN`.
 */
function stubComputedStyle() {
  const real = globalThis.getComputedStyle.bind(globalThis);
  vi.stubGlobal('getComputedStyle', (el: Element, pseudo?: string | null) => {
    if ((el as HTMLElement).tagName !== 'TEXTAREA') return real(el, pseudo ?? undefined);
    return {
      lineHeight: `${LINE}px`,
      fontSize: '14px',
      paddingTop: '11px',
      paddingBottom: '11px',
      boxSizing: 'border-box',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      // `dom-accessibility-api` reads `visibility` / `display` through this when
      // a `getByRole` MISSES and testing-library builds its error message. A
      // stub without it turns every near-miss into an unrelated TypeError.
      getPropertyValue: (name: string) =>
        ({ 'line-height': `${LINE}px`, visibility: 'visible', display: 'block' })[name] ?? '',
    } as unknown as CSSStyleDeclaration;
  });
}

beforeEach(() => {
  stubComputedStyle();
  fetchMock.mockReset();
  // A fresh Response per call — a Response body reads ONCE, so a shared instance
  // would make the SECOND search look like a failure (and the picker like a bug).
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(ROWS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  // The pick restores the caret on the next frame; happy-dom has no rAF budget
  // to wait for, so run it immediately and deterministically.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Harness {
  draft: string;
  targets: PlanningTarget[];
  autoFocus: boolean;
  disabled: boolean;
  mentions: boolean;
  awaitingQuestion: string | null;
  onSeeQuestion: Mock<() => void> | undefined;
  onAddTarget: Mock<(target: PlanningTarget) => void>;
  onRemoveTarget: Mock<(identifier: string) => void>;
  onSubmit: Mock<(text: string) => void>;
  onDraftChange: Mock<(value: string) => void>;
}

/** Render the composer with a controlled draft, re-rendering on every change so
 *  the input behaves the way it does under the rail (which owns the text). */
function renderComposer(initial: Partial<Harness> = {}) {
  const harness: Harness = {
    draft: initial.draft ?? '',
    targets: initial.targets ?? [],
    autoFocus: initial.autoFocus ?? false,
    disabled: initial.disabled ?? false,
    mentions: initial.mentions ?? true,
    awaitingQuestion: initial.awaitingQuestion ?? null,
    onSeeQuestion: initial.onSeeQuestion,
    onAddTarget: vi.fn<(target: PlanningTarget) => void>(),
    onRemoveTarget: vi.fn<(identifier: string) => void>(),
    onSubmit: vi.fn<(text: string) => void>(),
    onDraftChange: vi.fn<(value: string) => void>(),
  };

  const view = renderWithIntl(<Composer harness={harness} />);

  function Composer({ harness: h }: { harness: Harness }) {
    return (
      <PlanChangeComposer
        draft={h.draft}
        onDraftChange={(value) => {
          h.onDraftChange(value);
          h.draft = value;
          view.rerender(<Composer harness={h} />);
        }}
        targets={h.targets}
        onAddTarget={(t) => {
          h.onAddTarget(t);
          h.targets = [...h.targets, t];
          view.rerender(<Composer harness={h} />);
        }}
        onRemoveTarget={h.onRemoveTarget}
        onSubmit={h.onSubmit}
        autoFocus={h.autoFocus}
        disabled={h.disabled}
        mentions={h.mentions}
        awaitingQuestion={h.awaitingQuestion}
        onSeeQuestion={h.onSeeQuestion}
      />
    );
  }

  return harness;
}

/** The composer's field. A `<textarea>` since MOTIR-6238, and still the
 *  `textbox` role every shipped consumer and acceptance spec addresses it by. */
function field() {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

const lastSearchUrl = () => String(fetchMock.mock.calls.at(-1)?.[0] ?? '');

/** The Search control — the shipped `planning-target-trigger`, with its new name. */
function searchControl() {
  return screen.getByRole('button', { name: 'Search work items to plan' }) as HTMLButtonElement;
}

/** The popover's OWN field — the combobox since MOTIR-6897. */
function searchField() {
  return screen.getByTestId('planning-target-search-field') as HTMLInputElement;
}

/** Open the search from the control and type a query into its field. */
function searchFor(query: string) {
  fireEvent.click(searchControl());
  const input = searchField();
  fireEvent.change(input, { target: { value: query } });
  return input;
}

/** Type into the MESSAGE with the caret at `caret` — the value and the caret
 *  land together, the way a keystroke delivers them. */
function typeAt(value: string, caret: number) {
  const input = field();
  fireEvent.change(input, { target: { value, selectionStart: caret, selectionEnd: caret } });
  return input;
}

const TARGET_812: PlanningTarget = {
  id: 'w-812',
  identifier: 'MOTIR-812',
  title: 'Billing — automated invoicing',
  kind: 'story',
};

function fullSet(): PlanningTarget[] {
  return Array.from({ length: MAX_PLANNING_TARGETS }, (_, i) => ({
    id: `w-${i}`,
    identifier: `MOTIR-${i}`,
    title: `Item ${i}`,
    kind: 'story' as const,
  }));
}

describe('the Search control (design panel 1)', () => {
  it('is a magnifier control named “Search work items to plan”, in the shipped trigger slot', () => {
    renderComposer();
    const control = searchControl();

    expect(control.getAttribute('data-testid')).toBe('planning-target-trigger');
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(control.querySelector('svg.lucide-search')).not.toBeNull();
  });

  it('shows its tooltip — the name and the `@` shortcut — on keyboard focus', async () => {
    renderComposer();
    fireEvent.focus(searchControl());

    const tip = await screen.findByRole('tooltip', {}, { timeout: 3000 });
    expect(tip.textContent).toContain('Search work items to plan');
    expect(tip.textContent).toContain('@');
  });

  it('opens the search with focus in ITS field, and reads as pressed while it is open', async () => {
    renderComposer();
    fireEvent.click(searchControl());

    expect(screen.getByRole('dialog', { name: 'Search work items to plan' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(searchField()));
    expect(searchControl().getAttribute('aria-expanded')).toBe('true');
    // A second press closes it again.
    fireEvent.click(searchControl());
    expect(screen.queryByTestId('target-search-popup')).toBeNull();
  });

  it('is DISABLED at the 20-target cap, and its tooltip says why', async () => {
    renderComposer({ targets: fullSet() });

    expect(searchControl().disabled).toBe(true);
    // The tooltip hangs off the wrapper: a disabled button fires no events.
    fireEvent.focus(searchControl().parentElement!);
    const tip = await screen.findByRole('tooltip', {}, { timeout: 3000 });
    expect(tip.textContent).toContain('You can plan around up to 20 work items at once.');
  });
});

describe('the search popover has its OWN field (design panel 2)', () => {
  it('searches the SHIPPED endpoint and shows the row grammar (icon · key · title · status)', async () => {
    renderComposer();
    searchFor('bil');

    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(lastSearchUrl()).toBe('/api/work-items/mention-search?q=bil');
    expect(options.map((o) => o.textContent)).toEqual([
      'MOTIR-812Billing — automated invoicingTo Do',
      'MOTIR-918Migrate billing from legacyDone',
    ]);
    expect(screen.getByText('Work items matching “bil”')).toBeTruthy();
  });

  it('keeps searching after each SPACE — one request, for the whole debounced phrase', async () => {
    renderComposer();
    fireEvent.click(searchControl());
    for (const q of ['plan', 'plan ', 'plan approval', 'plan approval gate']) {
      fireEvent.change(searchField(), { target: { value: q } });
    }

    await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastSearchUrl()).toBe('/api/work-items/mention-search?q=plan%20approval%20gate');
    // The popover is still open with the phrase in its field.
    expect(searchField().value).toBe('plan approval gate');
  });

  it('a bare NUMBER goes straight to the shared search, and Enter adds the first row without sending', async () => {
    const harness = renderComposer({ draft: 'Break this into stories' });
    const input = searchFor('6010');
    await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(lastSearchUrl()).toBe('/api/work-items/mention-search?q=6010');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(harness.onAddTarget).toHaveBeenCalledWith(TARGET_812);
    expect(harness.onSubmit).not.toHaveBeenCalled();
    // The message is untouched — the target went to the TRAY.
    expect(harness.draft).toBe('Break this into stories');
  });
});

describe('every state of the popover (design panel 3)', () => {
  it('EMPTY — the “search by key, number or title” hint, and no request', async () => {
    renderComposer();
    fireEvent.click(searchControl());

    expect(await screen.findByText('Search by key, number or title…')).toBeTruthy();
    expect(searchField().getAttribute('placeholder')).toBe('Key, number or title…');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TOO SHORT — below the server’s minimum there is a hint and no request', async () => {
    renderComposer();
    searchFor('6');

    expect(await screen.findByText('Keep typing to search work items…')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('LOADING — a status while the request is in flight', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderComposer();
    searchFor('plan appro');

    expect((await screen.findByRole('status')).textContent).toContain('Searching…');
  });

  it('NO MATCH — says so, naming the query, with no empty listbox', async () => {
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }));
    renderComposer();
    searchFor('quokka ledger');

    expect(
      await screen.findByText('No work items match “quokka ledger”.', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(searchField().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('ALREADY A TARGET — the row stays, marked, is skipped and cannot be picked', async () => {
    const harness = renderComposer({ targets: [TARGET_812] });
    const input = searchFor('bil');
    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });

    expect(options[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(options[0]!.textContent).toContain('Target');
    // The active row is the first PICKABLE one.
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.mouseDown(options[0]!);
    fireEvent.mouseEnter(options[0]!);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    expect(harness.onAddTarget).not.toHaveBeenCalled();
  });

  it('AT THE CAP — `@` opens it with the field disabled, no rows, and the reason', async () => {
    renderComposer({ targets: fullSet() });
    typeAt('@', 1);

    const popup = await screen.findByTestId('target-search-popup');
    expect(searchField().disabled).toBe(true);
    expect(popup.textContent).toContain('You can plan around up to 20 work items at once.');
    expect(screen.queryByRole('option')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Focus is on the shell, so Esc still closes it.
    await waitFor(() => expect(document.activeElement).toBe(popup));
    fireEvent.keyDown(popup, { key: 'Escape' });
    expect(screen.queryByTestId('target-search-popup')).toBeNull();
  });
});

describe('the `@` shortcut (design panel 4)', () => {
  it('an `@` at the START opens the search and leaves no `@` in the draft', async () => {
    const harness = renderComposer();
    typeAt('@', 1);

    expect(harness.draft).toBe('');
    expect(screen.getByRole('dialog', { name: 'Search work items to plan' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(searchField()));
  });

  it('an `@` after whitespace mid-sentence is consumed, and a pick returns the caret there', async () => {
    const harness = renderComposer({ draft: 'Split  story' });
    typeAt('Split @ story', 7);
    expect(harness.draft).toBe('Split  story');

    fireEvent.change(searchField(), { target: { value: 'bil' } });
    await screen.findAllByRole('option', {}, { timeout: 3000 });
    fireEvent.keyDown(searchField(), { key: 'Enter' });
    await screen.findByTestId('planning-target-chip');

    expect(screen.queryByTestId('target-search-popup')).toBeNull();
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(6);
  });

  it('opens on an `@` typed at the start of a SECOND line', () => {
    const harness = renderComposer({ draft: 'Expand billing.\n' });
    typeAt('Expand billing.\n@', 17);

    expect(harness.draft).toBe('Expand billing.\n');
    expect(screen.getByTestId('target-search-popup')).toBeTruthy();
  });

  it('`foo@bar` types an ordinary `@` — no search', () => {
    const harness = renderComposer({ draft: 'Ask foo' });
    typeAt('Ask foo@', 8);

    expect(harness.draft).toBe('Ask foo@');
    expect(screen.queryByTestId('target-search-popup')).toBeNull();
  });

  it('without `mentions` an `@` is just a character', () => {
    const harness = renderComposer({ mentions: false });
    typeAt('@', 1);

    expect(harness.draft).toBe('@');
    expect(screen.queryByTestId('target-search-popup')).toBeNull();
  });
});

describe('where every key goes (design panel 5)', () => {
  it('↓/↑ move the active row, wrapping, and the field voices it', async () => {
    renderComposer();
    const input = searchFor('bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(input.getAttribute('aria-activedescendant')).toBe('planning-target-option-0');
    expect(screen.getByRole('listbox').getAttribute('id')).toBe('planning-target-listbox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('planning-target-option-1');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('planning-target-option-0');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe('planning-target-option-1');
  });

  it('HOVERING a row makes it the active one, so the pointer and the keyboard agree', async () => {
    renderComposer();
    const input = searchFor('bil');
    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });

    fireEvent.mouseEnter(options[1]!);

    await waitFor(() => expect(options[1]!.getAttribute('aria-selected')).toBe('true'));
    expect(input.getAttribute('aria-activedescendant')).toBe('planning-target-option-1');
  });

  it('a pick CLOSES the search; a second target is one more open', async () => {
    const harness = renderComposer();

    searchFor('bil');
    fireEvent.mouseDown((await screen.findAllByRole('option', {}, { timeout: 3000 }))[0]!);
    expect(screen.queryByTestId('target-search-popup')).toBeNull();

    searchFor('mig');
    fireEvent.mouseDown((await screen.findAllByRole('option', {}, { timeout: 3000 }))[1]!);

    expect(harness.targets.map((t) => t.identifier)).toEqual(['MOTIR-812', 'MOTIR-918']);
    expect(screen.getAllByTestId('planning-target-chip')).toHaveLength(2);
    expect(screen.getByTestId('planning-target-tray').getAttribute('aria-label')).toBe('Targets');
  });

  it('Enter with NO pickable row does nothing — it never sends the message', async () => {
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }));
    const harness = renderComposer({ draft: 'Plan it' });
    const input = searchFor('zzqq');
    await screen.findByText('No work items match “zzqq”.', {}, { timeout: 3000 });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(harness.onSubmit).not.toHaveBeenCalled();
    expect(harness.onAddTarget).not.toHaveBeenCalled();
  });

  it('an Enter confirming an IME candidate in the field never picks', async () => {
    const harness = renderComposer();
    const input = searchFor('bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(harness.onAddTarget).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
  });

  it('Escape closes the search, is SWALLOWED, and returns focus to the message caret', async () => {
    renderComposer({ draft: 'Split the story' });
    const message = field();
    message.setSelectionRange(5, 5);
    fireEvent.click(message);
    const input = searchFor('bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    // A raw `dispatchEvent` is not act-wrapped the way `fireEvent` is.
    act(() => {
      input.dispatchEvent(escape);
    });

    expect(escape.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('target-search-popup')).toBeNull());
    expect(document.activeElement).toBe(message);
    expect(message.selectionStart).toBe(5);
  });

  it('Escape in the search does NOT close a Radix dialog around the composer (the planning surface)', async () => {
    // The surface is a Radix Dialog, which hears Escape on `document` in the
    // CAPTURE phase — before any React handler. Found by the acceptance run: the
    // whole surface closed behind a dismissed search.
    const onOpenChange = vi.fn();
    renderWithIntl(
      <Modal open onOpenChange={onOpenChange} size="full" srTitle="Planning">
        <PlanChangeComposer
          draft=""
          onDraftChange={() => {}}
          targets={[]}
          onAddTarget={() => {}}
          onRemoveTarget={() => {}}
          onSubmit={() => {}}
        />
      </Modal>,
    );
    fireEvent.click(searchControl());
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    fireEvent.keyDown(searchField(), { key: 'Escape' });

    expect(screen.queryByTestId('target-search-popup')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    // …while an Escape from the MESSAGE still reaches the dialog, unchanged.
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opened before any caret was placed, Esc returns focus to the END of the draft', async () => {
    renderComposer({ draft: 'Plan' });
    const input = searchFor('');
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field().selectionStart).toBe(4);
  });

  it('Tab closes the search and hands focus back to the message', async () => {
    renderComposer();
    const input = searchFor('bil');
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(screen.queryByTestId('target-search-popup')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it('a click OUTSIDE closes it; a click inside does not', () => {
    renderComposer();
    searchFor('bil');

    fireEvent.pointerDown(searchField());
    expect(screen.getByTestId('target-search-popup')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('target-search-popup')).toBeNull();
  });
});

describe('the tray', () => {
  it('removes one target from the set with no confirmation', () => {
    const harness = renderComposer({ targets: [TARGET_812] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove MOTIR-812' }));
    expect(harness.onRemoveTarget).toHaveBeenCalledWith('MOTIR-812');
  });

  it('says the cap in the tray too', () => {
    renderComposer({ targets: fullSet() });

    expect(screen.getByText(/You can plan around up to 20 work items at once\./)).toBeTruthy();
  });
});

describe('sending', () => {
  it('sends the typed turn and clears the draft — the TARGETS persist for the next turn', () => {
    const harness = renderComposer({
      draft: 'Expand billing.',
      targets: [{ id: 'w-812', identifier: 'MOTIR-812', title: 'Billing', kind: 'story' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(harness.onSubmit).toHaveBeenCalledWith('Expand billing.');
    expect(harness.onDraftChange).toHaveBeenLastCalledWith('');
    expect(screen.getAllByTestId('planning-target-chip')).toHaveLength(1);
  });
});

// ── MOTIR-6238 — the field is MULTI-LINE ────────────────────────────────────
// Design: `design/ai-chat/planning-workspace--multiline-composer.mock.html`
// (sheets 1–3, 7, 8) and its `design-notes.md` section — the 8-row cap, the
// bottom alignment, no keyboard hint, no manual resize handle.

describe('the field is a growing textarea, not a one-line input', () => {
  it('is a <textarea> that keeps the textbox role and the accessible name', () => {
    renderComposer();
    const el = field();

    expect(el.tagName).toBe('TEXTAREA');
    expect(Number(el.rows)).toBe(1);
    // Every shipped consumer — and the acceptance specs — address the composer
    // as `getByRole('textbox')`, which a multi-line textarea carries too. And
    // the accessible name still TRACKS the prompt (MOTIR-910's contract): a
    // screen reader hears the same ask the placeholder shows.
    expect(el.getAttribute('aria-label')).toBe(el.getAttribute('placeholder'));
    expect(el.getAttribute('aria-label')).toBe('Reply, or refine further…');
  });

  it('is `--height-input` tall at one row — the shipped 44px, not the token’s 46', () => {
    renderComposer();
    const el = field();
    stubScrollHeight(el, 1);

    fireEvent.input(el, { target: { value: 'One line' } });

    expect(el.style.height).toBe(`${ONE_ROW}px`);
    expect(ONE_ROW).toBe(44);
  });

  it('grows one line-height per row and STOPS at the 8-row cap, scrolling inside itself', () => {
    renderComposer();
    const el = field();

    stubScrollHeight(el, 3);
    fireEvent.input(el, { target: { value: 'a\nb\nc' } });
    expect(el.style.height).toBe(`${3 * LINE + PAD + BORDER}px`);
    expect(el.style.overflowY).toBe('hidden');

    // A ten-line paste: the field stops at eight rows and scrolls.
    stubScrollHeight(el, 10);
    fireEvent.input(el, { target: { value: Array.from({ length: 10 }, (_, i) => i).join('\n') } });
    expect(el.style.height).toBe(`${8 * LINE + PAD + BORDER}px`);
    expect(el.style.overflowY).toBe('auto');
  });

  it('offers NO manual resize handle — a dragged height loses to the next keystroke', () => {
    renderComposer();
    expect(field().className).toContain('resize-none');
    expect(field().className).not.toContain('resize-y');
  });

  it('bottom-aligns the control row and the Search control, so neither walks down a growing field', () => {
    renderComposer();

    const row = field().closest('form')!.querySelector('.items-end');
    expect(row).not.toBeNull();
    // The slot is on the control's WRAPPER since MOTIR-6897 — the wrapper is
    // what carries the tooltip while the button is disabled.
    expect(searchControl().parentElement!.className).toContain('bottom-1.5');
  });

  it('shows no keyboard hint — the design decided against one, so no string is owed', () => {
    renderComposer();
    expect(screen.queryByText(/shift/i)).toBeNull();
    expect(screen.queryByText(/new line/i)).toBeNull();
  });
});

describe('the three meanings of Enter', () => {
  it('Enter with no modifier SENDS the trimmed draft', () => {
    const harness = renderComposer({ draft: '  Expand billing.  ' });

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(harness.onSubmit).toHaveBeenCalledWith('Expand billing.');
    expect(harness.onDraftChange).toHaveBeenLastCalledWith('');
  });

  it('Shift+Enter inserts a newline and does NOT send', () => {
    const harness = renderComposer({ draft: 'First line' });
    const el = field();

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      el.dispatchEvent(event);
    });

    expect(harness.onSubmit).not.toHaveBeenCalled();
    // Nothing prevented, so the browser's own newline insertion stands.
    expect(event.defaultPrevented).toBe(false);
  });

  it('a modified Enter (Ctrl / Meta / Alt) neither sends nor is swallowed', () => {
    const harness = renderComposer({ draft: 'Expand billing.' });

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      fireEvent.keyDown(field(), { key: 'Enter', [modifier]: true });
    }

    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('sends a draft that CARRIES line breaks, with them intact', () => {
    const harness = renderComposer({ draft: 'one\ntwo\nthree' });

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(harness.onSubmit).toHaveBeenCalledWith('one\ntwo\nthree');
  });

  it('refuses a draft of only spaces and NEWLINES — Send disabled, Enter sends nothing', () => {
    const harness = renderComposer({ draft: '  \n \n  ' });

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('↑/↓ with the picker CLOSED move the caret rather than being intercepted', () => {
    renderComposer({ draft: 'one\ntwo' });
    const el = field();

    const down = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      el.dispatchEvent(down);
    });

    expect(down.defaultPrevented).toBe(false);
  });
});

describe('an Enter that confirms an IME candidate never sends', () => {
  it('ignores it on `nativeEvent.isComposing`', () => {
    const harness = renderComposer({ draft: '计划' });

    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });

    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('ignores it on the legacy `keyCode === 229`', () => {
    const harness = renderComposer({ draft: '計画' });

    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });

    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('ignores it right after `compositionend` — the WebKit ordering both flags miss', () => {
    const harness = renderComposer({ draft: '计划' });
    const el = field();

    // Safari fires `compositionend` BEFORE the keydown of the confirming Enter,
    // so that keydown arrives with `isComposing: false` and no 229.
    fireEvent.compositionStart(el);
    fireEvent.compositionEnd(el);
    fireEvent.keyDown(el, { key: 'Enter' });

    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('sends again on the NEXT task, once the composition is behind it', async () => {
    const harness = renderComposer({ draft: '计划' });
    const el = field();

    fireEvent.compositionStart(el);
    fireEvent.compositionEnd(el);
    // The flag is held only to the end of the task in which the composition ended.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(el, { key: 'Enter' });

    expect(harness.onSubmit).toHaveBeenCalledWith('计划');
  });
});

describe('a PRE-FILLED multi-line draft', () => {
  it('is measured at its height on first paint, before any typing', () => {
    // The height is written by a LAYOUT effect, so the field paints at its final
    // size rather than flashing one line — which is what a seeded composer
    // (a starter chip, MOTIR-6210's seeded turn) would otherwise do on open.
    const draft = 'Rework the epic:\n- split the billing story\n- drop the retry job';
    let measured = '';
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.HTMLTextAreaElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(globalThis.HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 3 * LINE + PAD,
    });
    try {
      renderComposer({ draft });
      measured = field().style.height;
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          globalThis.HTMLTextAreaElement.prototype,
          'scrollHeight',
          originalDescriptor,
        );
      } else {
        delete (globalThis.HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)
          .scrollHeight;
      }
    }

    expect(measured).toBe(`${3 * LINE + PAD + BORDER}px`);
  });

  it('puts the caret at the END of it with `autoFocus`', () => {
    const draft = 'Rework the epic:\n- split the billing story';
    renderComposer({ draft, autoFocus: true });

    expect(field().selectionStart).toBe(draft.length);
    expect(field().selectionEnd).toBe(draft.length);
  });
});

describe('the states the composer already had behave exactly as before', () => {
  it('`disabled` locks the field, the Search control and Send — and KEEPS the draft', () => {
    renderComposer({ draft: 'one\ntwo', disabled: true });

    expect(field().disabled).toBe(true);
    expect(field().value).toBe('one\ntwo');
    expect(
      (screen.getByRole('button', { name: 'Search work items to plan' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('`disabled` refuses Enter too, so a locked composer cannot be sent from the keyboard', () => {
    const harness = renderComposer({ draft: 'one\ntwo', disabled: true });

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('without `mentions` the field is still a growing textbox, with no control and no combobox role', () => {
    renderComposer({ mentions: false, draft: 'Revise the plan' });

    expect(field().tagName).toBe('TEXTAREA');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search work items to plan' })).toBeNull();
  });
});

describe('the ANSWER state, driven through the composer itself', () => {
  // Asserted at the rail in `plan-change-planner-turn`, and never here — so the
  // composer's own three cues had no test that renders only the composer.
  it('shows the awaiting bar, relabels Send to Answer, and offers the jump when it can', () => {
    const onSeeQuestion = vi.fn<() => void>();
    renderComposer({
      draft: 'Monthly and yearly.',
      awaitingQuestion: 'Should invoices be monthly or yearly?',
      onSeeQuestion,
    });

    expect(screen.getByTestId('plan-change-awaiting').textContent).toContain(
      'Should invoices be monthly or yearly?',
    );
    // The third cue: the control's own word changes, not only its colour.
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'See it' }));
    expect(onSeeQuestion).toHaveBeenCalledTimes(1);
  });

  it('draws the bar with NO jump when the host offers none', () => {
    renderComposer({ awaitingQuestion: 'Monthly or yearly?' });

    expect(screen.getByTestId('plan-change-awaiting')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'See it' })).toBeNull();
  });
});
