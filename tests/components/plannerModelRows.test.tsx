// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type {
  PlatformPlannerModelRowDTO,
  PlatformPlannerModelSettingsDTO,
} from '@/lib/dto/platformPlannerModel';

/**
 * The AI planning table (MOTIR-7231, design `platform-admin` § AMENDMENT
 * 2026-10, Panels 1, 2, 4–8). The action is stubbed: its codes have their own
 * suite (`plannerModelAction.test.ts`); here each code is driven to the state
 * the design draws for it.
 */

const setPlannerModelAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/ai-planning/actions', () => ({ setPlannerModelAction }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { PlannerModelRows } =
  await import('@/app/(admin)/admin/ai-planning/_components/PlannerModelRows');

afterEach(() => {
  cleanup();
  setPlannerModelAction.mockClear();
  refresh.mockClear();
});

function row(over: Partial<PlatformPlannerModelRowDTO> = {}): PlatformPlannerModelRowDTO {
  return {
    audience: 'internal',
    model: 'claude-opus-5-5',
    offered: true,
    reachable: true,
    lastProbeAt: null,
    lastProbeError: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: null,
    seeded: true,
    ...over,
  };
}

function settings(
  over: Partial<PlatformPlannerModelSettingsDTO> = {},
  internal: Partial<PlatformPlannerModelRowDTO> = {},
): PlatformPlannerModelSettingsDTO {
  return {
    rows: [
      row({ audience: 'customer' }),
      row({ audience: 'meta' }),
      row({ audience: 'internal', ...internal }),
    ],
    offered: [
      { id: 'gpt-5', provider: 'openai' },
      { id: 'claude-sonnet-5-5', provider: 'anthropic' },
      { id: 'claude-opus-5-5', provider: 'anthropic' },
    ],
    canEdit: true,
    ...over,
  };
}

function renderRows(s: PlatformPlannerModelSettingsDTO) {
  return render(
    <ToastProvider>
      <PlannerModelRows settings={s} />
    </ToastProvider>,
  );
}

const internalRow = () => screen.getByTestId('ai-planning-row-internal');

function pick(model: RegExp) {
  fireEvent.click(
    within(internalRow()).getByRole('combobox', {
      name: 'Planning model — Internal organisations',
    }),
  );
  fireEvent.click(screen.getByRole('option', { name: model }));
}

async function confirmWith(reason: string) {
  fireEvent.click(within(internalRow()).getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change model' }));
  });
}

describe('PlannerModelRows', () => {
  it('Panel 1: offered models only, grouped by provider; Save disabled until dirty', () => {
    renderRows(settings());
    const save = within(internalRow()).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(
      within(internalRow()).getByRole('combobox', {
        name: 'Planning model — Internal organisations',
      }),
    );
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    // anthropic before openai, ids sorted inside a group
    expect(options[0]).toMatch(/claude-opus-5-5/);
    expect(options[1]).toMatch(/claude-sonnet-5-5/);
    expect(options[2]).toMatch(/gpt-5/);
    fireEvent.click(screen.getByRole('option', { name: /gpt-5/ }));
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  it('Panel 4: the confirm cannot be sent with a blank reason', async () => {
    renderRows(settings());
    pick(/claude-sonnet-5-5/);
    fireEvent.click(within(internalRow()).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('claude-opus-5-5 → claude-sonnet-5-5');
    const confirm = within(dialog).getByRole('button', { name: 'Change model' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(setPlannerModelAction).not.toHaveBeenCalled();
  });

  it('Panel 5: a save calls the action with the trimmed reason and says so', async () => {
    renderRows(settings());
    pick(/claude-sonnet-5-5/);
    await confirmWith('  Cheaper  ');
    expect(setPlannerModelAction).toHaveBeenCalledWith('internal', 'claude-sonnet-5-5', 'Cheaper');
    expect(await screen.findByText('Planning model changed')).toBeTruthy();
  });

  it('Panel 6: refused — keeps the stored model, names the model, re-reads', async () => {
    setPlannerModelAction.mockResolvedValueOnce({ ok: false, code: 'NOT_OFFERED' });
    renderRows(settings());
    pick(/claude-sonnet-5-5/);
    await confirmWith('x');
    const alert = within(internalRow()).getByRole('alert');
    expect(alert.textContent).toContain('claude-sonnet-5-5 is no longer offered');
    expect(refresh).toHaveBeenCalled();
    expect(
      within(internalRow()).getByRole('button', { name: 'Save' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('Panel 8 left: unreachable — localizes the probe reason', async () => {
    setPlannerModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'UNREACHABLE',
      reason: 'the provider key was refused (401)',
    });
    renderRows(settings());
    pick(/claude-sonnet-5-5/);
    await confirmWith('x');
    expect(within(internalRow()).getByRole('alert').textContent).toBe(
      'Not saved: the planner could not reach claude-sonnet-5-5 — the provider key was refused.',
    );
  });

  it('Panel 7: a withdrawn stored model gets the warning chip and the fallback', () => {
    renderRows(settings({}, { model: 'claude-old-1', offered: false }));
    const chip = within(internalRow()).getByTestId('ai-planning-withdrawn');
    expect(chip.textContent).toContain('No longer offered');
    expect(chip.textContent).toContain('falls back to claude-opus-5-5');
  });

  it('Panel 8 right: a failing stored model gets the danger chip', () => {
    renderRows(settings({}, { reachable: false, lastProbeAt: '2026-10-02T08:00:00.000Z' }));
    expect(within(internalRow()).getByTestId('ai-planning-failing').textContent).toContain(
      'Planning is failing',
    );
  });

  it('Panel 2: read-only — plain text, no picker, no Save, one quiet line', () => {
    renderRows(settings({ canEdit: false }));
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Save' })).toHaveLength(0);
    expect(screen.getByTestId('ai-planning-read-only').textContent).toBe(
      'Only a superadmin can change these.',
    );
    expect(internalRow().textContent).toContain('claude-opus-5-5');
    expect(internalRow().textContent).toContain('anthropic');
  });

  it('the last-changed line: seeded, by a named operator', () => {
    renderRows(settings({}, { seeded: false, updatedBy: 'Ops superadmin' }));
    expect(screen.getByTestId('ai-planning-row-customer').textContent).toContain(
      'Seeded default · never changed',
    );
    expect(internalRow().textContent).toMatch(/Changed .* by Ops superadmin/);
  });
});
