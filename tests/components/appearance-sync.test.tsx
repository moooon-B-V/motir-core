// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/lib/contexts/theme-context';
import { STYLE_IDS } from '@/lib/theme/styles';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { TYPE_IDS } from '@/lib/theme/typography';
import type { AppearancePreferenceDto } from '@/lib/dto/appearancePreference';

// Subtask 7.3.62 — the ThemeProvider's cross-device SYNC behaviour. Each axis
// setter, for a signed-in user, flips the live state + localStorage instantly
// then debounces a PATCH to `/api/appearance-preference`, reconciled from the
// seq-guarded 200 body; a failure degrades to `syncState: 'error'` without
// losing the local switch; an anonymous visitor never writes. No jest-dom
// (project convention) — assertions read DOM text / fetch spy calls directly.

// Two non-default ids per axis to exercise the optimistic flip + the field
// mapping (the context's `palette` axis → the API's `paletteId`, the real
// drift risk this test guards).
const STYLE = STYLE_IDS[1]!;
const PALETTE = PALETTE_IDS[1]!;

/** A resolved-preference body echoing the four axes (the PATCH 200 shape). */
function preference(over: Partial<AppearancePreferenceDto> = {}): AppearancePreferenceDto {
  return {
    pattern: 'system',
    styleId: STYLE_IDS[0]!,
    paletteId: PALETTE_IDS[0]!,
    typeId: TYPE_IDS[0]!,
    fontPicks: {},
    ...over,
  };
}

function okResponse(pref: AppearancePreferenceDto) {
  return { ok: true, status: 200, json: async () => ({ preference: pref }) } as Response;
}

/** A probe that exposes the context state + buttons that fire each setter. */
function Probe() {
  const { palette, styleId, pattern, syncState, setPalette, setStyleId, setPattern } = useTheme();
  return (
    <div>
      <span data-testid="palette">{palette}</span>
      <span data-testid="style">{styleId}</span>
      <span data-testid="pattern">{pattern}</span>
      <span data-testid="sync">{syncState}</span>
      <button onClick={() => setPalette(PALETTE)}>palette</button>
      <button onClick={() => setStyleId(STYLE)}>style</button>
      <button onClick={() => setPattern('dark')}>pattern</button>
    </div>
  );
}

function renderProbe(signedIn: boolean) {
  return render(
    <ThemeProvider signedIn={signedIn}>
      <Probe />
    </ThemeProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ThemeProvider cross-device sync (7.3.62)', () => {
  it('flips optimistically, then PATCHes the changed axis with the API field name', async () => {
    fetchMock.mockResolvedValue(okResponse(preference({ paletteId: PALETTE })));
    renderProbe(true);

    fireEvent.click(screen.getByText('palette'));
    // Optimistic: the live value + localStorage flip instantly, before any write.
    expect(screen.getByTestId('palette').textContent).toBe(PALETTE);
    expect(localStorage.getItem('motir.theme.palette')).toBe(PALETTE);
    expect(fetchMock).not.toHaveBeenCalled(); // still debouncing

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/appearance-preference');
    expect(opts.method).toBe('PATCH');
    // The context's `palette` axis must be sent as the API's `paletteId`.
    expect(JSON.parse(opts.body as string)).toEqual({ paletteId: PALETTE });
    expect(screen.getByTestId('sync').textContent).toBe('idle');
  });

  it('does not write for an anonymous visitor', async () => {
    renderProbe(false);
    fireEvent.click(screen.getByText('palette'));
    expect(screen.getByTestId('palette').textContent).toBe(PALETTE); // still applies locally

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('sync').textContent).toBe('idle');
  });

  it('coalesces rapid changes across axes into one merged PATCH', async () => {
    fetchMock.mockResolvedValue(okResponse(preference({ paletteId: PALETTE, styleId: STYLE })));
    renderProbe(true);

    fireEvent.click(screen.getByText('palette'));
    fireEvent.click(screen.getByText('style'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const merged = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(merged.body as string)).toEqual({
      paletteId: PALETTE,
      styleId: STYLE,
    });
  });

  it('keeps the local switch and surfaces the error affordance when the write fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    renderProbe(true);

    fireEvent.click(screen.getByText('pattern'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // Optimistic value is NOT reverted; the affordance signal flips to error.
    expect(screen.getByTestId('pattern').textContent).toBe('dark');
    expect(screen.getByTestId('sync').textContent).toBe('error');
  });

  it("seq-guards: a superseded older response can't clobber the newer choice's status", async () => {
    // Flush 1 fails but resolves LATE; flush 2 succeeds first. The stale failure
    // must be ignored so it can't flip the affordance back to error.
    let rejectFirst!: (e: unknown) => void;
    const firstPending = new Promise<Response>((_, reject) => {
      rejectFirst = reject;
    });
    fetchMock
      .mockReturnValueOnce(firstPending)
      .mockResolvedValueOnce(okResponse(preference({ styleId: STYLE })));

    renderProbe(true);

    fireEvent.click(screen.getByText('palette'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250); // flush 1 (palette) fires, pending
    });
    fireEvent.click(screen.getByText('style'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250); // flush 2 (style) fires + resolves ok
    });
    expect(screen.getByTestId('sync').textContent).toBe('idle');

    // The older, superseded request finally fails — must be dropped by the guard.
    await act(async () => {
      rejectFirst(new Error('late network failure'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('sync').textContent).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// MOTIR-7897 — the per-language font pick: page-locale picks re-type <html> in
// the handler, other-locale picks touch no DOM, and both ride the shared
// debounced, seq-guarded PATCH, merged per locale.
describe('ThemeProvider setFontPick (MOTIR-7897)', () => {
  const html = document.documentElement;
  const fontAttrs = () => ({
    sans: html.getAttribute('data-font-set-sans'),
    serif: html.getAttribute('data-font-set-serif'),
    mono: html.getAttribute('data-font-set-mono'),
  });

  function FontProbe() {
    const { fontPicks, setFontPick, setType, syncState } = useTheme();
    return (
      <div>
        <span data-testid="picks">{JSON.stringify(fontPicks)}</span>
        <span data-testid="sync">{syncState}</span>
        <button onClick={() => setFontPick('ja', 'm-plus-rounded-1c')}>ja-mplus</button>
        <button onClick={() => setFontPick('ja', null)}>ja-auto</button>
        <button onClick={() => setFontPick('ko', 'nanum-gothic')}>ko-nanum</button>
        <button onClick={() => setType(TYPE_IDS[1]!)}>type</button>
      </div>
    );
  }

  function renderFontProbe(signedIn: boolean) {
    return render(
      <ThemeProvider signedIn={signedIn}>
        <FontProbe />
      </ThemeProvider>,
    );
  }

  const picks = () => JSON.parse(screen.getByTestId('picks').textContent ?? '{}');
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

  beforeEach(() => {
    html.lang = 'ja';
    for (const role of ['sans', 'serif', 'mono']) html.removeAttribute(`data-font-set-${role}`);
  });

  afterEach(() => {
    html.lang = '';
    for (const role of ['sans', 'serif', 'mono']) html.removeAttribute(`data-font-set-${role}`);
  });

  it('applies a page-locale pick to <html> in the same tick, and null removes it', async () => {
    fetchMock.mockResolvedValue(okResponse(preference({ fontPicks: { ja: 'm-plus-rounded-1c' } })));
    renderFontProbe(true);

    fireEvent.click(screen.getByText('ja-mplus'));
    expect(fontAttrs()).toEqual({ sans: 'm-plus-rounded-1c', serif: null, mono: null });
    expect(picks()).toEqual({ ja: 'm-plus-rounded-1c' });

    fireEvent.click(screen.getByText('ja-auto'));
    expect(fontAttrs()).toEqual({ sans: null, serif: null, mono: null });
    expect(picks()).toEqual({ ja: null });
  });

  it('changes no attribute for another language’s pick', () => {
    // The pending pick flushes on unmount, so the write needs an answer.
    fetchMock.mockResolvedValue(okResponse(preference({ fontPicks: { ko: 'nanum-gothic' } })));
    renderFontProbe(true);

    fireEvent.click(screen.getByText('ko-nanum'));

    expect(fontAttrs()).toEqual({ sans: null, serif: null, mono: null });
    expect(picks()).toEqual({ ko: 'nanum-gothic' });
  });

  it('sends two locales and another axis picked inside one window as ONE PATCH', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        preference({
          typeId: TYPE_IDS[1]!,
          fontPicks: { ja: 'm-plus-rounded-1c', ko: 'nanum-gothic' },
        }),
      ),
    );
    renderFontProbe(true);

    fireEvent.click(screen.getByText('ja-mplus'));
    fireEvent.click(screen.getByText('ko-nanum'));
    fireEvent.click(screen.getByText('type'));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/appearance-preference');
    expect(JSON.parse(opts.body as string)).toEqual({
      typeId: TYPE_IDS[1]!,
      fontPicks: { ja: 'm-plus-rounded-1c', ko: 'nanum-gothic' },
    });
    expect(picks()).toEqual({ ja: 'm-plus-rounded-1c', ko: 'nanum-gothic' });
    expect(screen.getByTestId('sync').textContent).toBe('idle');
  });

  it('keeps the newer pick when an older flush’s response resolves late', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(okResponse(preference({ fontPicks: {} })));
    renderFontProbe(true);

    fireEvent.click(screen.getByText('ja-mplus'));
    await flush(); // flush 1 (ja = m-plus) in flight
    fireEvent.click(screen.getByText('ja-auto'));
    await flush(); // flush 2 (ja = null) resolves first

    await act(async () => {
      resolveFirst(okResponse(preference({ fontPicks: { ja: 'm-plus-rounded-1c' } })));
    });

    expect(picks()).toEqual({ ja: null });
    expect(fontAttrs().sans).toBeNull();
  });

  it.each([
    ['a 422 refusal', () => Promise.resolve({ ok: false, status: 422, json: async () => ({}) })],
    ['a rejected fetch', () => Promise.reject(new Error('offline'))],
  ])('keeps the pick and surfaces the error state on %s', async (_label, failure) => {
    fetchMock
      .mockImplementationOnce(failure)
      .mockResolvedValueOnce(okResponse(preference({ fontPicks: { ko: 'nanum-gothic' } })));
    renderFontProbe(true);

    fireEvent.click(screen.getByText('ja-mplus'));
    await flush();

    expect(screen.getByTestId('sync').textContent).toBe('error');
    expect(picks()).toEqual({ ja: 'm-plus-rounded-1c' });
    expect(fontAttrs().sans).toBe('m-plus-rounded-1c');

    // A later successful save clears the state.
    fireEvent.click(screen.getByText('ko-nanum'));
    await flush();
    expect(screen.getByTestId('sync').textContent).toBe('idle');
  });

  it('does nothing for a signed-out visitor', async () => {
    renderFontProbe(false);

    fireEvent.click(screen.getByText('ja-mplus'));
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fontAttrs()).toEqual({ sans: null, serif: null, mono: null });
    expect(picks()).toEqual({});
    expect(localStorage.length).toBe(0);
  });
});
