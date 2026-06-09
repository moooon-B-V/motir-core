// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  EstimationSettingsEditor,
  configsEqual,
} from '@/app/(authed)/settings/project/estimation/_components/EstimationSettingsEditor';
import { deckForScale } from '@/lib/estimation/decks';
import type { EstimationConfigDto } from '@/lib/dto/estimation';

// EstimationSettingsEditor (Subtask 4.3.6) — the project Estimation settings
// form. Driven under happy-dom (DB-free): the editor is a pure client consumer
// of the 4.3.3 PATCH /api/projects/[key]/estimation-config endpoint, so we stub
// global fetch and assert (a) the statistic + scale render, (b) the statistic
// switch hides the story-points-only scale field, (c) the custom-scale editor +
// its empty-validation, (d) the optimistic Save firing the right PATCH (and the
// revert on failure), and (e) the read-only (non-admin) treatment. The full
// estimate-a-story flow (the real stack) is the 4.3.7 Playwright E2E.

function cfg(over: Partial<EstimationConfigDto> = {}): EstimationConfigDto {
  return {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function save() {
  return screen.getByTestId('estimation-save') as HTMLButtonElement;
}

let fetchMock: ReturnType<typeof vi.fn>;
function stubFetchOk() {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
}
function stubFetchErr() {
  fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => stubFetchOk());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('deckForScale', () => {
  it('returns the fixed preset for fibonacci / linear and the project deck for custom', () => {
    expect(deckForScale('fibonacci', [])).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(deckForScale('linear', [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(deckForScale('custom', [1, 2, 4])).toEqual([1, 2, 4]);
  });
});

describe('configsEqual', () => {
  it('compares statistic, scale, and the custom deck', () => {
    expect(configsEqual(cfg(), cfg())).toBe(true);
    expect(configsEqual(cfg(), cfg({ pointScale: 'linear' }))).toBe(false);
    expect(
      configsEqual(cfg({ customScaleValues: [1, 2] }), cfg({ customScaleValues: [1, 3] })),
    ).toBe(false);
  });
});

describe('EstimationSettingsEditor', () => {
  it('renders the statistic + scale with the defaults pressed and the Fibonacci deck preview', () => {
    render(<EstimationSettingsEditor projectKey="PRJ" config={cfg()} isAdmin />);
    expect(screen.getByRole('button', { name: 'Story points' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Fibonacci' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const deck = screen.getByTestId('estimation-deck');
    expect(deck.textContent).toContain('1');
    expect(deck.textContent).toContain('21');
    // Pristine — Save is disabled.
    expect(save().disabled).toBe(true);
  });

  it('hides the point-scale field when the statistic is not Story points', () => {
    render(<EstimationSettingsEditor projectKey="PRJ" config={cfg()} isAdmin />);
    expect(screen.getByText('Point scale')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Time estimate' }));
    expect(screen.queryByText('Point scale')).toBeNull();
    // The statistic switch made it dirty → Save is enabled.
    expect(save().disabled).toBe(false);
  });

  it('shows the custom-scale editor for Custom and blocks an empty deck', () => {
    render(
      <EstimationSettingsEditor
        projectKey="PRJ"
        config={cfg({ pointScale: 'custom', customScaleValues: [1, 2, 4] })}
        isAdmin
      />,
    );
    expect(screen.getByTestId('estimation-custom').textContent).toContain('4');

    // Add a value via the add affordance.
    fireEvent.click(screen.getByTestId('estimation-add'));
    const input = screen.getByTestId('estimation-add-input');
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('estimation-custom').textContent).toContain('8');

    // Remove every chip → empty custom deck → error + Save blocked. Re-query
    // each pass: removing a chip re-renders, so cached button refs go stale.
    let removeBtns = screen.queryAllByRole('button', { name: /^Remove / });
    while (removeBtns.length > 0) {
      fireEvent.click(removeBtns[0]!);
      removeBtns = screen.queryAllByRole('button', { name: /^Remove / });
    }
    expect(screen.getByTestId('estimation-custom-empty')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('optimistically PATCHes the config on Save', async () => {
    render(<EstimationSettingsEditor projectKey="PRJ" config={cfg()} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: 'Linear' }));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/PRJ/estimation-config');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toMatchObject({ pointScale: 'linear' });
    // Reconciled — committed now equals working, so Save disables again.
    await waitFor(() => expect(save().disabled).toBe(true));
  });

  it('reverts the committed snapshot when the save fails', async () => {
    stubFetchErr();
    render(<EstimationSettingsEditor projectKey="PRJ" config={cfg()} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: 'Linear' }));
    fireEvent.click(save());
    // After the failure the edit is still dirty, so Save re-enables for a retry.
    await waitFor(() => expect(save().disabled).toBe(false));
    expect(screen.getByRole('button', { name: 'Linear' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('renders read-only for a non-admin (banner, disabled controls, no Save)', () => {
    render(<EstimationSettingsEditor projectKey="PRJ" config={cfg()} isAdmin={false} />);
    expect(screen.getByTestId('estimation-readonly-banner')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Story points' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId('estimation-save')).toBeNull();
  });
});
