// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PageSkeleton } from '@/components/ui/PageSkeleton';

// MOTIR-3531 — the ONE primitive every in-page arrival frame composes.
//
// What is worth asserting here is narrow and deliberate: this component has no
// behaviour, so a test that walked its markup would only restate it. What CAN
// break silently is checked instead, and half of it is not about the component
// at all — the reveal is a stylesheet rule, and a `.tsx` test that only rendered
// JSX would be blind to the file that actually carries the 120ms.
//
//   1. The REVEAL classes. They are the single carrier of the delay. Drop one
//      and the frame paints on the click — the flicker the delay exists to
//      remove — with no type error and no visual difference in any test that
//      does not run a browser.
//   2. The HEADER's three modes, and especially the OMITTED one: 31 settings
//      routes paint a real header above the boundary and depend on this
//      primitive drawing no bar over it.
//   3. The ONE declaration. A component that re-declared `nav-pending-reveal`
//      would give its surface a second reveal at a second time, which is the
//      same flicker wearing a second costume.
//   4. The REDUCED-MOTION arm, asserted over `app/globals.css` itself. The
//      delay STAYS and the motion goes; a rule that dropped the delay with the
//      fade would make a fast route flash for a reader who asked for fewer
//      flashes, not more.
//   5. The ORDERING claim — that this card ships the primitive and nothing that
//      consumes it.

const ROOT = resolve(__dirname, '..', '..');
const GLOBALS = join(ROOT, 'app', 'globals.css');

/** Every source file under `dir` whose extension is in `exts`. */
function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

afterEach(cleanup);

describe('PageSkeleton — the frame (MOTIR-3531)', () => {
  it('carries the shared reveal classes, so the 120ms delay is never re-declared per frame', () => {
    const { container } = renderWithIntl(
      <PageSkeleton>
        <div />
      </PageSkeleton>,
    );
    const frame = container.querySelector('[data-testid="page-skeleton"]');
    expect(frame).not.toBeNull();
    // Both matter: `nav-pending-reveal` is the delay, `nav-pending-frame` is
    // what the reduced-motion rule keys off to stop the pulse.
    expect(frame!.className).toContain('nav-pending-reveal');
    expect(frame!.className).toContain('nav-pending-frame');
  });

  it('announces the region ONCE and hides the decorative blocks', () => {
    const { container } = renderWithIntl(
      <PageSkeleton>
        <div />
      </PageSkeleton>,
    );
    const frame = container.querySelector('[data-testid="page-skeleton"]')!;
    expect(frame.getAttribute('aria-busy')).toBe('true');
    // Exactly one label, from the real catalog — not one per block.
    expect(screen.getByText('Loading page')).toBeTruthy();
    const pulse = container.querySelector('.animate-pulse')!;
    expect(pulse.getAttribute('aria-hidden')).toBe('true');
  });

  it('adds NO horizontal gutter — the authed layout wrapper already pays it', () => {
    // A frame that re-applied `px-*` would double the gutter at every
    // breakpoint, because it renders inside the layout's own padded wrapper.
    const { container } = renderWithIntl(
      <PageSkeleton>
        <div />
      </PageSkeleton>,
    );
    const frame = container.querySelector('[data-testid="page-skeleton"]')!;
    expect(frame.className).not.toMatch(/(^|\s)p[xlr]?-/);
    expect(frame.className).toContain('gap-6');
  });

  it('draws no content region of its own — the body it renders is the one it was given', () => {
    const { container } = renderWithIntl(
      <PageSkeleton>
        <div data-testid="route-shaped-body" />
      </PageSkeleton>,
    );
    expect(container.querySelector('[data-testid="route-shaped-body"]')).not.toBeNull();
    // Nothing bordered, carded or tabular arrives uninvited: a frame that
    // guessed at a body would be a shape the page then replaces.
    expect(container.querySelectorAll('.rounded-\\(--radius-card\\)').length).toBe(0);
    expect(container.querySelectorAll('.border-\\(--el-border\\)').length).toBe(0);
  });
});

describe('PageSkeleton — the header block, in all three modes (MOTIR-3531)', () => {
  it('OMITTED prop → the generic placeholder pair: an h-8 title bar over an h-4 subtitle bar', () => {
    const { container } = renderWithIntl(
      <PageSkeleton>
        <div />
      </PageSkeleton>,
    );
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.children.length).toBe(2);
    // The no-shift boxes, which are the whole reason the bars have these
    // heights: `text-2xl` on a 2rem line box is exactly 32px.
    const [titleBar, subtitleBar] = [header!.children[0]!, header!.children[1]!];
    expect(titleBar.className).toContain('h-8');
    expect(titleBar.className).toContain('w-56');
    expect(subtitleBar.className).toContain('h-4');
    expect(subtitleBar.className).toContain('w-80');
  });

  it('a REAL header → rendered as content: outside the pulse and NOT aria-hidden', () => {
    const { container } = renderWithIntl(
      <PageSkeleton header={<h1 data-testid="real-header">Members</h1>}>
        <div />
      </PageSkeleton>,
    );
    const real = container.querySelector('[data-testid="real-header"]')!;
    expect(real).not.toBeNull();
    // It is the one part of the frame that is not a stand-in for something, so
    // it must not sit inside the pulse's `aria-hidden` subtree.
    expect(real.closest('[aria-hidden="true"]')).toBeNull();
    expect(real.closest('.animate-pulse')).toBeNull();
    // …and no generic bar is drawn alongside it.
    expect(container.querySelector('header')).toBeNull();
  });

  it('header={false} → NO title bar and NO subtitle bar, which is what the 31 settings routes take', () => {
    const { container } = renderWithIntl(
      <PageSkeleton header={false}>
        <div data-testid="pane-body" />
      </PageSkeleton>,
    );
    // The assertion the settings family depends on: a settings pane's title is
    // already painted from the gate, so a grey bar over it would be a frame
    // covering a region that has something to show.
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelectorAll('.h-8').length).toBe(0);
    expect(container.querySelectorAll('.h-4').length).toBe(0);
    // The wrapper, the reveal and the body all still arrive.
    const frame = container.querySelector('[data-testid="page-skeleton"]')!;
    expect(frame.className).toContain('nav-pending-reveal');
    expect(container.querySelector('[data-testid="pane-body"]')).not.toBeNull();
  });
});

describe('the reveal is declared ONCE, in the stylesheet that owns it (MOTIR-3531)', () => {
  // No `g` flag: a global regex carries `lastIndex` between `.test()` calls and
  // would skip every other file in the filter below.
  const KEYFRAME = /@keyframes\s+nav-pending-reveal\b/;

  it('exactly one @keyframes nav-pending-reveal across app/, packages/ and components/', () => {
    // ⚠️ Scoped to the app trees DELIBERATELY, and the scoping is the whole
    // assertion. A mock must declare the keyframe in its own `<style>` block to
    // render it at all, and `design-notes.md` quotes it as the specification —
    // so every asset drawing an arrival frame adds one, and `design/**` grows
    // more of them with each one drawn. A repo-wide grep would therefore fail
    // against the very assets that specify this card, and would fail HARDER the
    // better the design tree is maintained. The rule this pins is *the running
    // app declares it once*, which is a property of `app/` and `packages/`; the
    // count under `design/` is not a number worth writing down here, because it
    // is supposed to move.
    const files = [
      ...walk(join(ROOT, 'app'), ['.css', '.tsx', '.ts']),
      ...walk(join(ROOT, 'packages'), ['.css', '.tsx', '.ts']),
      ...walk(join(ROOT, 'components'), ['.css', '.tsx', '.ts']),
    ];
    const declaring = files.filter((f) => KEYFRAME.test(readFileSync(f, 'utf8')));
    expect(declaring.map((f) => relative(ROOT, f).split(sep).join('/'))).toEqual([
      'app/globals.css',
    ]);
  });

  it('no component re-declares it — a second declaration is a second reveal at a second time', () => {
    const components = [
      ...walk(join(ROOT, 'components'), ['.tsx']),
      ...walk(join(ROOT, 'app'), ['.tsx']),
    ];
    for (const file of components) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/@keyframes\s+nav-pending-reveal/);
    }
  });

  it('PageSkeleton is its only consumer', () => {
    const consumers = [
      ...walk(join(ROOT, 'app'), ['.tsx', '.ts']),
      ...walk(join(ROOT, 'components'), ['.tsx', '.ts']),
      ...walk(join(ROOT, 'packages'), ['.tsx', '.ts']),
    ].filter((f) => /\bnav-pending-reveal\b/.test(readFileSync(f, 'utf8')));
    expect(consumers.map((f) => relative(ROOT, f).split(sep).join('/'))).toEqual([
      'components/ui/PageSkeleton.tsx',
    ]);
  });

  it('reduced motion keeps the 120ms delay and drops the motion', () => {
    const css = readFileSync(GLOBALS, 'utf8');
    // The default reveal: a 90ms fade that begins at 120ms.
    expect(css).toMatch(
      /\.nav-pending-reveal\s*\{\s*animation:\s*nav-pending-reveal\s+90ms\s+ease-out\s+120ms\s+both;/,
    );
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).not.toBe('');
    // The DELAY stays — this is the assertion that matters. A reduced-motion
    // arm that dropped the 120ms with the fade would make a fast route flash
    // for the one reader who asked for fewer flashes.
    expect(reduced).toMatch(
      /\.nav-pending-reveal\s*\{\s*animation:\s*nav-pending-reveal\s+1ms\s+step-end\s+120ms\s+both;/,
    );
    // …and the pulse stops, leaving static blocks.
    expect(reduced).toMatch(/\.nav-pending-frame\s+\.animate-pulse\s*\{\s*animation:\s*none;/);
  });
});

describe('the primitive is token-only, and ships nothing that consumes it (MOTIR-3531)', () => {
  const SOURCE = readFileSync(join(ROOT, 'components', 'ui', 'PageSkeleton.tsx'), 'utf8');
  /** The JSX class literals, so a token named in this file's PROSE is not judged. */
  const CLASSES = [...SOURCE.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((m) => m[1] ?? m[2])
    .join(' ');

  it('every colour is an --el-* element token — no Tier-0 --color-*, no invented hue', () => {
    expect(CLASSES).not.toMatch(/--color-/);
    expect(CLASSES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(CLASSES).not.toMatch(/\b(?:rgb|hsl|oklch)\(/);
    expect(CLASSES).toContain('bg-(--el-muted)');
  });

  it('every radius is an element-semantic shape token — no raw rounded-md / rounded-lg', () => {
    // `rounded-full` is the shape rule's own carve-out (genuinely circular
    // ends) and is not used here; anything else must name a --radius-* token.
    for (const cls of CLASSES.split(/\s+/).filter((c) => c.startsWith('rounded-'))) {
      expect(cls).toMatch(/^rounded-\(--radius-[a-z-]+\)$/);
    }
    expect(CLASSES).toContain('rounded-(--radius-control)');
  });

  it('ORDERING — no page under app/ imports or renders it in this PR', () => {
    // This card ships the primitive and nothing that consumes it. The settings
    // family (MOTIR-3443) and whatever rebuilds `/items/[key]`'s frame wire it
    // in on their own branches; a test asserting a consumer's behaviour belongs
    // to that consumer's card, not this one.
    //
    // ⚠️ The check is on the IMPORT and the JSX tag, NOT on the word. A page
    // that merely NAMES the primitive in a comment — `/code-health` says in
    // prose why it draws no frame — is not a consumer, and a word-grep would
    // fail this criterion against a file that consumes nothing.
    const consumers = walk(join(ROOT, 'app'), ['.tsx', '.ts']).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /^\s*import\b[^;]*\bPageSkeleton\b/m.test(src) || /<PageSkeleton[\s/>]/.test(src);
    });
    expect(consumers.map((f) => relative(ROOT, f).split(sep).join('/'))).toEqual([]);
  });
});
