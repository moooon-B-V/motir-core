// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type {
  PlatformPlannerModelListDTO,
  PlatformPlannerModelListEntryDTO,
} from '@/lib/dto/platformPlannerModel';

/**
 * The planning-model LIST card (MOTIR-7527, design `platform-admin` § AMENDMENT
 * 2026-10-04 Model lists, Panels 1–4 and 12). The actions are stubbed: their
 * codes have their own suite (`plannerListAction.test.ts`); here each code is
 * driven to the state the design draws for it.
 */

const addPlannerListModelAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
const removePlannerListModelAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/ai-planning/actions', () => ({
  addPlannerListModelAction,
  removePlannerListModelAction,
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { PlannerModelList } =
  await import('@/app/(admin)/admin/ai-planning/_components/PlannerModelList');
const { PlannerModelListUnavailable } =
  await import('@/app/(admin)/admin/ai-planning/_components/PlannerModelListUnavailable');

afterEach(() => {
  cleanup();
  addPlannerListModelAction.mockClear();
  removePlannerListModelAction.mockClear();
  refresh.mockClear();
});

function entry(
  model: string,
  over: Partial<PlatformPlannerModelListEntryDTO> = {},
): PlatformPlannerModelListEntryDTO {
  return {
    model,
    provider: 'anthropic',
    offered: true,
    reason: null,
    inUseBy: [],
    fallback: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    addedBy: null,
    seeded: true,
    ...over,
  };
}

function list(over: Partial<PlatformPlannerModelListDTO> = {}): PlatformPlannerModelListDTO {
  return {
    entries: [
      entry('claude-opus-5-5', { inUseBy: ['internal'], fallback: true }),
      entry('claude-sonnet-5-5', { inUseBy: ['customer'] }),
      entry('glm-5.2', {
        provider: null,
        offered: false,
        reason: 'unrated',
        seeded: false,
        addedBy: 'ops@moooon.net',
      }),
    ],
    canEdit: true,
    ...over,
  };
}

function renderList(l: PlatformPlannerModelListDTO) {
  return render(
    <ToastProvider>
      <PlannerModelList list={l} />
    </ToastProvider>,
  );
}

const rowOf = (model: string) => screen.getByTestId(`planner-model-list-row-${model}`);

async function removeWith(model: string, reason: string) {
  fireEvent.click(within(rowOf(model)).getByRole('button', { name: `Remove ${model}` }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove model' }));
  });
}

async function openAdd() {
  fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
  return screen.findByRole('alertdialog');
}

describe('PlannerModelList', () => {
  it('Panel 1: each entry with its provider, offered state, users and added line', () => {
    renderList(list());
    expect(screen.getByText('3 listed')).toBeTruthy();
    const opus = rowOf('claude-opus-5-5');
    expect(opus.textContent).toContain('anthropic');
    expect(opus.textContent).toContain('Offered');
    expect(opus.textContent).toContain('Internal organisations');
    expect(opus.textContent).toContain('Fallback for every audience');
    expect(opus.textContent).toContain('Seeded on first read');
    const glm = rowOf('glm-5.2');
    expect(glm.textContent).toContain('not in the catalog');
    expect(glm.textContent).toContain('Not offered');
    expect(glm.textContent).toContain('No planning rate is in force for it.');
    expect(glm.textContent).toContain('Nothing');
    expect(glm.textContent).toMatch(/Added .* by ops@moooon\.net/);
  });

  it('Panel 2: read-only — no Add, no Remove, one quiet line', () => {
    renderList(list({ canEdit: false }));
    expect(screen.queryByRole('button', { name: 'Add model' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByTestId('planner-model-list-read-only').textContent).toBe(
      'Only a superadmin can change these lists.',
    );
  });

  it('Panel 3a: an add needs a model and a reason, then sends both trimmed and says so', async () => {
    renderList(list());
    const dialog = await openAdd();
    const confirm = within(dialog).getByRole('button', { name: 'Add model' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Model id'), {
      target: { value: '  deepseek-v4-pro ' },
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: ' Try it ' } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(addPlannerListModelAction).toHaveBeenCalledWith('deepseek-v4-pro', 'Try it');
    expect(
      await screen.findByText('deepseek-v4-pro added. Any audience can be set to it now.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Panel 3b: refused by motir-ai — the dialog stays open with the localized reason', async () => {
    addPlannerListModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'NOT_QUALIFIED',
      reason: 'not_chat',
      detail: 'model "x" is not a chat model',
    });
    renderList(list());
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Model id'), { target: { value: 'x' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'r' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add model' }));
    });
    expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toBe(
      'Not added: Not a chat model, so it cannot plan.',
    );
  });

  it('an add refusal with no reason shows motir-ai’s own detail', async () => {
    addPlannerListModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'REFUSED',
      detail: 'something new',
    });
    renderList(list());
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Model id'), { target: { value: 'x' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'r' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add model' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Not added: something new');
  });

  it('Panel 4a: a remove sends the model and the reason, and says so', async () => {
    renderList(list());
    await removeWith('glm-5.2', ' unused ');
    expect(removePlannerListModelAction).toHaveBeenCalledWith('glm-5.2', 'unused');
    expect(await screen.findByText('glm-5.2 removed from the planning list.')).toBeTruthy();
  });

  it('Panel 4b: refused in use — the row names the audience', async () => {
    removePlannerListModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'IN_USE',
      audiences: ['customer'],
    });
    renderList(list());
    await removeWith('claude-sonnet-5-5', 'tidy');
    expect(within(rowOf('claude-sonnet-5-5')).getByRole('alert').textContent).toBe(
      'Not removed: Customer organisations plan on claude-sonnet-5-5. Move that audience to another model first.',
    );
  });

  it('Panel 4c: refused for the fallback', async () => {
    removePlannerListModelAction.mockResolvedValueOnce({ ok: false, code: 'FALLBACK' });
    renderList(list());
    await removeWith('claude-opus-5-5', 'tidy');
    expect(within(rowOf('claude-opus-5-5')).getByRole('alert').textContent).toContain(
      'claude-opus-5-5 is the fallback every audience plans on',
    );
  });

  it.each([
    ['UNAVAILABLE', 'motir-ai didn’t respond, so nothing was changed. Try again.'],
    ['NOT_PERMITTED', 'Only a superadmin can change this list.'],
    ['REASON_REQUIRED', 'A reason is required.'],
    ['FAILED', 'Something went wrong, and nothing was changed. Try again.'],
  ])('a %s remove shows its line on the row', async (code, text) => {
    removePlannerListModelAction.mockResolvedValueOnce({ ok: false, code });
    renderList(list());
    await removeWith('glm-5.2', 'r');
    expect(within(rowOf('glm-5.2')).getByRole('alert').textContent).toBe(text);
  });

  it('a REFUSED remove shows motir-ai’s detail', async () => {
    removePlannerListModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'REFUSED',
      detail: 'nope',
    });
    renderList(list());
    await removeWith('glm-5.2', 'r');
    expect(within(rowOf('glm-5.2')).getByRole('alert').textContent).toBe('Not removed: nope');
  });

  it('a MODEL_REQUIRED add asks for the id', async () => {
    addPlannerListModelAction.mockResolvedValueOnce({ ok: false, code: 'MODEL_REQUIRED' });
    renderList(list());
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Model id'), { target: { value: 'x' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'r' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add model' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Enter a model id.');
  });

  it('Panel 12b: a model this tab added reads “Added just now by you” once listed', async () => {
    const { rerender } = renderList(list());
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Model id'), { target: { value: 'kimi-k2.6' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'r' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add model' }));
    });
    const next = list();
    next.entries.push(entry('kimi-k2.6', { seeded: false, addedBy: 'me@moooon.net' }));
    rerender(
      <ToastProvider>
        <PlannerModelList list={next} />
      </ToastProvider>,
    );
    expect(rowOf('kimi-k2.6').textContent).toContain('Added just now by you');
  });

  it('Panel 11: unavailable — the error card with Retry re-reads', async () => {
    render(<PlannerModelListUnavailable />);
    expect(screen.getByText('Couldn’t load the planning-model list')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalled();
  });
});
