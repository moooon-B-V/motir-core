// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  FONT_SET_IDS,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  resolveFontSetMember,
  type FontSetMember,
} from '@motir/design-system';
import { APPLY_BY_NAME, FontSetsSection, sampleLang } from '@/app/tokens/FontSetsSection';

// MOTIR-7848 — the /tokens Font sets section. Its one load-bearing rule is the
// arrival: no Han, kana or Hangul glyph may reach the DOM before the section is
// on screen, because the browser fetches a CJK face as soon as rendered text
// uses it. After a (mocked) intersection, every set, role and member renders,
// each sample in its set's `lang` and each non-default member named by
// `data-font-set-<role>`, which is what makes theme.css draw it in that face.

const CJK = /[぀-鿿가-힯]/;

let fire: (() => void) | null = null;

class FakeIntersectionObserver {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe() {
    fire = () =>
      this.cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  fire = null;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FontSetsSection (MOTIR-7848)', () => {
  it('holds no CJK or Hangul character before the section is on screen', () => {
    const { container } = render(<FontSetsSection />);
    expect(container.textContent).not.toMatch(CJK);
    expect(container.querySelector('[lang]')).toBeNull();
    for (const id of FONT_SET_IDS) {
      expect(container.querySelector(`[data-font-set-placeholder="${id}"]`)).not.toBeNull();
    }
  });

  it('mounts every set, role and member once the section intersects', async () => {
    const { container } = render(<FontSetsSection />);
    expect(fire).not.toBeNull();
    await act(async () => fire?.());

    expect(container.textContent).toMatch(CJK);
    for (const id of FONT_SET_IDS) {
      const set = FONT_SET_REGISTRY[id];
      expect(container.querySelector(`[data-font-set="${id}"]`), id).not.toBeNull();
      for (const role of FONT_SET_ROLES) {
        const r = set.roles[role];
        for (const m of r.members as readonly FontSetMember[]) {
          const row = container.querySelector(`[data-font-set-member="${id}/${role}/${m.id}"]`);
          expect(row, `${id}/${role}/${m.id}`).not.toBeNull();
          const sample = row?.querySelector('[data-font-set-sample]');
          expect(sample?.getAttribute('lang')).toBe(sampleLang(set));
          const attr = sample?.getAttribute(`data-font-set-${role}`) ?? null;
          expect(attr).toBe(m.id === r.default ? null : m.id);
        }
      }
    }
  });

  it('applies a non-default member by name in the apply-by-name panel', async () => {
    const { container } = render(<FontSetsSection />);
    await act(async () => fire?.());
    const { setId, role, memberId } = APPLY_BY_NAME;
    const el = container.querySelector('[data-font-set-apply-by-name]');
    expect(el?.getAttribute(`data-font-set-${role}`)).toBe(memberId);
    expect(el?.getAttribute('lang')).toBe(FONT_SET_REGISTRY[setId].lang);
    expect(resolveFontSetMember(setId, role, memberId).id).toBe(memberId);
    expect(FONT_SET_REGISTRY[setId].roles[role].default).not.toBe(memberId);
  });

  it('mounts at once when IntersectionObserver is missing', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(<FontSetsSection />);
    await act(async () => {});
    expect(container.querySelector('[data-font-sets-mounted="true"]')).not.toBeNull();
  });
});
