// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { enMessages } from '../helpers/renderWithIntl';
import { AutoTranslateRoom } from '@/app/(authed)/settings/project/translation/_components/AutoTranslateRoom';
import type {
  ProjectAutoTranslateChangeDTO,
  ProjectAutoTranslateSettingsDTO,
} from '@/lib/dto/projectAutoTranslateSettings';

// AutoTranslateRoom (Story MOTIR-7738 · MOTIR-8830) — the Translation settings
// room, per `design/settings/auto-translate.mock.html` (MOTIR-8822). Driven under
// happy-dom (DB-free): the room is a client island over
// `GET / PATCH /api/projects/[key]/auto-translate`, so global fetch is stubbed and
// the DTOs have the exact shape the route answers with. Panels asserted:
//   1 off · 2 on · 3 in flight · 4 failed flip · 5 no credit · 6 read-only ·
//   7 history: loading / empty / rows / capped / failed (+ Try again).

function change(
  over: Partial<ProjectAutoTranslateChangeDTO> & Pick<ProjectAutoTranslateChangeDTO, 'id'>,
): ProjectAutoTranslateChangeDTO {
  return {
    changedByUserId: 'u1',
    changedByName: 'Ada Admin',
    fromEnabled: false,
    toEnabled: true,
    changedAt: '2026-10-16T09:30:00.000Z',
    ...over,
  };
}

function dto(
  enabled: boolean,
  changes: ProjectAutoTranslateChangeDTO[] = [],
  totalChanges = changes.length,
): ProjectAutoTranslateSettingsDTO {
  return { autoTranslateWorkContent: enabled, changes, totalChanges };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok(dto(false)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(
  props: Partial<{ canChange: boolean; noCredit: boolean; canAddCredit: boolean }> = {},
) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <AutoTranslateRoom
        projectKey="PROD"
        canChange={props.canChange ?? true}
        noCredit={props.noCredit ?? false}
        canAddCredit={props.canAddCredit ?? false}
      />
    </NextIntlClientProvider>,
  );
  await act(async () => {});
}

const toggle = () =>
  screen.getByRole('switch', { name: 'Auto-translate work content' }) as HTMLButtonElement;
const patchCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

async function press(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('AutoTranslateRoom — reading', () => {
  it('reads the stored value for the project key on mount (panel 1, off)', async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/PROD/auto-translate');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Off\. Work content shows as written/)).not.toBeNull();
    // The consequences list belongs to the ON face only.
    expect(screen.queryByText('What readers get')).toBeNull();
  });

  it('shows what readers get, and the cost line linking Usage & cost, when on (panel 2)', async () => {
    fetchMock.mockResolvedValue(ok(dto(true)));
    await mount();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('What readers get')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Usage & cost' }).getAttribute('href')).toBe(
      '/settings/organization/usage',
    );
  });

  it('shows the skeleton while the read is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(screen.getByTestId('auto-translate-skeleton').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('auto-translate-history-loading')).not.toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a failed read shows both failure faces, and Try again re-reads', async () => {
    fetchMock.mockResolvedValueOnce(fail(500)).mockResolvedValue(ok(dto(true)));
    await mount();
    expect(screen.getByTestId('auto-translate-failed').textContent).toContain(
      "Couldn't load this setting.",
    );
    expect(screen.getByTestId('auto-translate-history-failed').textContent).toContain(
      "Couldn't load the change history.",
    );
    await press(screen.getByTestId('auto-translate-retry'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('auto-translate-history-failed')).toBeNull();
  });

  it('treats a network failure like a failed read', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await mount();
    expect(screen.getByTestId('auto-translate-failed')).not.toBeNull();
  });
});

describe('AutoTranslateRoom — flipping (panels 3 and 4)', () => {
  it('commits at once: PATCHes the new value and replaces switch AND history from the response', async () => {
    const saved = dto(true, [change({ id: 'c1' })]);
    fetchMock.mockResolvedValueOnce(ok(dto(false))).mockResolvedValueOnce(ok(saved));
    await mount();
    await press(toggle());

    expect(patchCalls()).toHaveLength(1);
    const [url, init] = patchCalls()[0]!;
    expect(url).toBe('/api/projects/PROD/auto-translate');
    expect(JSON.parse(init.body)).toEqual({ autoTranslateWorkContent: true });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    // The new row is in the history without a second GET.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('auto-translate-history-row')).toHaveLength(1);
    expect(screen.queryByTestId('auto-translate-saving')).toBeNull();
  });

  it('moves optimistically and stops taking presses while the write is in flight', async () => {
    let resolvePatch!: (res: Response) => void;
    fetchMock
      .mockResolvedValueOnce(ok(dto(false)))
      .mockReturnValueOnce(new Promise<Response>((r) => (resolvePatch = r)));
    await mount();
    await press(toggle());

    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().disabled).toBe(true);
    expect(screen.getByTestId('auto-translate-saving').textContent).toContain('Saving…');
    await press(toggle());
    expect(patchCalls()).toHaveLength(1);

    await act(async () => resolvePatch(ok(dto(true, [change({ id: 'c1' })]))));
    expect(toggle().disabled).toBe(false);
  });

  it('returns to the value it held and says nothing was changed when the write fails', async () => {
    fetchMock.mockResolvedValueOnce(ok(dto(false))).mockResolvedValueOnce(fail(403));
    await mount();
    await press(toggle());

    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('alert').textContent).toContain(
      "Couldn't turn auto-translate on. Nothing was changed.",
    );
    // Nothing was recorded, so the history is untouched.
    expect(screen.getByTestId('auto-translate-history-empty')).not.toBeNull();
  });

  it('survives a network failure the same way, and Try again repeats the SAME flip', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(dto(true)))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        ok(dto(false, [change({ id: 'c2', fromEnabled: true, toEnabled: false })])),
      );
    await mount();
    await press(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('turn auto-translate off');

    await press(screen.getByTestId('auto-translate-flip-retry'));
    expect(JSON.parse(patchCalls()[1]![1].body)).toEqual({ autoTranslateWorkContent: false });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('AutoTranslateRoom — no credit (panel 5)', () => {
  it('warns with a link to add credits, only while the switch is on', async () => {
    fetchMock.mockResolvedValue(ok(dto(true)));
    await mount({ noCredit: true, canAddCredit: true });
    expect(screen.getByTestId('auto-translate-no-credit').textContent).toContain(
      'Translation needs AI credits.',
    );
    expect(screen.getByRole('link', { name: /Add credits/ }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );
  });

  it('names who can add credit when the actor cannot', async () => {
    fetchMock.mockResolvedValue(ok(dto(true)));
    await mount({ noCredit: true, canAddCredit: false });
    expect(screen.queryByRole('link', { name: /Add credits/ })).toBeNull();
    expect(screen.getByTestId('auto-translate-ask-admin').textContent).toContain(
      'An organization owner or admin can add them.',
    );
  });

  it('shows no warning while the switch is off, or when credit is fine', async () => {
    await mount({ noCredit: true });
    expect(screen.queryByTestId('auto-translate-no-credit')).toBeNull();
    cleanup();
    fetchMock.mockResolvedValue(ok(dto(true)));
    await mount({ noCredit: false });
    expect(screen.queryByTestId('auto-translate-no-credit')).toBeNull();
  });
});

describe('AutoTranslateRoom — read-only (panel 6)', () => {
  it('renders the value as a pill with the explanation and offers no switch', async () => {
    fetchMock.mockResolvedValue(ok(dto(true)));
    await mount({ canChange: false });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByTestId('auto-translate-readonly-pill').textContent).toContain('Read-only');
    expect(within(screen.getByTestId('auto-translate-value')).getByText('On')).not.toBeNull();
    expect(screen.getByText(/Auto-translate is on for this project/)).not.toBeNull();
    expect(screen.getByTestId('auto-translate-readonly-note').textContent).toContain(
      'Only a project admin can change auto-translate.',
    );
    expect(patchCalls()).toHaveLength(0);
  });

  it('still shows the change history to a reader', async () => {
    fetchMock.mockResolvedValue(ok(dto(false, [change({ id: 'c1' })])));
    await mount({ canChange: false });
    expect(screen.getAllByTestId('auto-translate-history-row')).toHaveLength(1);
  });
});

describe('AutoTranslateRoom — change history (panel 7)', () => {
  it('shows the empty state', async () => {
    await mount();
    expect(screen.getByTestId('auto-translate-history-empty').textContent).toContain(
      'No changes yet. Auto-translate has never been changed on this project.',
    );
  });

  it('reads each row as one sentence: who, from, to, when', async () => {
    fetchMock.mockResolvedValue(
      ok(
        dto(false, [
          change({ id: 'c2', fromEnabled: true, toEnabled: false, changedByName: 'Bo Admin' }),
          change({ id: 'c1' }),
        ]),
      ),
    );
    await mount();
    const rows = screen.getAllByTestId('auto-translate-history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute('aria-label')).toMatch(
      /^Bo Admin changed auto-translate from On to Off on /,
    );
    expect(rows[1]!.getAttribute('aria-label')).toMatch(
      /^Ada Admin changed auto-translate from Off to On on /,
    );
    expect(screen.queryByTestId('auto-translate-history-capped')).toBeNull();
  });

  it('names a removed account as a former member', async () => {
    fetchMock.mockResolvedValue(
      ok(dto(true, [change({ id: 'c1', changedByUserId: null, changedByName: null })])),
    );
    await mount();
    expect(screen.getByTestId('auto-translate-history-row').getAttribute('aria-label')).toMatch(
      /^A former member changed/,
    );
  });

  it('says how many it shows when the trail is longer than the read-back', async () => {
    fetchMock.mockResolvedValue(ok(dto(true, [change({ id: 'c1' }), change({ id: 'c2' })], 7)));
    await mount();
    expect(screen.getByTestId('auto-translate-history-capped').textContent).toContain(
      'Showing the 2 most recent of 7 changes.',
    );
  });
});
