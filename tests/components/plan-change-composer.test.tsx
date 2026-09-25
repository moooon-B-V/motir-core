// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { MAX_PLANNING_TARGETS, type PlanningTarget } from '@/lib/planning/planningTargets';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// The planning composer — its `@`-mention TARGET picker (Subtask MOTIR-1491;
// design `design/ai-chat/target-picker.mock.html` panels 1, 2 and 4) and, since
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

/** Type into the composer the way a person does — value AND caret. */
function type(value: string, caret = value.length) {
  const input = field();
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(caret, caret);
  fireEvent.keyUp(input, { key: value.slice(-1) });
  return input;
}

/** The composer's field. A `<textarea>` since MOTIR-6238, and still the
 *  `textbox` role every shipped consumer and acceptance spec addresses it by. */
function field() {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

const lastSearchUrl = () => String(fetchMock.mock.calls.at(-1)?.[0] ?? '');

describe('the `@` trigger opens a work-item search over the SHIPPED endpoint', () => {
  it('searches the project’s work items and shows the row grammar (icon · key · title · status)', async () => {
    renderComposer();
    type('Add sub-stories to @bil');

    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(lastSearchUrl()).toBe('/api/work-items/mention-search?q=bil');
    expect(options.map((o) => o.textContent)).toEqual([
      'MOTIR-812Billing — automated invoicingTo Do',
      'MOTIR-918Migrate billing from legacyDone',
    ]);
    expect(screen.getByText('Work items matching “bil”')).toBeTruthy();
  });

  it('never fires the request below the server’s minimum query length', async () => {
    renderComposer();
    type('Add @a');

    expect(await screen.findByText('Keep typing to search work items…')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hints “type to search” on a bare `@` — the empty state, still no request', async () => {
    renderComposer();
    type('Add @');

    expect(await screen.findByText('Type to search the project’s work items…')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when nothing matches, naming the query', async () => {
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }));
    renderComposer();
    type('Add @zzqq');

    expect(
      await screen.findByText('No work items match “zzqq”.', {}, { timeout: 3000 }),
    ).toBeTruthy();
  });

  it('the @ BUTTON opens the picker too — a visible affordance, not only a keystroke', async () => {
    const harness = renderComposer({ draft: 'Plan' });

    fireEvent.click(screen.getByRole('button', { name: 'Add a work item to plan around' }));

    // The trigger it would have typed, with the separating space.
    expect(harness.onDraftChange).toHaveBeenCalledWith('Plan @');
    expect(await screen.findByText('Type to search the project’s work items…')).toBeTruthy();
  });
});

describe('picking a target', () => {
  it('adds the item to the SET and consumes the `@query` — the chip lands in the tray', async () => {
    const harness = renderComposer();
    type('Add sub-stories to @bil');
    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });

    fireEvent.mouseDown(options[0]!);

    expect(harness.onAddTarget).toHaveBeenCalledWith({
      id: 'w-812',
      identifier: 'MOTIR-812',
      title: 'Billing — automated invoicing',
      kind: 'story',
    });
    // The message keeps what was typed, minus the query token.
    expect(harness.onDraftChange).toHaveBeenLastCalledWith('Add sub-stories to ');
    // …and the picker closes, so the next keystroke is just typing.
    expect(screen.queryByTestId('target-search-popup')).toBeNull();
    expect(screen.getByTestId('planning-target-chip').getAttribute('data-target-key')).toBe(
      'MOTIR-812',
    );
  });

  it('supports MULTIPLE targets, and the tray labels the count', async () => {
    const harness = renderComposer();

    type('@bil');
    fireEvent.mouseDown((await screen.findAllByRole('option', {}, { timeout: 3000 }))[0]!);
    type('@mig');
    fireEvent.mouseDown((await screen.findAllByRole('option', {}, { timeout: 3000 }))[1]!);

    expect(harness.targets.map((t) => t.identifier)).toEqual(['MOTIR-812', 'MOTIR-918']);
    expect(screen.getAllByTestId('planning-target-chip')).toHaveLength(2);
    expect(screen.getByTestId('planning-target-tray').getAttribute('aria-label')).toBe('Targets');
  });

  it('removes one target from the set with no confirmation', async () => {
    const harness = renderComposer({
      targets: [{ id: 'w-812', identifier: 'MOTIR-812', title: 'Billing', kind: 'story' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove MOTIR-812' }));
    expect(harness.onRemoveTarget).toHaveBeenCalledWith('MOTIR-812');
  });

  it('stops at the server’s bound rather than building a set the route would reject', () => {
    const targets = Array.from({ length: MAX_PLANNING_TARGETS }, (_, i) => ({
      id: `w-${i}`,
      identifier: `MOTIR-${i}`,
      title: `Item ${i}`,
      kind: 'story' as const,
    }));
    renderComposer({ targets });

    expect(screen.getByText(/You can plan around up to 20 work items at once\./)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add a work item to plan around' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('the picker is drivable from the keyboard alone', () => {
  it('↓/↑ move the active row and Enter COMMITS it — without submitting the message', async () => {
    const harness = renderComposer();
    const input = type('@bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true'),
    );

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(harness.onAddTarget).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'MOTIR-918' }),
    );
    // The half-typed `@bil` was NOT sent as a turn.
    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('Escape closes the picker and is SWALLOWED, so the workspace does not close behind it', async () => {
    renderComposer();
    const input = type('@bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    // A raw `dispatchEvent` is not act-wrapped the way `fireEvent` is, so the
    // close it triggers has to be dispatched inside an act scope.
    act(() => {
      input.dispatchEvent(escape);
    });

    expect(escape.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('target-search-popup')).toBeNull());
  });
});

describe('a11y — the combobox pattern, without an empty listbox', () => {
  it('voices the active row through aria-activedescendant on the input', async () => {
    renderComposer();
    const input = type('@bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    expect(input.getAttribute('aria-activedescendant')).toBe('planning-target-option-0');
    expect(screen.getByRole('listbox').getAttribute('id')).toBe('planning-target-listbox');
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('true');
  });

  it('renders NO listbox while the dropdown has no options (aria-required-children)', async () => {
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }));
    renderComposer();
    type('@zzqq');

    await screen.findByText('No work items match “zzqq”.', {}, { timeout: 3000 });
    // The state is text OUTSIDE the listbox — an empty `role="listbox"` fails
    // aria-required-children (the shipped combobox lesson).
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('textbox').getAttribute('aria-activedescendant')).toBeNull();
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

  it('bottom-aligns the control row and the `@` trigger, so neither walks down a growing field', () => {
    renderComposer();

    const row = field().closest('form')!.querySelector('.items-end');
    expect(row).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Add a work item to plan around' }).className,
    ).toContain('bottom-1.5');
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

describe('the `@` picker survives the element swap', () => {
  it('opens on an `@` typed at the start of a SECOND line, and picking consumes that line’s query', async () => {
    const harness = renderComposer();
    type('Expand billing.\n@bil');

    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(lastSearchUrl()).toBe('/api/work-items/mention-search?q=bil');

    fireEvent.mouseDown(options[0]!);

    expect(harness.onAddTarget).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'MOTIR-812' }),
    );
    // The first line is untouched; only the query token on the second is consumed.
    expect(harness.onDraftChange).toHaveBeenLastCalledWith('Expand billing.\n');
  });

  it('Enter PICKS while the picker is open, even on a multi-line draft', async () => {
    const harness = renderComposer();
    const el = type('one\ntwo @bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    fireEvent.keyDown(el, { key: 'Enter' });

    expect(harness.onAddTarget).toHaveBeenCalled();
    expect(harness.onSubmit).not.toHaveBeenCalled();
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
  it('`disabled` locks the field, the `@` trigger and Send — and KEEPS the draft', () => {
    renderComposer({ draft: 'one\ntwo', disabled: true });

    expect(field().disabled).toBe(true);
    expect(field().value).toBe('one\ntwo');
    expect(
      (screen.getByRole('button', { name: 'Add a work item to plan around' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('`disabled` refuses Enter too, so a locked composer cannot be sent from the keyboard', () => {
    const harness = renderComposer({ draft: 'one\ntwo', disabled: true });

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(harness.onSubmit).not.toHaveBeenCalled();
  });

  it('without `mentions` the field is still a growing textbox, with no combobox role', () => {
    renderComposer({ mentions: false, draft: 'Revise the plan' });

    expect(field().tagName).toBe('TEXTAREA');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a work item to plan around' })).toBeNull();
  });
});

// ── MOTIR-6239 — the coverage top-up ────────────────────────────────────────
// The picker's remaining keyboard and pointer paths, and the `@` trigger's
// spacing branch. Each is a shipped behaviour with no test of its own; they are
// here rather than in the integration file because they need no database and no
// browser, which is the tier test the story's own boundary sets.

describe('the picker’s remaining paths', () => {
  it('Tab DISMISSES the picker and lets focus move on', async () => {
    renderComposer();
    const el = type('@bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(tab);
    });

    // Not swallowed — Tab is how a keyboard user leaves the field, and a
    // dismissed picker must not also trap them in it.
    expect(tab.defaultPrevented).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('target-search-popup')).toBeNull());
  });

  it('↑ moves the active row UP, wrapping to the last', async () => {
    renderComposer();
    const el = type('@bil');
    await screen.findAllByRole('option', {}, { timeout: 3000 });

    // From the first row, ↑ wraps to the last.
    fireEvent.keyDown(el, { key: 'ArrowUp' });

    await waitFor(() =>
      expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true'),
    );
    expect(el.getAttribute('aria-activedescendant')).toBe('planning-target-option-1');
  });

  it('HOVERING a row makes it the active one, so the pointer and the keyboard agree', async () => {
    renderComposer();
    const el = type('@bil');
    const options = await screen.findAllByRole('option', {}, { timeout: 3000 });

    fireEvent.mouseEnter(options[1]!);

    await waitFor(() => expect(options[1]!.getAttribute('aria-selected')).toBe('true'));
    expect(el.getAttribute('aria-activedescendant')).toBe('planning-target-option-1');
  });

  it('CLICKING in the field re-derives the query from the caret it just moved', async () => {
    const harness = renderComposer();
    // A draft that already holds a mention token, with the caret at the END so
    // nothing is open yet — `findMentionQuery` reads the caret, not the text.
    const el = type('@bil and more', 13);
    expect(screen.queryByTestId('target-search-popup')).toBeNull();

    // The user clicks back inside the token. The click moves the caret first;
    // the handler is what notices.
    el.setSelectionRange(4, 4);
    fireEvent.click(el);

    await screen.findAllByRole('option', {}, { timeout: 3000 });
    expect(harness.onAddTarget).not.toHaveBeenCalled();
  });
});

describe('the `@` BUTTON’s spacing branch', () => {
  it('inserts a bare `@` on an EMPTY draft — no leading space to separate from', async () => {
    const harness = renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Add a work item to plan around' }));

    expect(harness.onDraftChange).toHaveBeenCalledWith('@');
    expect(await screen.findByText('Type to search the project’s work items…')).toBeTruthy();
  });

  it('inserts a bare `@` after a draft that ALREADY ends in whitespace', () => {
    const harness = renderComposer({ draft: 'Plan ' });

    fireEvent.click(screen.getByRole('button', { name: 'Add a work item to plan around' }));

    // One space, not two: the separator is added only when there is none.
    expect(harness.onDraftChange).toHaveBeenCalledWith('Plan @');
  });

  it('inserts at the CARET, not at the end, keeping the rest of the sentence', () => {
    const harness = renderComposer({ draft: 'Split the billing story' });
    const el = field();
    el.setSelectionRange(5, 5); // after "Split"

    fireEvent.click(screen.getByRole('button', { name: 'Add a work item to plan around' }));

    expect(harness.onDraftChange).toHaveBeenCalledWith('Split @ the billing story');
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

  it('closes the picker AT the target limit, so no row can be offered that cannot be added', async () => {
    const targets = Array.from({ length: MAX_PLANNING_TARGETS }, (_, i) => ({
      id: `w-${i}`,
      identifier: `MOTIR-${i}`,
      title: `Item ${i}`,
      kind: 'story' as const,
    }));
    renderComposer({ targets });

    type('@bil');

    // The dropdown never opens: `atLimit` closes it, and the tray says why.
    await waitFor(() => expect(screen.queryByTestId('target-search-popup')).toBeNull());
    expect(screen.getByText(/You can plan around up to 20 work items at once\./)).toBeTruthy();
  });
});
