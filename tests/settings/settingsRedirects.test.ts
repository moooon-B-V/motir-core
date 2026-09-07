import { describe, expect, it } from 'vitest';
import { DOCS_REDIRECTS, SETTINGS_REDIRECTS } from '../../next.config';

// The settings-area redirect map (MOTIR-2534 · Story MOTIR-2532).
//
// ── Why a test at all, for one line of config ───────────────────────────────
// The same argument `tests/api-docs/docs-redirects.test.ts` makes for the docs
// map: the tokens pane's address was renamed on the grounds that a URL is a
// promise to strangers, and that argument only holds while the old address keeps
// working. The failure is silent — a rule deleted in a later refactor breaks
// nothing any other test renders, and nobody notices until a bookmark, a shipped
// `docs/` link, or a published `@motir/cli` hint 404s.
//
// ── Why a SEPARATE file and a SEPARATE map ──────────────────────────────────
// `DOCS_REDIRECTS` is the docs map by name and by contract: the docs test
// asserts it exactly, and `tests/design-asset-addresses.test.ts` reads it as the
// set of addresses this repo declares dead. Appending a settings rule to it
// would make both names lie, so the config exports a sibling const and
// `redirects()` composes the two — which is the one thing that can silently go
// wrong, and is therefore what the last test here asserts.
//
// It reads the EXPORTS rather than calling `redirects()` through the built
// config, for the reason the docs test records: `next.config.ts` runs
// `withNextIntl` and seeds placeholder OAuth environment variables at module
// load, machinery this assertion does not need and should not depend on.

describe('the settings areas keep every address they ever served', () => {
  it('sends every moved pane to its new address, permanently', () => {
    // ⚠️ AN EXACT LIST, deliberately: a redirect quietly ADDED is a URL somebody
    // decided to stop serving, and this is where that decision is reviewed.
    // MOTIR-4680 added the two git rows when the connect surface moved a TIER —
    // a repository is connected once, to the ORGANISATION, so the workspace
    // routes stop existing rather than being duplicated.
    expect([...SETTINGS_REDIRECTS]).toEqual([
      {
        source: '/settings/account/api-tokens',
        destination: '/settings/account/tokens',
        permanent: true,
      },
      {
        source: '/settings/workspace/github',
        destination: '/settings/organization/git',
        permanent: true,
      },
      {
        // The GitLab arm keeps its provider through the search param rather than
        // a second route: the organisation's inventory spans BOTH providers, so
        // the Segmented switches the connection card, not the page.
        source: '/settings/workspace/gitlab',
        destination: '/settings/organization/git?provider=gitlab',
        permanent: true,
      },
    ]);
  });

  it('is permanent — a 307 would keep crawlers and bookmarks on the old address', () => {
    // `permanent: true` is a 308. The pane's old address is quoted in shipped
    // `docs/cli.md`, in `docs/mcp.md`, in a published CLI's help text and in two
    // design assets kept as point-in-time records, so it has to keep working
    // forever rather than for a deprecation window.
    for (const rule of SETTINGS_REDIRECTS) expect(rule.permanent).toBe(true);
  });

  it('lands on a real page, not on another redirect', () => {
    // A destination that is itself a source would cost a second hop and is a
    // chain that breaks one rule at a time — the trap the docs map's own
    // ordering rules exist to avoid.
    const everySource = new Set<string>(
      [...DOCS_REDIRECTS, ...SETTINGS_REDIRECTS].map((rule) => rule.source),
    );
    for (const rule of SETTINGS_REDIRECTS) expect(everySource.has(rule.destination)).toBe(false);
  });

  it('does not collide with the docs map', () => {
    // The two maps are composed into one ordered list, so a source declared in
    // both would make whichever is spread first silently win.
    const docsSources = new Set<string>(DOCS_REDIRECTS.map((rule) => rule.source));
    for (const rule of SETTINGS_REDIRECTS) expect(docsSources.has(rule.source)).toBe(false);
  });
});
