// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { Window } from 'happy-dom';
import { flattenCss, flattenMockCss } from './theme/flattenMockCss';
import { scanMockStateInk } from './theme/mockStateInkScan';
// Typed through the published package, RUN from its source:
// `vitest.design.config.ts` aliases both specifiers to `packages/design-system/src`,
// because the `design-guards` job restores `node_modules` from cache and skips
// `postinstall`, so the package's `dist` is not guaranteed to exist in this lane.
import { renderMock } from '@motir/design-system/mock';
import { Button, Card, Pill } from '@motir/design-system';

// MOTIR-7179 — the design lane's CSS READER, pinned.
//
// The two guards that ask happy-dom what a mock COMPUTED (`mockStateInkScan`,
// `design-dark-parity`) read every asset through `flattenMockCss`, because
// happy-dom 20.9 drops every rule inside an `@layer` block and every nested rule
// — which is all of what compiled Tailwind, and so `renderMock`, emits. This
// spec pins three things: the engine gap the reader exists for (so a happy-dom
// upgrade that closes it says so here), what the reader preserves, and that a
// `renderMock` document is actually READ by both guards rather than abstained on.

type Rule = { type: string; selector: string; cssText: string; parent: string };

/** Every rule the engine parsed, grouping rules walked, with its enclosing group. */
function parsedRules(css: string, html = ''): { rules: Rule[]; window: Window } {
  const window = new Window({ url: 'https://localhost/' });
  window.document.write(
    `<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`,
  );
  const rules: Rule[] = [];
  const walk = (list: unknown[], parent: string) => {
    for (const rule of list as {
      constructor: { name: string };
      selectorText?: string;
      conditionText?: string;
      style?: { cssText: string };
      cssRules?: unknown[];
    }[]) {
      rules.push({
        type: rule.constructor.name,
        selector: rule.selectorText ?? rule.conditionText ?? '',
        cssText: rule.style?.cssText ?? '',
        parent,
      });
      if (rule.cssRules) walk([...rule.cssRules], rule.conditionText ?? rule.constructor.name);
    }
  };
  for (const sheet of window.document.styleSheets) walk([...sheet.cssRules], '');
  return { rules, window };
}

const colourOf = (window: Window, selector: string) =>
  window.getComputedStyle(window.document.querySelector(selector)!).color;

const REPRO =
  '@layer base { .a { color: red } } .b { color: green } ' +
  '.c { color: red; @supports (color: oklch(0 0 0)) { color: blue } background: yellow }';

describe('the engine gap the reader exists for (happy-dom, unflattened)', () => {
  it('drops a layered rule and the declaration before a nested at-rule', () => {
    // The counterfactual for everything below. If this starts failing, happy-dom
    // has learned `@layer` / nesting and `flattenMockCss` may be retirable —
    // re-measure the 270 mocks with and without it before removing it.
    const { rules } = parsedRules(REPRO);
    expect(rules.some((r) => r.selector === '.a')).toBe(false);
    expect(rules.find((r) => r.selector === '.c')?.cssText).not.toContain('color: red');
  });
});

describe('flattenCss — what the reader preserves', () => {
  it('reads the card’s reproduction whole', () => {
    const { rules } = parsedRules(flattenCss(REPRO));
    expect(rules.find((r) => r.selector === '.a')?.cssText).toContain('color: red');
    const c = rules.filter((r) => r.selector === '.c' && r.type === 'CSSStyleRule');
    expect(c.map((r) => r.cssText).join(' ')).toContain('color: red');
    expect(c.map((r) => r.cssText).join(' ')).toContain('background: yellow');
    expect(c.some((r) => r.parent.includes('oklch') && r.cssText.includes('color: blue'))).toBe(
      true,
    );
  });

  it('keeps declarations in source order around a nested block', () => {
    // `color: blue` inside the group must not be overridden by the trailing run.
    const flat = flattenCss(
      '.c { color: red; @supports (display: grid) { color: blue } margin: 0 }',
    );
    expect(flat.indexOf('color: red')).toBeLessThan(flat.indexOf('color: blue'));
    expect(flat.indexOf('color: blue')).toBeLessThan(flat.indexOf('margin: 0'));
    // …and every one of the three reaches the engine, which the raw text does not.
    const parsed = parsedRules(flat)
      .rules.map((r) => r.cssText)
      .join(' ');
    for (const decl of ['color: red', 'color: blue', 'margin: 0']) expect(parsed).toContain(decl);
  });

  it('lowers a nested `&:hover` inside `@media` to a state rule inside that `@media`', () => {
    const { rules } = parsedRules(
      flattenCss('.hover\\:bg-x { &:hover { @media (hover: hover) { background-color: red } } }'),
    );
    const hover = rules.find((r) => r.selector.endsWith(':hover'));
    expect(hover?.selector).toBe('.hover\\:bg-x:hover');
    expect(hover?.parent).toBe('(hover: hover)');
    expect(hover?.cssText).toContain('background-color: red');
  });

  it('resolves a nested selector against EVERY parent, and a complex parent through :is()', () => {
    expect(flattenCss('.a, .b { & .c { color: red } }')).toContain('.a .c, .b .c');
    expect(flattenCss('.x .y { .z & { color: red } }')).toContain('.z :is(.x .y)');
    expect(flattenCss('.a { > .b { color: red } }')).toContain('.a > .b');
  });

  it('honours layer ORDER: a later-declared layer wins, whatever the source order', () => {
    const css = '@layer a, b; @layer b { .x { color: blue } } @layer a { .x { color: red } }';
    const { window } = parsedRules(flattenCss(css), '<p class="x">x</p>');
    expect(colourOf(window, '.x')).toBe('blue');
  });

  it('lets an unlayered rule beat a layered one written after it', () => {
    const css = '.y { color: green } @layer a { .y { color: red } }';
    const { rules, window } = parsedRules(flattenCss(css), '<p class="y">y</p>');
    // The layered rule is IN the cascade and still loses — not merely dropped.
    expect(rules.some((r) => r.selector === '.y' && r.cssText.includes('color: red'))).toBe(true);
    expect(colourOf(window, '.y')).toBe('green');
  });

  it('leaves escaped class names intact — `\\:`, `\\,` and `\\&` are part of the class', () => {
    const flat = flattenCss(
      '.transition-\\[a\\,b\\] { color: red } .\\[\\&\\>svg\\]\\:size-4 { &>svg { width: 1rem } }',
    );
    expect(flat).toContain('.transition-\\[a\\,b\\] {');
    expect(flat).toContain('.\\[\\&\\>svg\\]\\:size-4>svg {');
  });

  it('passes `@scope`, `@keyframes` and `@property` through as written', () => {
    const flat = flattenCss(
      "@scope ([data-style='g']) to ([data-style]) { .a { color: red } } " +
        '@keyframes spin { to { rotate: 1turn } } @property --x { syntax: "*"; inherits: false }',
    );
    expect(flat).toContain("@scope ([data-style='g']) to ([data-style])");
    expect(flat).toContain('@keyframes spin { to { rotate: 1turn } }');
    expect(flat).toContain('@property --x');
  });

  it('returns input it cannot parse UNCHANGED', () => {
    for (const broken of ['.a { color: red', '.a { content: "x }', '/* open .a { color: red }']) {
      expect(flattenCss(broken)).toBe(broken);
    }
  });
});

describe('flattenMockCss — the document around the stylesheet', () => {
  it('rewrites only <style> text and leaves an HTML comment that mentions <style> intact', () => {
    // `design/brand/brand-mark.mock.html`'s header comment says "The <style> below
    // is generated"; a match opened there swallowed the comment's `-->`.
    const html =
      '<!-- The <style> below is generated --><style>@layer a { .a { color: red } }</style><p class="a">x</p>';
    const out = flattenMockCss(html);
    expect(out).toContain('<!-- The <style> below is generated -->');
    expect(out).not.toContain('@layer');
    expect(out).toContain('<p class="a">x</p>');
  });
});

describe('a renderMock document, CSS as emitted, is READ by both guards', () => {
  async function rendered(theme: 'light' | 'dark') {
    return renderMock({
      title: 'Save bar',
      axes: { styleId: 'warm-editorial', paletteId: 'motir', typeId: 'motir' },
      theme,
      panels: [
        {
          label: 'Unsaved changes',
          element: createElement(
            Card,
            null,
            createElement(Pill, { status: 'in-progress' }, 'Unsaved'),
            createElement(Button, { variant: 'secondary' }, 'Discard'),
          ),
        },
      ],
    });
  }

  it.each([['light'], ['dark']] as const)(
    'the state-ink arm parses its rules (%s)',
    async (theme) => {
      const html = await rendered(theme);
      expect(html).toContain('@layer');
      const scan = scanMockStateInk('design/x/rendered.mock.html', html);
      expect(scan.stateBackgroundRules).toBeGreaterThan(0);
      expect(scan.abstentions.filter((a) => a.stateSelector === '(whole asset)')).toEqual([]);
    },
  );

  it.each([
    ['light', '#ffffff'],
    ['dark', '#0c0d0f'],
  ] as const)('the dark-parity reading resolves the page background (%s)', async (theme, bg) => {
    // The reading `design-dark-parity` takes, on the same flattened document.
    // Unflattened, `--el-page-bg` never reaches the cascade and this is ''.
    const window = new Window({
      url: 'https://localhost/',
      settings: { disableJavaScriptEvaluation: true },
    });
    try {
      window.document.write(flattenMockCss(await rendered(theme)));
      const body = window.getComputedStyle(window.document.body).backgroundColor;
      expect(body).toBe(bg);
    } finally {
      void window.happyDOM.close();
    }
  });
});
