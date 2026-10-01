// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// MOTIR-7050 — the report widget's "Debug with Motir AI" offer
// (`design/triage/report-widget--debug-offer.mock.html`; `design/triage/
// design-notes.md` § "The Debug with Motir AI offer"): rendered ONLY for a Bug
// the actor may debug; its press hands the surface the one seeded send and opens
// the project conversation; Close sends nothing; every other case closes and
// toasts exactly as the widget always has.

const { refresh, shallowPush } = vi.hoisted(() => ({ refresh: vi.fn(), shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/backlog',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

import { ReportWidgetModal } from '@/app/(authed)/_components/ReportWidgetModal';
import { ToastProvider } from '@/components/ui/Toast';
import { peekSurfaceSeed, resetSurfaceSeedForTests } from '@/lib/planning/surfaceSeed';

const TITLE = 'Board drag drops the card one column short';
const DESCRIPTION = 'Dragging a card into the rightmost column puts it in the column to its left.';

/** The footer's Close — the modal's own ✕ carries the same accessible name. */
function footerClose(): HTMLElement {
  const close = screen
    .getAllByRole('button', { name: 'Close' })
    .find((button) => button.textContent === 'Close');
  if (!close) throw new Error('no footer Close');
  return close;
}

const onOpenChange = vi.fn();
const onSubmitted = vi.fn();

function renderWidget(canDebug: boolean) {
  return renderWithIntl(
    <ToastProvider>
      <ReportWidgetModal
        open
        onOpenChange={onOpenChange}
        projectKey="PROD"
        onSubmitted={onSubmitted}
        canDebug={canDebug}
      />
    </ToastProvider>,
  );
}

async function submit(opts: { kind?: 'Bug' | 'Feature'; description?: string } = {}) {
  if (opts.kind === 'Feature') fireEvent.click(screen.getByRole('button', { name: /Feature/ }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: TITLE } });
  if (opts.description !== undefined) {
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: opts.description },
    });
  }
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  resetSurfaceSeedForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ identifier: 'PROD-412' }, { status: 201 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onOpenChange.mockReset();
  onSubmitted.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
});

describe('offered — a Bug, for an actor who may debug', () => {
  it('stays open on the success state: no Toast, the filed row, the helper line, the offer', async () => {
    renderWidget(true);
    await submit({ description: DESCRIPTION });

    const panel = await screen.findByTestId('report-debug-offer');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The two lines the Toast would have said head the panel instead.
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Thanks — your report was submitted');
    expect(status.textContent).toContain('Filed as PROD-412, now waiting in Requested features.');
    const filed = screen.getByTestId('report-debug-filed');
    expect(filed.textContent).toContain('PROD-412');
    expect(filed.textContent).toContain(TITLE);
    expect(panel.textContent).toContain(
      'Debug with Motir AI starts the debug as soon as you press it and spends Motir AI credits.',
    );

    // The press is the go, and the helper line is its accessible description.
    const offer = screen.getByRole('button', { name: 'Debug with Motir AI' });
    const hint = document.getElementById(offer.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('spends Motir AI credits');
    expect(footerClose()).toBeTruthy();

    // The item exists either way: the inbox tick and the server refresh both fired.
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('pressing it hands the ONE seeded send — the person’s words, anchored — and opens the project conversation', async () => {
    renderWidget(true);
    await submit({ description: DESCRIPTION });

    fireEvent.click(await screen.findByRole('button', { name: 'Debug with Motir AI' }));

    expect(peekSurfaceSeed()).toEqual({
      kind: 'send',
      body: `${TITLE}\n\n${DESCRIPTION}`,
      anchorKey: 'PROD-412',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The PROJECT conversation — the orb's own href — never a work-item launch.
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith('/backlog?plan=project&planFrom=project');
    // The widget itself sent nothing to Motir AI: its one request was the intake.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('with no description the seed is the title alone — no preamble', async () => {
    renderWidget(true);
    await submit();

    fireEvent.click(await screen.findByRole('button', { name: 'Debug with Motir AI' }));
    expect(peekSurfaceSeed()).toEqual({ kind: 'send', body: TITLE, anchorKey: 'PROD-412' });
  });

  it('Close closes and sends nothing', async () => {
    renderWidget(true);
    await submit({ description: DESCRIPTION });

    await screen.findByTestId('report-debug-offer');
    fireEvent.click(footerClose());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(peekSurfaceSeed()).toBeNull();
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('not rendered — the widget closes and toasts as it ships', () => {
  async function expectShippedToast() {
    expect(await screen.findByText('Thanks — your report was submitted')).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('report-debug-offer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Debug with Motir AI' })).toBeNull();
    expect(peekSurfaceSeed()).toBeNull();
  }

  it('no ai:plan, or Motir AI not configured (the orb’s gate is false)', async () => {
    renderWidget(false);
    await submit({ description: DESCRIPTION });
    await expectShippedToast();
  });

  it('a Feature, whatever the actor may do', async () => {
    renderWidget(true);
    await submit({ kind: 'Feature', description: DESCRIPTION });
    await expectShippedToast();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).kind).toBe('task');
  });
});
