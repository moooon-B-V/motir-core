import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '@/lib/utils/regexp';

// MOTIR-2418 — the escape that replaced seven hand-rolled character classes.
// The backslash case is the one that matters: it is the character every one of
// those classes omitted, and the failure is silent rather than loud — an
// unescaped `\` does not throw, it quietly turns the next character into a
// metacharacter, so the pattern still compiles and still matches *something*.
// That is why each case below asserts a LITERAL match rather than just
// inspecting the escaped string.

const matchesItself = (value: string) => new RegExp(escapeRegExp(value)).test(value);

describe('escapeRegExp', () => {
  it('escapes the backslash — the character the hand-rolled classes omitted', () => {
    expect(escapeRegExp('a\\d')).toBe('a\\\\d');
    // Unescaped, `a\d` would match "a" + any DIGIT. Escaped, it matches only
    // the literal three-character string.
    const pattern = new RegExp(`^${escapeRegExp('a\\d')}$`);
    expect(pattern.test('a\\d')).toBe(true);
    expect(pattern.test('a5')).toBe(false);
  });

  it('escapes a Windows-style path so it matches literally', () => {
    const path = 'app\\(public)\\docs\\sandbox\\page.tsx';
    expect(matchesItself(path)).toBe(true);
    expect(new RegExp(`^${escapeRegExp(path)}$`).test('appX(public)Xdocs')).toBe(false);
  });

  it('escapes every ECMAScript metacharacter', () => {
    for (const char of '.*+?^${}()|[]\\/') {
      expect(matchesItself(char), `${char} is not escaped`).toBe(true);
    }
  });

  it('leaves a string with no metacharacters unchanged', () => {
    expect(escapeRegExp('--el-role-admin')).toBe('--el-role-admin');
    expect(escapeRegExp('zzz-distinct-id')).toBe('zzz-distinct-id');
  });

  it('reproduces what the call sites it replaced used to produce', () => {
    // tests/api-docs/sandbox-truth.test.tsx — a POSIX route path.
    expect(escapeRegExp('app/(public)/docs/sandbox/page.tsx')).toBe(
      'app\\/\\(public\\)\\/docs\\/sandbox\\/page\\.tsx',
    );
    // tests/e2e/billing-cloud.spec.ts — a URL path.
    expect(escapeRegExp('/settings/account/billing')).toBe('\\/settings\\/account\\/billing');
  });
});
