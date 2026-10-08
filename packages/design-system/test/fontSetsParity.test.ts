import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FONT_SET_IDS,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  fontSetMemberVar,
  type FontSetMember,
} from '../src/index';

// MOTIR-7850 — registry ↔ theme.css parity, in BOTH directions. The two sides
// are read independently: the stylesheet's blocks are collected by their
// selector shape, never looked up by a registry name, so a block deleted from
// theme.css, a member added to the registry, or a stray block added to theme.css
// each fails a test here. (fontSetsCss.test.ts holds the cascade ORDER; this
// file holds the one-to-one correspondence.)

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(PKG_ROOT, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const GENERIC = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' } as const;

interface Block {
  selector: string;
  decls: Record<string, string>;
}

/** Every flat rule whose selector list names `:lang(`, one entry per selector. */
const LANG_BLOCKS: Block[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => {
  const prelude = (m[1] ?? '').split(';').pop()?.trim() ?? '';
  if (!prelude.includes(':lang(')) return [];
  const decls = Object.fromEntries(
    (m[2] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
  return prelude.split(',').map((selector) => ({ selector: selector.trim(), decls }));
});

/** `[lang]:lang(x)` — a language's own block. */
const SET_BLOCK = /^\[lang\]:lang\(([\w-]+)\)$/;
/** `:lang(x)[data-font-set-<role>='<id>']` — a member applied by name. */
const MEMBER_BLOCK = /^:lang\(([\w-]+)\)\[data-font-set-(sans|serif|mono)='([\w-]+)'\]$/;

const setBlocks = LANG_BLOCKS.filter((b) => SET_BLOCK.test(b.selector));
const memberBlocks = LANG_BLOCKS.filter((b) => MEMBER_BLOCK.test(b.selector));
const latinLocales = Object.entries(LOCALE_FONT_SET)
  .filter(([, set]) => set === 'latin')
  .map(([locale]) => locale);
const cjkSets = FONT_SET_IDS.filter((id) => FONT_SET_REGISTRY[id].cjk);

describe('font-set registry ↔ theme.css parity (MOTIR-7850)', () => {
  it('holds no :lang() block of any other shape', () => {
    const other = LANG_BLOCKS.filter(
      (b) => !SET_BLOCK.test(b.selector) && !MEMBER_BLOCK.test(b.selector),
    );
    expect(other.map((b) => b.selector)).toEqual([]);
  });

  it('gives every CJK set exactly one block, setting its three script tokens to the defaults', () => {
    for (const id of cjkSets) {
      const set = FONT_SET_REGISTRY[id];
      const found = setBlocks.filter((b) => b.selector === `[lang]:lang(${set.lang})`);
      expect(found, id).toHaveLength(1);
      expect(found[0]?.decls).toEqual(
        Object.fromEntries(
          FONT_SET_ROLES.map((role) => [
            `--font-script-${role}`,
            `var(${fontSetMemberVar(id, role, set.roles[role].default)}, ${GENERIC[role]})`,
          ]),
        ),
      );
    }
  });

  it('gives every Latin locale exactly one reset block, and names no language the registry does not', () => {
    const cjkLangs = cjkSets.map((id) => FONT_SET_REGISTRY[id].lang);
    const langs = setBlocks.map((b) => SET_BLOCK.exec(b.selector)?.[1] ?? '');
    expect([...langs].sort()).toEqual([...latinLocales, ...cjkLangs].sort());
    for (const b of setBlocks.filter((x) =>
      latinLocales.includes(SET_BLOCK.exec(x.selector)?.[1] ?? ''),
    )) {
      expect(b.decls, b.selector).toEqual({
        '--font-script-sans': 'initial',
        '--font-script-serif': 'initial',
        '--font-script-mono': 'initial',
      });
    }
  });

  it('gives every non-default member exactly one by-name block, and has none for anything else', () => {
    const expected: string[] = [];
    for (const id of cjkSets) {
      const set = FONT_SET_REGISTRY[id];
      for (const role of FONT_SET_ROLES) {
        for (const m of set.roles[role].members as readonly FontSetMember[]) {
          if (m.id === set.roles[role].default) continue;
          const selector = `:lang(${set.lang})[data-font-set-${role}='${m.id}']`;
          expected.push(selector);
          const found = memberBlocks.filter((b) => b.selector === selector);
          expect(found, selector).toHaveLength(1);
          expect(found[0]?.decls).toEqual({
            [`--font-script-${role}`]: `var(${fontSetMemberVar(id, role, m.id)}, ${GENERIC[role]})`,
          });
        }
      }
    }
    expect(memberBlocks.map((b) => b.selector).sort()).toEqual(expected.sort());
  });

  it('reads no --font-set-* variable the registry does not name', () => {
    const named = new Set<string>();
    for (const id of FONT_SET_IDS) {
      for (const role of FONT_SET_ROLES) {
        for (const m of FONT_SET_REGISTRY[id].roles[role].members as readonly FontSetMember[]) {
          const v = fontSetMemberVar(id, role, m.id);
          if (v) named.add(v);
        }
      }
    }
    const read = new Set([...CSS.matchAll(/var\(\s*(--font-set-[\w-]+)/g)].map((m) => m[1]));
    expect([...read].filter((v) => !named.has(v!))).toEqual([]);
    expect(read.size).toBeGreaterThan(0);
  });
});
