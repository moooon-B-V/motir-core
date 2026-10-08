import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPaint } from './mockStateInkScan';

// MOTIR-7850 — the story gate's guards over the seams between the font-set
// pieces, each read from the source it checks rather than from the registry
// that generated it:
//   1. theme.css → app/fonts.ts: every --font-set-* variable the stylesheet
//      READS is declared by a loader, joined into fontVariables, unpreloaded.
//   2. the font-set blocks set only --font-* tokens, in the grammar the
//      composition uses (so no hex, no hue name, nothing else can hide there),
//      and every one is total over sans / serif / mono.
//   3. both <html> owners carry fontVariables and the resolved locale's lang.
// (Pairing chains free of generic keywords: packages/design-system/test/fontSetsCss.test.ts.
//  Registry ↔ theme.css: packages/design-system/test/fontSetsParity.test.ts.
//  Registry ↔ app/fonts.ts: tests/theme/fontSetFaces.test.ts.)

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const CSS = read('packages/design-system/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
const FONTS_TS = read('app/fonts.ts');

const ROLES = ['sans', 'serif', 'mono'] as const;
const GENERIC = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' } as const;

interface Rule {
  selectors: string[];
  decls: [string, string][];
}

/** Every flat rule whose selector names `:lang(` or `[data-font-set-` — the font-set blocks. */
const FONT_SET_RULES: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({
    selectors: ((m[1] ?? '').split(';').pop() ?? '').split(',').map((s) => s.trim()),
    decls: (m[2] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]) as [
      string,
      string,
    ][],
  }))
  .filter((r) => r.selectors.some((s) => s.includes(':lang(') || s.includes('[data-font-set-')));

describe('theme.css → app/fonts.ts (MOTIR-7850)', () => {
  const readVars = [
    ...new Set([...CSS.matchAll(/var\(\s*(--font-set-[\w-]+)/g)].map((m) => m[1]!)),
  ];
  const loaders = [...FONTS_TS.matchAll(/const (\w+) = \w+\(\{([^}]*)\}\);/g)].map((m) => ({
    name: m[1]!,
    body: m[2]!,
  }));
  const joined = /export const fontVariables = \[([^\]]*)\]/.exec(FONTS_TS)?.[1] ?? '';

  it('finds the variables theme.css reads', () => {
    expect(readVars.length).toBeGreaterThan(0);
  });

  it.each(readVars)('%s is declared, unpreloaded, and in fontVariables', (variable) => {
    const loader = loaders.filter((l) => l.body.includes(`variable: '${variable}'`));
    expect(loader, `one loader declares ${variable}`).toHaveLength(1);
    expect(loader[0]!.body).toContain('preload: false');
    expect(joined).toMatch(new RegExp(`\\b${loader[0]!.name}\\.variable\\b`));
  });
});

describe('the font-set blocks (MOTIR-7850)', () => {
  // A POSITIVE grammar rather than a list of forbidden values: anything that is
  // not one of these three shapes fails, so a hex, a hue name or any other value
  // cannot pass by being missing from a deny-list.
  const VALUE =
    /^(?:initial|var\(--font-set-[\w-]+, (?:sans-serif|serif|monospace)\)|var\(--font-(?:sans|serif|mono)-pairing, [^;]+\), var\(--font-script-(?:sans|serif|mono), var\(--font-(?:sans|serif|mono)-tail, (?:sans-serif|serif|monospace)\)\), var\(--font-(?:sans|serif|mono)-tail, (?:sans-serif|serif|monospace)\))$/;

  it('finds them', () => {
    expect(FONT_SET_RULES.length).toBeGreaterThan(5);
  });

  it('set only --font-* custom properties, in the composition grammar, with no colour', () => {
    for (const r of FONT_SET_RULES) {
      for (const [name, value] of r.decls) {
        const where = `${r.selectors.join(', ')} { ${name} }`;
        expect(name, where).toMatch(/^--font-/);
        expect(value.replace(/\s+/g, ' '), where).toMatch(VALUE);
        for (const word of value.split(/[\s,()]+/)) {
          expect(classifyPaint(word), `${where}: ${word}`).toBe('unreadable');
        }
      }
    }
  });

  it('are total over sans / serif / mono', () => {
    for (const r of FONT_SET_RULES) {
      const names = r.decls.map(([n]) => n);
      const where = r.selectors.join(', ');
      if (r.selectors.some((s) => /\[data-font-set-(sans|serif|mono)='/.test(s))) {
        // A by-name block overrides the ONE role its attribute names.
        const role = /\[data-font-set-(sans|serif|mono)='/.exec(where)?.[1];
        expect(names, where).toEqual([`--font-script-${role}`]);
      } else if (names.some((n) => n.startsWith('--font-script-'))) {
        expect([...names].sort(), where).toEqual(ROLES.map((r) => `--font-script-${r}`).sort());
      } else {
        // The composition rule: every role token, each with its generic.
        expect([...names].sort(), where).toEqual(ROLES.map((r) => `--font-${r}`).sort());
        for (const [n, v] of r.decls) {
          expect(v, where).toContain(GENERIC[n.slice('--font-'.length) as (typeof ROLES)[number]]);
        }
      }
    }
  });
});

describe('both <html> owners apply the font sets (MOTIR-7850)', () => {
  it.each(['app/layout.tsx', 'app/global-error.tsx'])(
    '%s imports fontVariables and puts it, with the resolved lang, on <html>',
    (file) => {
      const src = read(file);
      expect(src).toMatch(/import \{ fontVariables \} from '\.\/fonts';/);
      // The JSX element, not a `<html>` mentioned in a comment.
      const html = /\(\s*<html\s([^>]*)>/.exec(src)?.[1] ?? '';
      expect(html).toMatch(/\blang=\{locale\}/);
      expect(html).toMatch(/className=\{`\$\{fontVariables\}[^`]*`\}/);
    },
  );
});
