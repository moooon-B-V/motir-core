import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { AI_CALLOUT_NAME_KEY, aiCalloutActions } from '@/lib/planning/aiCallout';
import { planningOverlaySearch, type PlanningLaunchContext } from '@/lib/planning/launcher';

// ⚠️ RE-POINTED (MOTIR-4730). `aiCalloutActions` takes the resolved OVERLAY
// address now instead of a context — the workspace is a layer on the current
// page and only a component can read that address. These guards are about the
// registry's INVARIANTS, not about who computes the href, so they pass the
// address a door would actually produce.
function overlayHref(context: PlanningLaunchContext, page = '/backlog'): string {
  return `${page}?${planningOverlaySearch(context).toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.24 · MOTIR-1813 — the ARCHITECTURE / CONTRACT half of the story gate:
// the guarantees a coverage percentage cannot see.
//
// The shell (MOTIR-1812) shipped its own units and they are dense — the
// registry's order, its one-href invariant, its per-field non-emptiness and the
// "no dead rows" rule are all driven by `tests/planning/aiCallout.test.ts`, and
// the orb's open / select / Escape / focus-return behaviour by
// `tests/components/ai-callout-menu.test.tsx`. Measured over the merged surface,
// all three story files sit at 100% branch / function / line, so this card's §1
// deliverable was to WIRE that floor into `vitest.config.ts` (coverage.include +
// the per-file ≥90% thresholds), not to write catch-up tests. Re-deriving the
// per-subtask floors is the recurring story-gate failure (notes.html
// #69/#102/#145) and none of it is repeated here.
//
// What is genuinely unguarded is the residue below — three standing invariants,
// asserted by reading the shipped source the way a reviewer would (the
// `planChangeArchitecture` / `render-single-source` pattern):
//
//   1. CATALOG RESOLUTION, both directions. Every key the registry names must
//      resolve to real copy in en AND zh — the seam that catches an action added
//      to the registry but missing from a catalog — and, inversely, no
//      `aiCallout` copy may linger that no registered action names.
//   2. The PURITY BOUNDARY. `lib/planning/aiCallout.ts` stays framework-free, so
//      it runs identically in the client menu, in ⌘K and in a node-env test —
//      the same contract its sibling `lib/planning/launcher.ts` holds.
//   3. The REGISTRY IS THE SINGLE SOURCE of the menu's rows. This is what makes
//      MOTIR-1343 / MOTIR-1344 a one-entry change instead of a component edit:
//      neither the panel nor the orb may hardcode an action's id, copy key or
//      destination.
//
// The assembled registry → menu → launcher-href seams live in
// `tests/components/ai-callout-story-gate.test.tsx`; token discipline is lint's.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();

const REGISTRY_MODULE = 'lib/planning/aiCallout.ts';
const LAUNCHER_MODULE = 'lib/planning/launcher.ts';
const MENU_COMPONENT = 'components/planning/AiCalloutMenu.tsx';
const ORB_COMPONENT = 'components/planning/PlanWithAIFab.tsx';

/**
 * Every context the callout can be summoned from. The registry takes the
 * context as its only input, so a guard that walks one context proves nothing
 * about the others.
 */
const CONTEXTS: PlanningLaunchContext[] = [
  { kind: 'project' },
  { kind: 'project', hasPlan: true },
  { kind: 'project', hasPlan: false },
  { kind: 'work-item', itemKey: 'MOTIR-1813' },
  { kind: 'work-item', itemKey: 'MOTIR-1813', hasPlan: true },
  { kind: 'roadmap' },
  { kind: 'convention-refine', repoKey: 'motir-core' },
];

/** Every message key the registry names, across every context, de-duplicated. */
const REGISTRY_KEYS: string[] = [
  ...new Set([
    AI_CALLOUT_NAME_KEY,
    ...CONTEXTS.flatMap((c) => aiCalloutActions(overlayHref(c))).flatMap((a) => [
      a.titleKey,
      a.descriptionKey,
    ]),
  ]),
];

/**
 * A hardcoded planning-workspace PATH — the thing a component may not build.
 * Anchored on the opening quote so the module specifier `@/lib/planning/…`,
 * which every one of these files legitimately imports through, is not mistaken
 * for a route.
 */
const ROUTE_LITERAL = /['"`]\/planning/;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * The file's CODE, with comments removed. A header note is the RECORD of why a
 * decision was made — the orb's own comment mentions `/planning` to explain
 * which doors still go there — so the guards below must read the code, not the
 * commentary that documents it.
 */
function codeOf(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

/**
 * Resolve a dotted key path against a catalog, returning the leaf only when it
 * is a real non-empty string. The registry's keys are relative to the `shell`
 * namespace (`useTranslations('shell')`), which is what the menu passes them to.
 */
function resolve(catalog: unknown, path: string): string | null {
  const leaf = path
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog,
    );
  return typeof leaf === 'string' && leaf.trim() !== '' ? leaf : null;
}

/** Every leaf key path under a catalog subtree, sorted — nesting-aware parity. */
function keyPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

const shellEn = (en as unknown as Record<string, unknown>)['shell'];
const shellZh = (zh as unknown as Record<string, unknown>)['shell'];
const calloutEn = (shellEn as Record<string, unknown>)['aiCallout'];
const calloutZh = (shellZh as Record<string, unknown>)['aiCallout'];

// ─────────── Guard 1 — the registry's copy exists, in every locale ───────────

describe('every key the registry names resolves to real copy', () => {
  it.each(REGISTRY_KEYS)('shell.%s is non-empty in en AND zh', (key) => {
    // The failure this catches is the one the extension contract invites: the
    // registry grows an entry (MOTIR-1343 / MOTIR-1344) and one catalog does not,
    // so the menu renders a raw key string — visibly broken, and invisible to a
    // coverage number, because the row still rendered.
    expect(resolve(shellEn, key), `en: shell.${key}`).not.toBeNull();
    expect(resolve(shellZh, key), `zh: shell.${key}`).not.toBeNull();
  });

  it('resolves through the REGISTRY, not a hand-written list', () => {
    // A guard on the guard: were the registry ever to return no actions, the
    // `it.each` above would silently run over the name key alone and pass.
    expect(REGISTRY_KEYS.length).toBeGreaterThanOrEqual(3);
    expect(REGISTRY_KEYS).toContain(AI_CALLOUT_NAME_KEY);
    for (const context of CONTEXTS)
      expect(aiCalloutActions(overlayHref(context)).length).toBeGreaterThan(0);
  });

  it('the whole shell.aiCallout subtree matches key-for-key across locales', () => {
    // Whole-file parity is `i18n-catalog.test.ts`'s job; this states the
    // callout's OWN subtree, so a zh block that lost a nested group cannot pass
    // parity by being deleted at the top level.
    expect(calloutEn).toBeDefined();
    expect(calloutZh).toBeDefined();
    expect(keyPaths(calloutZh)).toEqual(keyPaths(calloutEn));
  });

  it('carries NO orphan action copy — every catalog row has a registered action', () => {
    // The inverse direction, which the parity check above cannot see: retiring
    // an action and leaving its two strings behind is copy translators keep
    // maintaining for a row the product no longer offers. Read off the CATALOG,
    // so a leftover subtree fails here rather than lingering forever.
    const actionsEn = (calloutEn as Record<string, unknown>)['actions'];
    const catalogKeys = keyPaths(actionsEn).map((p) => `aiCallout.actions.${p}`);
    expect(catalogKeys.length).toBeGreaterThan(0);
    expect(catalogKeys.filter((k) => !REGISTRY_KEYS.includes(k))).toEqual([]);
  });
});

// ─────────── Guard 2 — the registry stays framework-free ───────────

describe('the callout registry holds the launcher’s purity contract', () => {
  it.each([REGISTRY_MODULE, LAUNCHER_MODULE])(
    '%s imports no React and nothing server-only',
    (rel) => {
      const code = codeOf(rel);
      // Either import re-scopes the module: `server-only` makes it un-importable
      // from the client menu, and React makes it un-importable from a node-env
      // test — and the menu, ⌘K and these very specs all read it.
      expect(code, `${rel} must not import React`).not.toMatch(
        /from ['"]react(-dom)?(\/[^'"]*)?['"]/,
      );
      expect(code, `${rel} must not import server-only`).not.toMatch(/['"]server-only['"]/);
      expect(code, `${rel} must not import a component`).not.toMatch(/from ['"]@\/components\//);
      expect(code, `${rel} must not import next/*`).not.toMatch(/from ['"]next\//);
      // …and it is not a client module either: a `'use client'` directive would
      // pull it into the bundle graph as UI rather than leaving it shared.
      expect(
        read(rel).trimStart().startsWith("'use client'"),
        `${rel} is not a client module`,
      ).toBe(false);
    },
  );

  it('the scan is reading real source, not an empty string', () => {
    // Every assertion above is a NEGATIVE match, so an unreadable or emptied
    // file would pass all of them. Pin one positive fact per module.
    // ⚠️ RE-POINTED (MOTIR-4730). This used to pin `from './launcher'` on the
    // registry. The registry no longer imports it at all — it RECEIVES the
    // resolved overlay address rather than building one — so the positive
    // control moves to the export itself and to the field the row carries. The
    // module got MORE pure, not less, which is why this is a re-point and not a
    // relaxation.
    expect(codeOf(REGISTRY_MODULE)).toMatch(/export function aiCalloutActions\(href: string\)/);
    expect(codeOf(REGISTRY_MODULE)).toMatch(/id: 'plan'/);
    // ⚠️ RE-POINTED AGAIN (MOTIR-4732): `planningWorkspaceHref` is DELETED with
    // the route. The launcher's positive control is now the pair that replaced
    // it — the address composer and the mount predicate.
    expect(codeOf(LAUNCHER_MODULE)).toMatch(/export function withPlanningOverlay/);
    expect(codeOf(LAUNCHER_MODULE)).toMatch(/export function parsePlanningOverlay/);
    // ⚠️ THE ROUTE-LITERAL GUARD'S POSITIVE CONTROL MOVED (MOTIR-4732), and where
    // it moved TO is the finding. The launcher was "the ONE module that may name
    // the path", and it named it in code. It does not any more: the trio that
    // built `/planning` is deleted, and every mention left in that file is in the
    // retirement note — which `codeOf` strips, correctly.
    //
    // So the control moves to the one place that still names the path in CODE:
    // `proxy.ts`'s matcher entry, kept on purpose so a cookie-less request to a
    // bookmarked `/planning?…` gets the `/sign-in?next=…` bounce instead of the
    // segment's own gate. That keeps the `not.toMatch` assertions below real
    // constraints rather than a pattern matching nothing anywhere.
    expect(codeOf('proxy.ts')).toMatch(ROUTE_LITERAL);
    // …and it does not fire on the module specifier every one of these files
    // imports through, which is what made the first draft of it vacuous.
    expect("import x from '@/lib/planning/launcher';").not.toMatch(ROUTE_LITERAL);
  });
});

// ─────── Guard 3 — the registry is the SINGLE source of the menu's rows ───────

describe('a new action is ONE registry entry — the components hardcode nothing', () => {
  it('the menu derives its rows from the registry alone', () => {
    const code = codeOf(MENU_COMPONENT);
    expect(code).toMatch(/aiCalloutActions\(/);
    // No action id, no copy key and no destination may appear as a literal: each
    // one is a place a future action could be half-wired, rendering a row the
    // registry does not know about (or omitting one it does).
    expect(code, 'the menu must not name a copy key literally').not.toMatch(/aiCallout\.actions\./);
    expect(code, 'the menu must not build a destination').not.toMatch(ROUTE_LITERAL);
    expect(code, 'the menu must not name an action id').not.toMatch(/['"]plan['"]/);
    expect(code, 'the menu must not import the launcher’s href builder').not.toMatch(
      /planningOverlaySearch|withPlanningOverlay/,
    );
  });

  it('the orb delegates the whole panel — it neither routes nor lists actions', () => {
    // The orb used to navigate straight to the workspace. It is now a trigger:
    // the destination lives in the registry, one level in, so the orb must carry
    // no href of its own — otherwise the two drift and the "one surface"
    // invariant holds in the registry while the orb quietly bypasses it.
    const code = codeOf(ORB_COMPONENT);
    expect(code).toMatch(/<AiCalloutMenu/);
    expect(code, 'the orb must not build a destination').not.toMatch(ROUTE_LITERAL);
    expect(code, 'the orb must not build an href').not.toMatch(
      /planningOverlaySearch|withPlanningOverlay/,
    );
    expect(code, 'the orb must not enumerate actions').not.toMatch(/aiCalloutActions/);
    // Trigger and panel take their shared name from the ONE exported key, so
    // they cannot drift apart.
    expect(code).toMatch(/AI_CALLOUT_NAME_KEY/);
    expect(codeOf(MENU_COMPONENT)).toMatch(/AI_CALLOUT_NAME_KEY/);
  });

  it('the icon map is exhaustive over the registry’s icon union', () => {
    // `ICONS` is typed `Record<AiCalloutIcon, LucideIcon>`, so the compiler
    // rejects a new union member with no glyph — but only while the record stays
    // exhaustively typed. Pin that, plus the two glyphs the design reserves for
    // the unlanded actions, so MOTIR-1343 / MOTIR-1344 really do need no
    // component change.
    const code = codeOf(MENU_COMPONENT);
    expect(code).toMatch(/Record<AiCalloutIcon, LucideIcon>/);
    for (const icon of ['sparkles', 'message-circle-question', 'wrench']) {
      expect(code, `the icon map must cover "${icon}"`).toContain(icon);
    }
  });
});
