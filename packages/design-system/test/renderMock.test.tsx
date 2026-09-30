import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderMock, extractClassCandidates } from '../src/mock';
import { Button, Card, Pill } from '../src/index';
import { DEFAULT_PALETTE_ID } from '../src/theme/palettes';

// renderMock (MOTIR-6961): the package's own parts rendered into ONE
// self-contained `.mock.html`, with Tailwind COMPILED over the markup using the
// package's `theme.css` as input.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

const axes = (paletteId: string) => ({ styleId: 'warm-editorial', paletteId, typeId: 'motir' });

function styleText(html: string): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(match, 'the document carries a <style> element').not.toBeNull();
  return match![1]!;
}

/** The selector Tailwind writes for a class: every non-identifier character escaped. */
function selectorFor(className: string): string {
  return `.${className.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
}

describe('the @motir/design-system/mock subpath', () => {
  beforeAll(() => {
    if (!existsSync(path.join(PKG_ROOT, 'dist/mock/index.js'))) {
      execSync('pnpm run build', { cwd: PKG_ROOT, stdio: 'inherit' });
    }
  }, 120_000);

  it('resolves renderMock from the BUILT package through the ./mock export', async () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    const target = pkg.exports['./mock'].import as string;
    expect(target).toBe('./dist/mock/index.js');
    expect(existsSync(path.join(PKG_ROOT, pkg.exports['./mock'].types))).toBe(true);
    const mod = await import(pathToFileURL(path.join(PKG_ROOT, target)).href);
    expect(typeof mod.renderMock).toBe('function');
  });

  it('the main entry does not export it', async () => {
    const main = await import(pathToFileURL(path.join(PKG_ROOT, 'dist/index.js')).href);
    expect('renderMock' in main).toBe(false);
    expect(readFileSync(path.join(PKG_ROOT, 'src/index.ts'), 'utf8')).not.toMatch(/mock/);
  });
});

describe('renderMock', () => {
  it('stamps the palette on <html> and compiles that palette’s block', async () => {
    const panels = [{ label: 'Primary button', element: <Button>Save</Button> }];
    const cobalt = await renderMock({ title: 'Buttons', panels, axes: axes('cobalt') });
    const candy = await renderMock({ title: 'Buttons', panels, axes: axes('candy') });

    expect(cobalt).toMatch(/<html[^>]*data-palette="cobalt"/);
    expect(candy).toMatch(/<html[^>]*data-palette="candy"/);
    expect(styleText(cobalt)).toContain("[data-palette='cobalt']");
    expect(styleText(candy)).toContain("[data-palette='candy']");
    for (const attr of ['data-style="warm-editorial"', 'data-type="motir"', 'data-theme="light"']) {
      expect(cobalt).toContain(attr);
    }
  });

  it('is self-contained: one <style>, no stylesheet link, script src or remote import', async () => {
    const html = await renderMock({
      title: 'Card',
      panels: [
        {
          label: 'A card',
          element: (
            <Card>
              <Button>Go</Button>
              <Pill status="in-progress">Doing</Pill>
            </Card>
          ),
        },
      ],
      axes: axes('amethyst'),
      theme: 'dark',
    });
    expect(html.match(/<style[\s>]/g)).toHaveLength(1);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet/i);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toContain('@import url(');
    expect(html).not.toMatch(/@import\s/);
    expect(html).toContain('data-theme="dark"');
  });

  it('compiles a rule for every utility class the rendered parts use', async () => {
    const html = await renderMock({
      title: 'Buttons',
      panels: [{ label: 'Primary', element: <Button variant="primary">Save</Button> }],
      axes: axes('motir'),
    });
    const css = styleText(html);
    expect(css).toContain(`${selectorFor('bg-(--el-accent)')} {`);
    expect(css).toContain(`${selectorFor('rounded-(--radius-btn)')} {`);

    // Every class on the button itself must have compiled into at least one rule
    // — a part rendered with no rules is a failure, not a warning.
    const button = html.match(/<button[^>]*class="([^"]*)"/);
    expect(button).not.toBeNull();
    const missing = button![1]!
      .split(/\s+/)
      .filter(Boolean)
      .filter((cls) => !css.includes(selectorFor(cls)));
    expect(missing).toEqual([]);
  });

  it('falls back to the registry default on an unknown paletteId and says so', async () => {
    const html = await renderMock({
      title: 'Fallback',
      panels: [{ label: 'x', element: <Button>Go</Button> }],
      axes: axes('no-such-palette'),
    });
    expect(html).toMatch(new RegExp(`<html[^>]*data-palette="${DEFAULT_PALETTE_ID}"`));
    expect(html).toMatch(
      /<!-- renderMock: paletteId unknown "no-such-palette" — fell back to "motir" -->/,
    );
  });

  it('falls back on missing ids without throwing', async () => {
    const html = await renderMock({
      title: 'Missing',
      panels: [{ label: 'x', element: <Button>Go</Button> }],
      axes: { styleId: '', paletteId: 'motir', typeId: '' },
    });
    expect(html).toContain('<!-- renderMock: styleId missing');
    expect(html).toContain('<!-- renderMock: typeId missing');
    expect(html).toContain('data-style="warm-editorial"');
  });

  it('inlines fontCss verbatim, and emits no @font-face without it', async () => {
    const fontCss =
      "@font-face { font-family: 'Mock Sans'; src: url(data:font/woff2;base64,AAAA) format('woff2'); }";
    const withFont = await renderMock({
      title: 'Fonts',
      panels: [{ label: 'x', element: <Button>Go</Button> }],
      axes: axes('motir'),
      fontCss,
    });
    expect(styleText(withFont)).toContain(fontCss);

    const without = await renderMock({
      title: 'Fonts',
      panels: [{ label: 'x', element: <Button>Go</Button> }],
      axes: axes('motir'),
    });
    expect(without).not.toContain('@font-face');
  });

  it('escapes the title and panel labels', async () => {
    const html = await renderMock({
      title: 'A <b> & "c"',
      panels: [{ label: '<script>x</script>', element: <Button>Go</Button> }],
      axes: axes('motir'),
    });
    expect(html).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>');
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('extractClassCandidates', () => {
  it('un-escapes attribute entities so arbitrary variants reach the compiler', () => {
    expect(extractClassCandidates('<div class="p-2 [&amp;&gt;svg]:size-4 p-2"></div>')).toEqual([
      'p-2',
      '[&>svg]:size-4',
    ]);
  });
});
