// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/messages/en.json';
import jaMessages from '@/messages/ja.json';
import { locales, localeLabel, type Locale } from '@/lib/i18n/locales';

// The language control on the signed-out frame (Story MOTIR-7730 · MOTIR-7758),
// built to `design/auth/auth-frame--language-control.mock.html` and
// `design/auth/design-notes.md` § _The language control on the signed-out frame_.
//
// `setLocale` is a server action and `next/navigation` has no router here, so
// both are mocked — the one thing this file proves is what the CONTROL does with
// them: which calls it makes, in which order, and what it leaves alone. The
// harness below re-renders the provider in the new locale when `refresh()` is
// called, the way the real refresh re-renders the root layout's provider, so a
// test can watch the trigger change language around a field that keeps its value.

const setLocale = vi.fn<(locale: Locale) => Promise<void>>();
vi.mock('@/lib/i18n/actions', () => ({ setLocale: (l: Locale) => setLocale(l) }));

const refresh = vi.fn();
const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace, prefetch: vi.fn() }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import { AuthLanguageControl } from '@/app/(auth)/_components/AuthLanguageControl';
import AuthLayout from '@/app/(auth)/layout';

const MESSAGES: Partial<Record<Locale, Record<string, unknown>>> = {
  en: enMessages,
  ja: jaMessages,
};

/** The frame in miniature: the control beside a client field, under a provider
 *  that `refresh()` re-renders in whatever locale was last set. */
function Harness({ initial = 'en' as Locale }: { initial?: Locale }) {
  const [locale, setLoc] = useState<Locale>(initial);
  refresh.mockImplementation(() => setLoc(lastSet ?? locale));
  return (
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale] ?? enMessages}>
      <AuthLanguageControl />
      <input aria-label="Email address" defaultValue="" />
    </NextIntlClientProvider>
  );
}

let lastSet: Locale | null = null;

beforeEach(() => {
  lastSet = null;
  setLocale.mockImplementation(async (l) => {
    lastSet = l;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function trigger() {
  return screen.getByRole('combobox', { name: /^Language: |^言語：/ });
}

async function choose(label: string) {
  fireEvent.click(trigger());
  const option = await screen.findByRole('option', { name: label });
  await act(async () => {
    fireEvent.click(option);
  });
}

describe('AuthLanguageControl — the list', () => {
  it('offers the eleven languages in locales order, each in its own script and lang', async () => {
    render(<Harness />);
    expect(trigger().getAttribute('aria-label')).toBe('Language: English');
    fireEvent.click(trigger());
    const listbox = await screen.findByRole('listbox');
    expect(listbox.getAttribute('aria-label')).toBe('Language: English');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'English',
      '中文',
      '日本語',
      '한국어',
      'Deutsch',
      'Français',
      'Español',
      'Italiano',
      'Nederlands',
      'Polski',
      'Português',
    ]);
    expect(options.map((o) => o.getAttribute('lang'))).toEqual([...locales]);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual([
      'true',
      ...Array(10).fill('false'),
    ]);
  });

  it('shows the current endonym on the trigger, in its lang, beside an aria-hidden glyph', () => {
    render(<Harness initial="ja" />);
    const t = trigger();
    expect(t.getAttribute('aria-label')).toBe('言語：日本語');
    const label = [...t.querySelectorAll('span')].find((s) => s.textContent === '日本語')!;
    expect(label.getAttribute('lang')).toBe('ja');
    // The glyph is the first slot, decorative.
    const glyph = t.firstElementChild!;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.querySelector('svg')).not.toBeNull();
  });
});

describe('AuthLanguageControl — a choice', () => {
  it('calls setLocale once, then router.refresh() once, and never navigates', async () => {
    render(<Harness />);
    await choose('日本語');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(setLocale).toHaveBeenCalledTimes(1);
    expect(setLocale).toHaveBeenCalledWith('ja');
    expect(setLocale.mock.invocationCallOrder[0]!).toBeLessThan(
      refresh.mock.invocationCallOrder[0]!,
    );
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    // The refresh re-rendered the frame in Japanese; focus went back to the trigger.
    expect(trigger().getAttribute('aria-label')).toBe('言語：日本語');
    expect(document.activeElement).toBe(trigger());
  });

  it('choosing the current language calls neither', async () => {
    render(<Harness />);
    await choose('English');
    expect(setLocale).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps what was typed beside it through the switch', async () => {
    render(<Harness />);
    const email = screen.getByRole('textbox', { name: 'Email address' }) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'ana@example.com' } });
    await choose('日本語');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(trigger().getAttribute('aria-label')).toBe('言語：日本語');
    expect(screen.getByRole('textbox', { name: 'Email address' })).toBe(email);
    expect(email.value).toBe('ana@example.com');
  });

  it('is busy while the switch is in flight, says so politely, and disables nothing', async () => {
    let resolve!: () => void;
    setLocale.mockImplementation(
      (l) =>
        new Promise<void>((r) => {
          lastSet = l;
          resolve = r;
        }),
    );
    render(<Harness />);
    await choose('日本語');
    const t = trigger();
    expect(t.getAttribute('aria-busy')).toBe('true');
    expect(t.hasAttribute('disabled')).toBe(false);
    expect(t.querySelector('[data-combobox-busy]')).not.toBeNull();
    const status = screen.getAllByRole('status').find((s) => s.textContent?.includes('Switching'))!;
    expect(status.textContent).toBe('Switching to 日本語…');
    expect(status.querySelector('span[lang="ja"]')?.textContent).toBe('日本語');
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(false);
    await act(async () => resolve());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(trigger().getAttribute('aria-busy')).toBeNull();
  });

  it('lets a newer choice supersede one still in flight', async () => {
    const pending: Array<() => void> = [];
    setLocale.mockImplementation(
      (l) =>
        new Promise<void>((r) => {
          lastSet = l;
          pending.push(r);
        }),
    );
    render(<Harness />);
    await choose('日本語');
    await choose('Deutsch');
    expect(setLocale.mock.calls.map((c) => c[0])).toEqual(['ja', 'de']);
    await act(async () => pending[0]!());
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => pending[1]!());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});

describe('AuthLanguageControl — failure', () => {
  it('does not refresh, shows the failed line, and Try again repeats the same choice', async () => {
    setLocale.mockRejectedValueOnce(new Error('offline'));
    render(<Harness />);
    await choose('日本語');
    const line = await screen.findByText('Couldn’t change the language.');
    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    // The page stays in its current language.
    expect(trigger().getAttribute('aria-label')).toBe('Language: English');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(setLocale).toHaveBeenCalledTimes(2);
    expect(setLocale.mock.calls.map((c) => c[0])).toEqual(['ja', 'ja']);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Couldn’t change the language.')).toBeNull();
  });
});

describe('AuthLanguageControl — both session states, one behaviour', () => {
  // `setLocale` decides what a choice writes; the control does not ask. Signed
  // out it writes the cookie only, signed in the account and then the cookie —
  // and the control refreshes the same way after either.
  for (const [state, writes] of [
    ['signed out', ['cookie']],
    ['signed in', ['account', 'cookie']],
  ] as const) {
    it(`refreshes after setLocale resolves ${state}`, async () => {
      const written: string[] = [];
      setLocale.mockImplementation(async (l) => {
        for (const w of writes) written.push(w);
        lastSet = l;
      });
      render(<Harness />);
      await choose('Deutsch');
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(written).toEqual(writes);
      expect(setLocale).toHaveBeenCalledWith('de');
      expect(push).not.toHaveBeenCalled();
    });
  }

  it('reads no session: the component imports nothing from @/lib/auth', () => {
    const src = readFileSync('app/(auth)/_components/AuthLanguageControl.tsx', 'utf8');
    expect(src).not.toMatch(/from ['"]@\/lib\/auth/);
    expect(src).not.toMatch(/useSession|getSession/);
    expect(src).not.toMatch(/\.(push|replace)\(/);
  });
});

describe('the (auth) frame mounts it once, outside the card', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
    });
  }

  it('is imported by app/(auth)/layout.tsx and by nothing else under app/', () => {
    const importers = walk('app').filter(
      (f) =>
        !f.endsWith('AuthLanguageControl.tsx') &&
        readFileSync(f, 'utf8').includes('AuthLanguageControl'),
    );
    expect(importers).toEqual([join('app', '(auth)', 'layout.tsx')]);
  });

  it('renders one control, in the corner, before and outside <main>', async () => {
    const ui = await AuthLayout({ children: <div data-auth-wide>confirm</div> });
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {ui}
      </NextIntlClientProvider>,
    );
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(1);
    const main = container.querySelector('main')!;
    expect(main.contains(combos[0]!)).toBe(false);

    const frame = container.firstElementChild as HTMLElement;
    const corner = frame.firstElementChild as HTMLElement;
    expect(corner.tagName).toBe('HEADER');
    expect(corner.contains(combos[0]!)).toBe(true);
    expect(corner.className.split(' ')).toEqual(
      expect.arrayContaining(['absolute', 'top-2', 'right-6', 'z-10']),
    );
    const frameClasses = frame.className.split(' ');
    expect(frameClasses).toContain('relative');
    // The wide tightening is scoped to lg, so the corner clears the 40rem card below it.
    expect(frameClasses).toContain('lg:has-[[data-auth-wide]]:py-8');
    expect(frameClasses).not.toContain('has-[[data-auth-wide]]:py-8');
  });

  it('uses no ink on the control that fails AA on the wash', () => {
    const src = readFileSync('app/(auth)/_components/AuthLanguageControl.tsx', 'utf8');
    expect(src).not.toMatch(/--el-text-(muted|faint)/);
    expect(localeLabel.en).toBe('English');
  });
});
