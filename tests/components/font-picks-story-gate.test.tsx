// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { FONT_SET_ROLES, fontSetPickAttributes } from '@motir/design-system';
import {
  THEME_STORAGE_KEYS,
  ThemeProvider,
  useOptionalTheme,
  useTheme,
  type AppliedAppearanceDto,
} from '@/lib/contexts/theme-context';
import { DEFAULT_STYLE_ID, STYLE_IDS } from '@/lib/theme/styles';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { AppearanceCard } from '@/app/(authed)/settings/account/_components/AppearanceCard';
import {
  LanguageFontPicker,
  fontPickOptions,
} from '@/app/(authed)/settings/account/_components/LanguageFontPicker';
import type { FontPicks } from '@/lib/appearance/fontPicks';
import type { AppearancePreferenceDto } from '@/lib/dto/appearancePreference';
import { TYPE_IDS } from '@/lib/theme/typography';
import { SEAM_BODY, SEAM_LOCALE, SEAM_MEMBER } from '../helpers/fontPicksSeam';

// STORY INTEGRATION GATE (motir-core) — MOTIR-7900, the CLIENT half of the
// parity seam over story MOTIR-7736. `tests/integration/font-picks-story-gate.test.ts`
// proves the server stamps `fontSetPickAttributes(locale, member)` on the first
// byte for a pick PATCHed through the real route. This file proves the client
// stamps the SAME attributes the moment the pick is made — through
// `setFontPick` and through the Typography chip on the settings page
// (`LanguageFontPicker`, rendered by `AppearanceCard` on a ja page) — and sends
// the SAME body the server half PATCHes (`SEAM_BODY`), so the two files describe
// one round trip. No `data-font-set-*` value is written out by hand: the
// expectation is always the helper's.

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
});

let fetchMock: ReturnType<typeof vi.fn>;

function preference(fontPicks: FontPicks): AppearancePreferenceDto {
  return {
    pattern: 'system',
    styleId: 'motir',
    paletteId: 'motir',
    typeId: TYPE_IDS[0]!,
    fontPicks,
  } as AppearancePreferenceDto;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  // Echo the server's resolved body for what was sent, as the route does.
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      fontPicks?: FontPicks;
      typeId?: string;
    };
    const resolved = preference(body.fontPicks ?? {});
    if (body.typeId) resolved.typeId = body.typeId;
    return { ok: true, status: 200, json: async () => ({ preference: resolved }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  document.documentElement.lang = SEAM_LOCALE;
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.lang = '';
  for (const role of FONT_SET_ROLES)
    document.documentElement.removeAttribute(`data-font-set-${role}`);
});

/** Every `data-font-set-*` attribute `<html>` carries right now. */
function htmlFontSetAttrs(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.documentElement.attributes)
      .filter((a) => a.name.startsWith('data-font-set-'))
      .map((a) => [a.name, a.value]),
  );
}

/** The bodies of every PATCH sent, once the debounce has fired and settled. */
async function flushedBodies(): Promise<unknown[]> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

function PickProbe() {
  const { setFontPick } = useTheme();
  return <button onClick={() => setFontPick(SEAM_LOCALE, SEAM_MEMBER)}>pick</button>;
}

describe('client = server — setFontPick', () => {
  it('stamps exactly fontSetPickAttributes and sends the integration seam’s body', async () => {
    const expected = fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER);
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    render(
      <ThemeProvider signedIn>
        <PickProbe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick' }));

    expect(htmlFontSetAttrs()).toEqual(expected);
    const bodies = await flushedBodies();
    expect(bodies).toEqual([SEAM_BODY]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/appearance-preference');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('PATCH');
    // The reconcile from the 200 body leaves the same attributes in place.
    expect(htmlFontSetAttrs()).toEqual(expected);
  });

  it('replaces a stale attribute set rather than adding to it', () => {
    document.documentElement.setAttribute('data-font-set-serif', 'stale-member');
    render(
      <ThemeProvider signedIn>
        <PickProbe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick' }));

    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));
  });
});

describe('client = server — the Typography chip on a ja page', () => {
  it('a chip click produces the same attributes and the same body', async () => {
    renderWithIntl(
      <ThemeProvider signedIn>
        <AppearanceCard initialFontPicks={{}} />
      </ThemeProvider>,
      { locale: SEAM_LOCALE },
    );
    expect(htmlFontSetAttrs()).toEqual({});

    fireEvent.click(screen.getByRole('radio', { name: /M PLUS Rounded 1c/ }));

    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));
    expect(await flushedBodies()).toEqual([SEAM_BODY]);
    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));
  });
});

describe('client = server — the server’s answer is what stays on <html>', () => {
  function respondWith(fontPicks: FontPicks) {
    fetchMock.mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ preference: preference(fontPicks) }),
        }) as Response,
    );
  }

  it('a pick the server did not keep is taken back off <html> by the reconcile', async () => {
    respondWith({});
    render(
      <ThemeProvider signedIn>
        <PickProbe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));

    expect(await flushedBodies()).toEqual([SEAM_BODY]);
    // The resolved 200 body said "automatic" for ja — what the first byte of
    // the next page would stamp — so the client now stamps the same: nothing.
    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, null));
    expect(htmlFontSetAttrs()).toEqual({});
  });

  it('a pick for another language is saved but never stamped on this page', async () => {
    function KoProbe() {
      const { setFontPick, fontPicks } = useTheme();
      return (
        <>
          <span data-testid="picks">{JSON.stringify(fontPicks)}</span>
          <button onClick={() => setFontPick('ko', 'nanum-gothic')}>ko</button>
        </>
      );
    }
    render(
      <ThemeProvider signedIn>
        <KoProbe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'ko' }));

    expect(htmlFontSetAttrs()).toEqual({});
    expect(await flushedBodies()).toEqual([{ fontPicks: { ko: 'nanum-gothic' } }]);
    expect(htmlFontSetAttrs()).toEqual({});
    expect(JSON.parse(screen.getByTestId('picks').textContent!)).toEqual({ ko: 'nanum-gothic' });
  });

  it('signed out, a pick stamps nothing and sends nothing', async () => {
    render(
      <ThemeProvider>
        <PickProbe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick' }));

    expect(htmlFontSetAttrs()).toEqual({});
    expect(await flushedBodies()).toEqual([]);
  });
});

describe('client = server — overlapping and failed saves', () => {
  /** A fetch whose answers the test releases by hand, in any order. */
  function deferredFetch() {
    const pending: Array<{ resolve: (r: Response) => void; reject: (e: Error) => void }> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    return pending;
  }

  function okBody(fontPicks: FontPicks): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ preference: preference(fontPicks) }),
    } as Response;
  }

  function TwoPicks() {
    const { setFontPick, syncState } = useTheme();
    return (
      <>
        <span data-testid="sync">{syncState}</span>
        <button onClick={() => setFontPick(SEAM_LOCALE, SEAM_MEMBER)}>pick</button>
        <button onClick={() => setFontPick(SEAM_LOCALE, null)}>auto</button>
      </>
    );
  }

  async function tick() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it('an older answer that lands after a newer save cannot put its pick back', async () => {
    const pending = deferredFetch();
    render(
      <ThemeProvider signedIn>
        <TwoPicks />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'auto' }));
    await tick();
    expect(pending).toHaveLength(2);
    expect(htmlFontSetAttrs()).toEqual({});

    // The FIRST save's answer arrives last-but-one, carrying the old pick.
    await act(async () => {
      pending[0]!.resolve(okBody({ [SEAM_LOCALE]: SEAM_MEMBER }));
    });
    expect(htmlFontSetAttrs()).toEqual({});

    await act(async () => {
      pending[1]!.resolve(okBody({}));
    });
    expect(htmlFontSetAttrs()).toEqual({});
    expect(screen.getByTestId('sync').textContent).toBe('idle');
  });

  it('a failed save keeps the local pick and says so; a superseded failure says nothing', async () => {
    const pending = deferredFetch();
    render(
      <ThemeProvider signedIn>
        <TwoPicks />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'auto' }));
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    await tick();

    // The older save fails after the newer one was sent: no affordance.
    await act(async () => {
      pending[0]!.reject(new Error('offline'));
    });
    expect(screen.getByTestId('sync').textContent).toBe('idle');

    // The newer save fails too: the pick stays on <html>, and the pane is told.
    await act(async () => {
      pending[1]!.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
    });
    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));
    expect(screen.getByTestId('sync').textContent).toBe('error');
  });
});

describe('client = server — a language with no fonts to pick', () => {
  it('offers Automatic alone on a Latin page, and choosing it stamps nothing', async () => {
    document.documentElement.lang = 'en';
    const options = fontPickOptions('en');
    expect(options).toEqual({
      choosableRoles: [],
      defaultFamily: null,
      defaultCssVar: null,
      members: [],
    });
    renderWithIntl(
      <ThemeProvider signedIn>
        <LanguageFontPicker locale="en" initialFontPicks={{}} label="Typography" />
      </ThemeProvider>,
      { locale: 'en' },
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]!.querySelector('span')!.getAttribute('style')).toBeNull();

    fireEvent.click(radios[0]!);

    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes('en', null));
    // Absence is the one legal Latin value, the same `{ en: null }` the
    // integration gate PATCHes to a 200.
    expect(await flushedBodies()).toEqual([{ fontPicks: { en: null } }]);
  });
});

// The root layout hands the provider TWO things from one `getAppliedForRequest`
// read: the applied axes (`initialPreference`) and, beside them, the font-set
// attributes. The cases below pin the provider's half of that hand-off — how it
// seeds from the axes (or, with none, from this device) while a font pick rides
// alongside — which is also what lifts `theme-context.tsx` to its floor.
describe('the provider the first byte seeds, with a font pick beside it', () => {
  function AxesProbe() {
    const theme = useTheme();
    return (
      <>
        <span data-testid="axes">
          {JSON.stringify([theme.resolvedPattern, theme.styleId, theme.palette, theme.type])}
        </span>
        <button onClick={() => theme.setFontPick(SEAM_LOCALE, SEAM_MEMBER)}>pick</button>
        <button onClick={() => theme.setType(TYPE_IDS[1]!)}>type</button>
      </>
    );
  }
  const axes = () => JSON.parse(screen.getByTestId('axes').textContent!) as string[];

  function seeded(initialPreference: AppliedAppearanceDto | null) {
    return render(
      <ThemeProvider signedIn initialPreference={initialPreference}>
        <AxesProbe />
      </ThemeProvider>,
    );
  }

  it('a pinned server preference seeds every axis; a pick then stamps the helper’s attributes', async () => {
    const pref: AppliedAppearanceDto = {
      pattern: 'dark',
      styleId: STYLE_IDS[1]!,
      paletteId: PALETTE_IDS[1]!,
      typeId: TYPE_IDS[1]!,
      typePinned: true,
    };
    seeded(pref);
    expect(axes()).toEqual(['dark', pref.styleId, pref.paletteId, pref.typeId]);

    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));
    expect(await flushedBodies()).toEqual([SEAM_BODY]);
    // The font pick sent no axis, so the seeded axes are untouched.
    expect(axes()).toEqual(['dark', pref.styleId, pref.paletteId, pref.typeId]);
  });

  it('retired server ids fall back to the defaults, and an unpinned type follows the style', () => {
    seeded({
      pattern: 'light',
      styleId: 'retired-style',
      paletteId: 'retired-palette',
      typeId: 'retired-type',
      typePinned: true,
    });
    const [, style, palette, type] = axes();
    expect(style).toBe(DEFAULT_STYLE_ID);
    expect(palette).toBe(DEFAULT_PALETTE_ID);
    expect(TYPE_IDS).toContain(type);
    expect(type).not.toBe('retired-type');
  });

  it('with no server preference, this device’s valid choices seed it; stale ones do not', () => {
    localStorage.setItem(THEME_STORAGE_KEYS.style, 'retired-style');
    localStorage.setItem(THEME_STORAGE_KEYS.palette, PALETTE_IDS[1]!);
    localStorage.setItem(THEME_STORAGE_KEYS.type, TYPE_IDS[1]!);
    seeded(null);
    const [, style, palette, type] = axes();
    expect(style).toBe(DEFAULT_STYLE_ID);
    expect(palette).toBe(PALETTE_IDS[1]);
    expect(type).toBe(TYPE_IDS[1]);
  });

  it('a dark OS and an unreadable device store still seed a working provider', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as MediaQueryList);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    try {
      seeded(null);
      expect(axes()[0]).toBe('dark');
      expect(axes()[1]).toBe(DEFAULT_STYLE_ID);
      fireEvent.click(screen.getByRole('button', { name: 'pick' }));
      expect(htmlFontSetAttrs()).toEqual(fontSetPickAttributes(SEAM_LOCALE, SEAM_MEMBER));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a type and a font pick in one window travel in one body, reconciled together', async () => {
    seeded(null);
    fireEvent.click(screen.getByRole('button', { name: 'type' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    const bodies = await flushedBodies();
    expect(bodies).toEqual([{ typeId: TYPE_IDS[1], ...SEAM_BODY }]);
    expect(axes()[3]).toBe(TYPE_IDS[1]);
  });

  it('outside a provider, useTheme refuses and useOptionalTheme answers null', () => {
    function Bare() {
      return <span data-testid="optional">{String(useOptionalTheme())}</span>;
    }
    render(<Bare />);
    expect(screen.getByTestId('optional').textContent).toBe('null');
    function Strict() {
      useTheme();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Strict />)).toThrow(/inside <ThemeProvider>/);
    } finally {
      spy.mockRestore();
    }
  });
});
