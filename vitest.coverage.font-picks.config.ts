import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-7736's `motir-core` COVERAGE FLOOR (MOTIR-7900) — pick your font
// per language, saved on your account and applied on the first byte.
//
// ⚠️ WHAT THIS FLOOR IS FOR. It does not decide whether the story is correct —
// `tests/integration/font-picks-story-gate.test.ts` (real Postgres) and
// `tests/components/font-picks-story-gate.test.tsx` (DOM) hold the cross-layer
// properties a percentage cannot see: PATCH → row → `getAppliedForRequest` →
// `<html>` parity computed from `fontSetPickAttributes`, refusals that leave the
// whole row unchanged, stale members, export and erasure. What this catches is a
// LATER change that deletes a branch's only test and keeps the branch.
//
// ⚠️ PER-FILE, NEVER GLOBAL, over the story's changed surface. Reading taken
// 2026-10-09 with this lane's own command (`pnpm coverage:font-picks`),
// statements / branches / functions / lines:
//   - lib/appearance/fontPicks.ts                          100 / 87.5  / 100   / 100
//   - lib/mappers/appearancePreferenceMappers.ts           100 / 100   / 100   / 100
//   - lib/services/appearancePreferenceService.ts          100 / 100   / 100   / 100
//   - lib/repositories/userAppearancePreferenceRepository  100 / 100   / 100   / 100
//   - app/api/appearance-preference/route.ts               100 / 96.77 / 100   / 100
//   - app/(authed)/settings/account/_components/LanguageFontPicker.tsx
//                                                          100 / 96.96 / 100   / 100
//   - packages/design-system/src/theme/fontSets.ts       98.14 / 91.66 / 100   / 100
//   - packages/design-system/src/theme/init-script.ts      100 / 100   / 100   / 100
//   - packages/design-system/src/contexts/theme-context.tsx
//                                                        94.59 / 92.39 / 94.11 / 97.72
// (`LanguageFontPicker.tsx` is the surface the card called `FontsByLanguageField`:
// MOTIR-7899 was built to the approved revision-3 design, which folds the font
// choice into the Typography axis rather than a separate field.)
//
// ⚠️ ONE BRANCH FLOOR IS 87.5, NOT 90, AND THAT IS A NAMED UNREACHABLE BRANCH,
// NOT A LOWERED BAR. `fontPicks.ts` has 8 branches; the 8th is the `?? ''` in
// `fontSetHtmlAttrs` (`lang.trim().split(/[-_]/)[0]?.toLowerCase() ?? ''`).
// `String.prototype.split` with no limit always returns at least one element,
// so `[0]` is never undefined and the right side never runs — 7/8 = 87.5 is the
// file's ceiling while the code stands. Reaching 90 needs a product change (or a
// `v8 ignore` hint in that file), which is outside this test-only card. The same
// unreachable shape is the uncovered branch in `fontSets.ts` (`resolveFontSet`)
// and `theme-context.tsx` (`pageFontSetLocale`). Other remaining gaps, all
// unreachable from a DOM test: the `typeof window === 'undefined'` SSR guards and
// the server snapshot in `theme-context.tsx`, an empty-patch flush (the provider
// only flushes after queueing an axis), and the registry-data guard in
// `fontPickOptions` (`m.family && cssVar` — every face has both).
//
// ⚠️ THE PACKAGE FILES ARE MEASURED THROUGH `dist/`'s SOURCE MAPS. motir-core
// resolves `@motir/design-system` to the BUILT package (`exports` → `dist/`), so
// no test here loads `src/`. v8 records `dist/**/*.js`, and the provider remaps
// it through the `.js.map` files tsup emits back onto `src/`. That only happens
// for a dist file that passes `include` BEFORE the remap, so each of the three
// `dist/` files is listed as well: it is the filter that admits the bytes, and
// the report and the thresholds name the `src/` file they map to. Two
// consequences: (1) the reading is only true of a FRESH build — run
// `pnpm --filter @motir/design-system build` after changing the package's `src/`;
// (2) because tsup bundles each entry with `splitting: false`, `init-script.js`
// carries copies of `palettes.ts`, `styles.ts`, `types.ts` and `typography.ts`,
// which therefore appear in the report with no threshold — they are not this
// story's files. (This contradicts the older note in `vitest.config.ts` that a
// `packages/design-system/src/**` file "reports 0%" from the root lane: it does,
// unless its `dist/` file is admitted too.)
//
// ⚠️ DELIBERATELY NOT LISTED:
//   - `app/layout.tsx`, `app/global-error.tsx` — server and error components with
//     no unit harness; what they contribute is asserted through
//     `fontSetHtmlAttrs` and the init script's server / cached / clear modes.
//   - `lib/services/accountErasureSweepService.ts`, `lib/export/personalDataSections.ts`
//     — large or declarative files this story changed by a few lines; a per-file
//     floor over them would be a number about other stories. The behaviour (the
//     export carries the picks, an erasure removes them) is asserted in the
//     integration gate.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE: the two gate
// files plus each predecessor's own tests. AND IT DOES NOT OVERRIDE `resolve` —
// spread the base and change only what this lane is about.
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 };

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/integration/font-picks-story-gate.test.ts',
      'tests/components/font-picks-story-gate.test.tsx',
      'tests/appearance/fontPicks.test.ts',
      'tests/appearance/repository.test.ts',
      'tests/appearance/route.test.ts',
      'tests/appearance/service.test.ts',
      'tests/components/appearance-sync.test.tsx',
      'tests/components/language-font-picker.test.tsx',
      'tests/components/appearance-card.test.tsx',
      'tests/export/appearanceFontPicks.test.ts',
      'tests/account-erasure-sweep.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      all: false,
      include: [
        'lib/appearance/fontPicks.ts',
        'lib/mappers/appearancePreferenceMappers.ts',
        'lib/services/appearancePreferenceService.ts',
        'lib/repositories/userAppearancePreferenceRepository.ts',
        'app/api/appearance-preference/route.ts',
        // A route group is `app/**/…` — `(` is glob syntax (MOTIR-2449).
        'app/**/_components/LanguageFontPicker.tsx',
        'packages/design-system/src/theme/fontSets.ts',
        'packages/design-system/src/theme/init-script.ts',
        'packages/design-system/src/contexts/theme-context.tsx',
        // The pre-remap filters for the three files above (see the header).
        'packages/design-system/dist/theme/fontSets.js',
        'packages/design-system/dist/theme/init-script.js',
        'packages/design-system/dist/contexts/theme-context.js',
      ],
      thresholds: {
        perFile: true,
        'lib/appearance/fontPicks.ts': { ...FLOOR, branches: 87.5 },
        'lib/mappers/appearancePreferenceMappers.ts': FLOOR,
        'lib/services/appearancePreferenceService.ts': FLOOR,
        'lib/repositories/userAppearancePreferenceRepository.ts': FLOOR,
        'app/api/appearance-preference/route.ts': FLOOR,
        'app/**/_components/LanguageFontPicker.tsx': FLOOR,
        'packages/design-system/src/theme/fontSets.ts': FLOOR,
        'packages/design-system/src/theme/init-script.ts': FLOOR,
        'packages/design-system/src/contexts/theme-context.tsx': FLOOR,
      },
    },
  },
});
