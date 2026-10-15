import { describe, expect, it } from 'vitest';
import { renderMock } from '../src/mock';
import {
  pruneUnmatchedRules,
  requiredClasses,
  unescapeCssIdent,
} from '../src/mock/pruneUnmatchedRules';
import { Button, Card, StyleVignette } from '../src/index';

// MOTIR-8565 — Tailwind copies every plain rule of `theme.css` into a compiled
// mock, so a component's own rule (the StyleVignette canvas) landed in mocks
// that render no vignette, and motir-core's design guard failed every fresh
// renderMock mock on two rules nothing carries. The prune drops a rule only
// when no selector in it can match the markup.

const axes = { styleId: 'warm-editorial', paletteId: 'motir', typeId: 'motir' };

function styleText(html: string): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(match, 'the document carries a <style> element').not.toBeNull();
  return match![1]!;
}

describe('renderMock drops the rules its markup cannot match', () => {
  it('a mock with no StyleVignette carries none of the vignette canvas rules', async () => {
    const css = styleText(
      await renderMock({
        title: 'No vignette',
        panels: [
          {
            label: 'Card',
            element: (
              <Card>
                <Button>Go</Button>
              </Card>
            ),
          },
        ],
        axes,
      }),
    );
    expect(css).not.toContain('.style-vignette');
    expect(css).not.toContain('.sv-canvas');
  });

  it('a mock that renders a StyleVignette keeps them', async () => {
    const html = await renderMock({
      title: 'Vignette',
      panels: [{ label: 'Aurora', element: <StyleVignette styleId="aurora" /> }],
      axes,
    });
    expect(html).toContain('class="style-vignette');
    const css = styleText(html);
    expect(css).toContain(".style-vignette[data-style='aurora'] > .sv-canvas");
  });
});

describe('requiredClasses', () => {
  it('reads every class of a compound and its combinators', () => {
    expect(requiredClasses(".style-vignette[data-style='aurora'] > .sv-canvas")).toEqual([
      'style-vignette',
      'sv-canvas',
    ]);
  });

  it('does not need a class inside a functional pseudo-class', () => {
    expect(requiredClasses('.border:not(.fixed):not(.absolute)')).toEqual(['border']);
    expect(requiredClasses('[data-surface] :is(.border-b, .border-t):not(.border)')).toEqual([]);
    expect(requiredClasses('.group-hover\\:flex:is(:where(.group):hover *)')).toEqual([
      'group-hover:flex',
    ]);
  });

  it('does not read an attribute value as a class', () => {
    expect(requiredClasses("[data-x='a.b'] .c")).toEqual(['c']);
  });

  it('un-escapes the class the way the browser does', () => {
    expect(requiredClasses('.rounded-\\(--radius-btn\\).bg-\\(--el-accent\\)')).toEqual([
      'rounded-(--radius-btn)',
      'bg-(--el-accent)',
    ]);
    expect(requiredClasses('.\\[\\&\\>svg\\]\\:size-4 > svg')).toEqual(['[&>svg]:size-4']);
    expect(unescapeCssIdent('\\32 xl\\:p-2')).toBe('2xl:p-2');
  });
});

describe('pruneUnmatchedRules', () => {
  it('drops a rule every selector of which needs an absent class', () => {
    const css = '.a { color: red; }\n.b > .c, .d { color: blue; }\n';
    expect(pruneUnmatchedRules(css, ['a'])).toBe('.a { color: red; }\n');
  });

  it('keeps a rule one of whose selectors can match', () => {
    const css = '.b > .c, .d { color: blue; }';
    expect(pruneUnmatchedRules(css, ['d'])).toBe(css);
  });

  it('keeps a rule that needs no class, and a :not() rule whose class is absent', () => {
    const css = '[data-surface] { x: 1; }\n.border:not(.fixed) { x: 2; }\nbody { x: 3; }';
    expect(pruneUnmatchedRules(css, ['border'])).toBe(css);
  });

  it('walks grouping at-rules, and drops one it empties', () => {
    const css =
      '@media (min-width: 1px) {\n  .a { x: 1; }\n  .gone { x: 2; }\n}\n' +
      "@scope ([data-style='x']) to ([data-style]) {\n  .gone { x: 3; }\n}\n";
    expect(pruneUnmatchedRules(css, ['a'])).toBe('@media (min-width: 1px) {\n  .a { x: 1; }\n}\n');
  });

  it('leaves @layer utilities, keyframes and font-face untouched', () => {
    const css =
      '@layer utilities {\n  .gone { x: 1; }\n}\n' +
      '@keyframes spin {\n  to { transform: rotate(1turn); }\n}\n' +
      "@font-face { font-family: 'X'; }\n";
    expect(pruneUnmatchedRules(css, [])).toBe(css);
  });

  it('keeps a rule nested in a kept rule, and drops it with a dropped one', () => {
    const css = '.a {\n  &:hover { x: 1; }\n}\n.gone {\n  .a & { x: 2; }\n}\n';
    expect(pruneUnmatchedRules(css, ['a'])).toBe('.a {\n  &:hover { x: 1; }\n}\n');
  });

  it('is not misled by braces and commas inside strings and comments', () => {
    const css = ".a::before { content: '}'; }\n/* .gone { } */\n.gone, .b[title='x,y'] { x: 1; }";
    // The comment rides in the dropped rule's prelude, so it goes with the rule.
    expect(pruneUnmatchedRules(css, ['a'])).toBe(".a::before { content: '}'; }");
  });

  it('returns a stylesheet with nothing to drop byte-identical', () => {
    const css = '@layer base {\n  * { margin: 0; }\n}\n.a{x:1}\n';
    expect(pruneUnmatchedRules(css, ['a'])).toBe(css);
  });
});
