// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { FontSetsSection } from '@/app/tokens/FontSetsSection';

// MOTIR-7850 — the /tokens Font sets section's face states (design-notes § 9.4
// and § 9.5): a sample is labelled `loading <face>` until the browser's Font
// Loading API settles it, then either drops the badge or says `not loaded` with
// the reason. A fallback face is never shown unlabelled. Also the Latin member's
// label, which follows the active pairing when `data-type` flips on <html>.
//
// happy-dom has no `document.fonts`, so each test installs one whose `load`
// answer it controls.

type Load = (font: string, text?: string) => Promise<Array<{ status: string }>>;

function installFonts(load: Load) {
  Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
}

let style: HTMLStyleElement;

beforeEach(() => {
  // Mount at once: no IntersectionObserver means the section renders its samples.
  vi.stubGlobal('IntersectionObserver', undefined);
  style = document.createElement('style');
  style.textContent = `.font-sans { font-family: "Inter", sans-serif; }`;
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  style.remove();
  delete (document as { fonts?: unknown }).fonts;
  document.documentElement.removeAttribute('data-type');
});

const row = (c: HTMLElement, key: string) =>
  c.querySelector(`[data-font-set-member="${key}"]`) as HTMLElement;

async function mount() {
  const view = render(<FontSetsSection />);
  await act(async () => {});
  return view.container;
}

describe('FontSetsSection face states (MOTIR-7850)', () => {
  it('labels a face loading until the browser settles it, then drops the badge', async () => {
    const pending: Array<(faces: Array<{ status: string }>) => void> = [];
    const load = vi.fn<Load>(() => new Promise((r) => pending.push(r)));
    installFonts(load);
    const c = await mount();
    expect(row(c, 'ja/sans/noto-sans-jp').textContent).toContain('loading Noto Sans JP');
    expect(load).toHaveBeenCalledWith('20px "Noto Sans JP"', expect.stringContaining('いろは'));
    await act(async () => pending.forEach((r) => r([{ status: 'loaded' }])));
    expect(row(c, 'ja/sans/noto-sans-jp').textContent).not.toContain('loading');
    expect(row(c, 'ja/sans/noto-sans-jp').textContent).not.toContain('not loaded');
  });

  it('says not loaded, and why, when no face is declared for the text', async () => {
    installFonts(async () => []);
    const c = await mount();
    const text = row(c, 'ko/sans/nanum-gothic').textContent;
    expect(text).toContain('not loaded');
    expect(text).toContain('No Nanum Gothic face is declared for this text.');
    expect(text).toContain('Shown in the fallback face.');
  });

  it('says not loaded when a face file errors', async () => {
    installFonts(async () => [{ status: 'error' }]);
    const c = await mount();
    expect(row(c, 'zh-Hans/serif/lxgw-wenkai-tc').textContent).toContain(
      'The face file failed to load.',
    );
  });

  it('says not loaded when the load itself rejects', async () => {
    installFonts(() => Promise.reject(new Error('network')));
    const c = await mount();
    expect(row(c, 'ja/serif/noto-serif-jp').textContent).toContain('not loaded');
  });

  it('labels the Latin member with the active pairing’s face, and follows a pairing change', async () => {
    installFonts(async () => [{ status: 'loaded' }]);
    const c = await mount();
    expect(row(c, 'latin/sans/type-pairing').textContent).toContain('type-pairing · Inter');
    expect(row(c, 'latin/sans/type-pairing').textContent).toContain(
      "The active pairing's own face. The set loads nothing.",
    );
    style.textContent = `.font-sans { font-family: 'Space Grotesk', sans-serif; }`;
    await act(async () => {
      document.documentElement.setAttribute('data-type', 'grotesk');
    });
    expect(row(c, 'latin/sans/type-pairing').textContent).toContain('type-pairing · Space Grotesk');
  });

  it('marks the mono role of a CJK set as a composition with the set’s sans face', async () => {
    installFonts(async () => [{ status: 'loaded' }]);
    const c = await mount();
    expect(row(c, 'ko/mono/noto-sans-kr').textContent).toContain(
      "Composition: the pairing's mono face for Latin, the set's sans face for Hangul.",
    );
  });
});
