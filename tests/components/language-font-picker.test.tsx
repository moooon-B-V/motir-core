// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  FONT_SET_LOCALES,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  fontSetMemberVar,
  type FontSetLocale,
} from '@motir/design-system';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import {
  fontPickOptions,
  selectedFontPick,
} from '@/app/(authed)/settings/account/_components/LanguageFontPicker';
import { AppearanceCard } from '@/app/(authed)/settings/account/_components/AppearanceCard';
import type { FontPicks } from '@/lib/appearance/fontPicks';
import type { AppearancePreferenceDto } from '@/lib/dto/appearancePreference';
import { TYPE_IDS, TYPE_REGISTRY } from '@/lib/theme/typography';

// MOTIR-7899 — the Typography axis follows the page's language, drawn to the
// approved revision-3 design (`design/settings/appearance--fonts-by-language.mock.html`):
// a Latin page keeps the type pairings, a ja / ko / zh page lists Automatic and
// then that language's fonts, each in its own face. Expectations are derived
// from the registry; only this file names member ids.

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

function preference(over: Partial<AppearancePreferenceDto> = {}): AppearancePreferenceDto {
  return {
    pattern: 'system',
    styleId: 'motir',
    paletteId: 'motir',
    typeId: TYPE_IDS[0]!,
    fontPicks: {},
    ...over,
  } as AppearancePreferenceDto;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Partial<AppearancePreferenceDto>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ preference: preference({ fontPicks: body.fontPicks as FontPicks }) }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
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

function renderCard(locale: string, initialFontPicks: FontPicks = {}) {
  document.documentElement.lang = locale;
  return render(
    <ThemeProvider signedIn>
      <AppearanceCard initialFontPicks={initialFontPicks} />
    </ThemeProvider>,
    { locale },
  );
}

function typographyGroup() {
  return screen.getByRole('radiogroup', { name: 'Typography' });
}

function radios() {
  return Array.from(typographyGroup().querySelectorAll<HTMLElement>('[role="radio"]'));
}

function checkedLabel() {
  return radios().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? null;
}

describe('fontPickOptions', () => {
  it('offers nothing for every Latin locale', () => {
    for (const locale of FONT_SET_LOCALES.filter((l) => LOCALE_FONT_SET[l] === 'latin')) {
      expect(fontPickOptions(locale).members).toEqual([]);
    }
  });

  it('offers only the roles with two or more faces, as the registry lists them', () => {
    for (const locale of FONT_SET_LOCALES) {
      const setId = LOCALE_FONT_SET[locale];
      const set = FONT_SET_REGISTRY[setId];
      const roles = FONT_SET_ROLES.filter(
        (role) =>
          set.roles[role].members.filter((m) => m.source.kind !== 'type-pairing').length >= 2,
      );
      const expected = roles.flatMap((role) =>
        set.roles[role].members.map((m) => ({
          id: m.id,
          family: m.family,
          role,
          cssVar: fontSetMemberVar(setId, role, m.id),
        })),
      );
      expect(fontPickOptions(locale).choosableRoles).toEqual(roles);
      expect(fontPickOptions(locale).members).toEqual(expected);
    }
  });

  it('gives ja and ko only sans faces and zh only serif faces', () => {
    expect(fontPickOptions('ja').choosableRoles).toEqual(['sans']);
    expect(fontPickOptions('ko').choosableRoles).toEqual(['sans']);
    expect(fontPickOptions('zh').choosableRoles).toEqual(['serif']);
    expect(fontPickOptions('zh').defaultFamily).toBe('Noto Serif SC');
  });
});

describe('selectedFontPick', () => {
  const offered = ['noto-sans-jp', 'm-plus-rounded-1c'];
  const ja: FontSetLocale = 'ja';

  it('prefers the session pick, then the baseline, then Automatic', () => {
    expect(selectedFontPick(ja, {}, {}, offered)).toBeNull();
    expect(selectedFontPick(ja, {}, { ja: 'm-plus-rounded-1c' }, offered)).toBe(
      'm-plus-rounded-1c',
    );
    expect(selectedFontPick(ja, { ja: 'noto-sans-jp' }, { ja: 'm-plus-rounded-1c' }, offered)).toBe(
      'noto-sans-jp',
    );
  });

  it('shows Automatic for a session null even when the baseline has a pick', () => {
    expect(selectedFontPick(ja, { ja: null }, { ja: 'm-plus-rounded-1c' }, offered)).toBeNull();
  });

  it('shows Automatic for a stored id the language does not offer', () => {
    expect(selectedFontPick(ja, {}, { ja: 'noto-serif-jp' }, offered)).toBeNull();
  });
});

describe('AppearanceCard Typography by page language (MOTIR-7899)', () => {
  it('lists the type pairings on an English page, as shipped', () => {
    renderCard('en');
    expect(radios().map((r) => r.textContent)).toEqual(
      TYPE_IDS.map((id) => TYPE_REGISTRY[id].name),
    );
  });

  it('lists Automatic and the Japanese fonts on a Japanese page, each in its own face', () => {
    renderCard('ja');
    const { members, defaultFamily } = fontPickOptions('ja');
    const labels = radios().map((r) => r.querySelector('span')?.textContent);
    expect(labels).toEqual([`Automatic (${defaultFamily})`, ...members.map((m) => m.family)]);
    expect(labels).toEqual(['Automatic (Noto Sans JP)', 'Noto Sans JP', 'M PLUS Rounded 1c']);
    // No pairing is offered on this page.
    const names = radios().map((r) => r.textContent);
    for (const id of TYPE_IDS) expect(names).not.toContain(TYPE_REGISTRY[id].name);
    radios()
      .slice(1)
      .forEach((radio, i) => {
        const span = radio.querySelector('span')!;
        expect(span.getAttribute('style')).toContain(`var(${members[i]!.cssVar})`);
        const sample = radio.querySelector('span[lang="ja"]')!;
        expect(sample.textContent).toBe('ひらがなと漢字');
      });
    expect(checkedLabel()).toContain('Automatic');
  });

  it('labels Automatic by the default family on Korean and Chinese pages', () => {
    renderCard('ko');
    expect(radios()[0]!.textContent).toContain('Automatic (Noto Sans KR)');
    cleanup();
    renderCard('zh');
    expect(radios().map((r) => r.querySelector('span')?.textContent)).toEqual([
      'Automatic (Noto Serif SC)',
      'Noto Serif SC',
      'LXGW WenKai TC',
    ]);
  });

  it('seeds the selection from the stored picks', () => {
    renderCard('ko', { ko: 'nanum-gothic' });
    expect(checkedLabel()).toContain('Nanum Gothic');
  });

  it('picks a font, applies it to the page and saves it; Automatic clears it', async () => {
    renderCard('ja');
    fireEvent.click(screen.getByRole('radio', { name: /M PLUS Rounded 1c/ }));
    expect(checkedLabel()).toContain('M PLUS Rounded 1c');
    expect(document.documentElement.getAttribute('data-font-set-sans')).toBe('m-plus-rounded-1c');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(sent).toContainEqual(
      expect.objectContaining({ fontPicks: { ja: 'm-plus-rounded-1c' } }),
    );

    fireEvent.click(screen.getByRole('radio', { name: /Automatic/ }));
    expect(checkedLabel()).toContain('Automatic');
    expect(document.documentElement.hasAttribute('data-font-set-sans')).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const last = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body));
    expect(last.fontPicks).toEqual({ ja: null });
  });

  it('shows Automatic after a session clear even when a pick was stored', () => {
    renderCard('ja', { ja: 'm-plus-rounded-1c' });
    expect(checkedLabel()).toContain('M PLUS Rounded 1c');
    fireEvent.click(screen.getByRole('radio', { name: /Automatic/ }));
    expect(checkedLabel()).toContain('Automatic');
  });
});
