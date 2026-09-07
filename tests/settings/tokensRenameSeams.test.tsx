import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_REDIRECTS, LANDING_REDIRECTS, SETTINGS_REDIRECTS } from '../../next.config';
import { ACCOUNT_SETTINGS_NAV, ACCOUNT_SETTINGS_ROUTES } from '@/lib/settings/accountSettingsNav';
import {
  V1_SECURITY_SCHEME_NAME,
  v1SecurityScheme,
  V1_PERMISSION_EXTENSION,
} from '@/lib/api/v1/openapi/security';

// MOTIR-2540 — the three writer→consumer SEAMS Story MOTIR-2532 created.
//
// Each sibling card's own tests prove its half in isolation, which is the
// per-subtask floor and is not what this file is for. These assert the JOIN:
// the places where one card's output is read by another card's code, and where
// a unit test on either side passes while the pair is wrong.

describe('the tokens rename — the seams between its cards', () => {
  // ── SEAM 1 · the nav registry → the address it actually navigates to ──────
  it('routes the Security row at /settings/account/tokens, on disk', () => {
    const entry = ACCOUNT_SETTINGS_NAV.find((e) => e.id === 'apiTokens');
    expect(entry, 'the account rail must still carry a tokens entry').toBeDefined();
    expect(entry!.href).toBe('/settings/account/tokens');
    expect(entry!.group).toBe('security');

    // The registry is data; the ROUTE is a file. `accountSettingsNav.test.ts`
    // asserts the two are 1:1, so this only has to pin the direction the rename
    // moved — that the pane really is served from the new segment and not the
    // old one.
    const root = process.cwd();
    expect(() =>
      readFileSync(join(root, 'app/(authed)/settings/account/tokens/page.tsx'), 'utf8'),
    ).not.toThrow();
    expect(() =>
      readFileSync(join(root, 'app/(authed)/settings/account/api-tokens/page.tsx'), 'utf8'),
    ).toThrow();

    // The id and labelKey are the story's kept identifiers — a later tidy-up
    // that "finishes the rename" by moving them would break the command-palette
    // action id and the i18n lookup, both silently.
    expect(entry!.id).toBe('apiTokens');
    expect(entry!.labelKey).toBe('apiTokens');
    expect(ACCOUNT_SETTINGS_ROUTES).toContain(entry);
  });

  // ── SEAM 2 · the redirect map → the design-address guard ──────────────────
  it('declares the old address in a map the address guard actually reads', () => {
    const rule = SETTINGS_REDIRECTS.find((r) => r.source === '/settings/account/api-tokens');
    expect(rule, 'the old address must still redirect').toBeDefined();
    expect(rule!.destination).toBe('/settings/account/tokens');
    expect(rule!.permanent).toBe(true);

    // THE SEAM. `tests/design-asset-addresses.test.ts` builds REDIRECT_SOURCES
    // by spreading the redirect maps; if a map is added to `redirects()` and not
    // to that spread, every asset quoting its addresses is reported as
    // resolving to nothing — a guard failing on addresses that are live.
    //
    // ⚠️ IT IS DERIVED FROM `redirects()`, NOT PINNED TO TWO NAMES (MOTIR-4783).
    // This used to match `/\[\.\.\.DOCS_REDIRECTS,\s*\.\.\.SETTINGS_REDIRECTS\]/` — the
    // exact two-map expression — and MOTIR-4782 added `LANDING_REDIRECTS` as a
    // third, which is precisely the event the paragraph above describes. The
    // guard's spread WAS updated; this assertion went red anyway, because a
    // regex pinned to today's list cannot tell "a map was added and forgotten"
    // from "a map was added and handled". So it now reads the map NAMES out of
    // `redirects()` and requires each to appear in the spread: the same claim,
    // and it survives the fourth map.
    const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
    const composed = /async redirects\(\)\s*\{[^}]*return\s*\[([^\]]*)\]/.exec(config);
    expect(composed, 'redirects() must still compose its maps by spreading them').not.toBeNull();
    const maps = [...composed![1]!.matchAll(/\.\.\.([A-Z_]+)/g)].map((m) => m[1]!);
    expect(maps.length, 'the parse found no maps — the regex has rotted').toBeGreaterThanOrEqual(3);

    const guard = readFileSync(join(process.cwd(), 'tests/design-asset-addresses.test.ts'), 'utf8');
    const spread = /const REDIRECT_SOURCES = \[([^\]]*)\]/.exec(guard);
    expect(
      spread,
      'the address guard must still build REDIRECT_SOURCES from a spread',
    ).not.toBeNull();
    for (const name of maps) {
      expect(
        spread![1],
        `${name} is composed into redirects() and missing from the guard`,
      ).toContain(name);
    }

    // And no two maps may claim the same source — they are concatenated, so the
    // first spread would silently win.
    //
    // `Set<string>` explicitly: every map is `as const`, so an inferred Set
    // narrows to one map's literal union and `.has()` then rejects another's
    // source at compile time — the collision this line exists to test becomes a
    // type error instead of an assertion. (`settingsRedirects.test.ts`
    // annotates it for the same reason; this file did not, and CI caught it.)
    const seen = new Set<string>();
    for (const r of [...DOCS_REDIRECTS, ...SETTINGS_REDIRECTS, ...LANDING_REDIRECTS]) {
      expect(seen.has(r.source), `${r.source} is claimed by two redirect maps`).toBe(false);
      seen.add(r.source);
    }
  });

  // ── SEAM 3 · the security-scheme constant → the EMITTED document ──────────
  it('publishes the renamed mint path while the wire contract stays put', async () => {
    // Read it back out of the GENERATED document rather than asserting the
    // source constant: the description is prose the emitter copies, and the
    // thing a client reads is the emitted document.
    const { emitOpenApiDocument } = await import('@/lib/api/v1/openapi/emit');
    const doc = emitOpenApiDocument() as unknown as {
      components?: {
        securitySchemes?: Record<
          string,
          { description?: string; bearerFormat?: string; type?: string; scheme?: string }
        >;
      };
    };
    const scheme = doc.components?.securitySchemes?.[V1_SECURITY_SCHEME_NAME];
    expect(scheme, `the emitted document must register ${V1_SECURITY_SCHEME_NAME}`).toBeDefined();

    expect(scheme!.description).toContain('Settings → Account → Tokens');
    expect(scheme!.description).not.toMatch(/API tokens?/i);

    // THE HALF THAT MUST NOT MOVE. The scheme NAME and the bearer FORMAT are a
    // wire contract clients match on; renaming `motir_pat_` would invalidate
    // every token ever minted. The description is prose; the format is not.
    expect(V1_SECURITY_SCHEME_NAME).toBe('bearerPat');
    expect(scheme!.bearerFormat).toBe('motir_pat_<secret>');
    expect(scheme!.type).toBe('http');
    expect(scheme!.scheme).toBe('bearer');
    expect(v1SecurityScheme.bearerFormat).toBe('motir_pat_<secret>');
    // ⚠️ MOTIR-2532 pinned this as "the wire contract stays put" while the pane
    // was RENAMED. MOTIR-2577 changes the wire deliberately and with no
    // compatibility window (`docs/decisions/token-permissions.md` §6): the old
    // extension carried values from a vocabulary that no longer exists, so
    // emitting it would publish a name resolving to a scope no token can be
    // granted. The rest of the scheme — the bearer format above — is what
    // "stays put" still means.
    expect(V1_PERMISSION_EXTENSION).toBe('x-motir-permission');
  });
});
