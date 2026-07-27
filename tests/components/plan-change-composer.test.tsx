// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { MAX_PLANNING_TARGETS, type PlanningTarget } from '@/lib/planning/planningTargets';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// The planning composer's `@`-mention TARGET picker (Subtask MOTIR-1491; design
// `design/ai-chat/target-picker.mock.html` panels 1, 2 and 4).
//
// `fetch` is the boundary that gets stubbed, and nothing else: the picker rides
// the SHIPPED `GET /api/work-items/mention-search` (5.8.5), so the URL these
// tests assert is the product's URL — a picker that quietly grew its own search
// endpoint would fail here.

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

beforeEach(() => {
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
      />
    );
  }

  return harness;
}

/** Type into the composer the way a person does — value AND caret. */
function type(value: string) {
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
  fireEvent.keyUp(input, { key: value.slice(-1) });
  return input;
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
    input.dispatchEvent(escape);

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
