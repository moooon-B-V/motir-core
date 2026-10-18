import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for AUTO-TRANSLATE A PROJECT — Story MOTIR-7738's `motir-core` integration
// gate, MOTIR-8835: the project switch and its trail, the reader's translation
// context and credit verdict, the many-titles door and its route, and the
// render-site registry.
//
// ⚠️ MEASURED: the SERVER-side files the story ADDED in core (re-listed with
// `git log --diff-filter=A --name-only` over the story's commits), held at the
// story's GATE — at least 90 on statements, branches, functions and lines, PER FILE.
// NOT measured, on purpose:
//   * the CLIENT files (`components/workItems/titleTranslation/*`, the settings
//     room, the item page's `OriginalLanguageNote` / `RelatedTitles`): their suites
//     are component tests under happy-dom, run by the main suite, and the story's
//     E2E (MOTIR-8836) drives them end to end. This lane needs no package build.
//   * the shared files the story extended by a branch each
//     (`lib/services/workItemTranslationService.ts`'s `translateTitlesForReader`,
//     `lib/repositories/projectRepository.ts`, the project DTO and mapper): a
//     per-file number over them would measure their pre-existing code, which this
//     lane does not run. The story's lines in them are exercised by the suites in
//     `include` below.
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET: never below the 90 gate, and moved up — never down —
// when a file's reading rises. CI: the `story-7738-coverage` job, which needs
// Postgres.

const MEASURED = [
  'app/api/projects/**/auto-translate/route.ts',
  'app/api/projects/**/translate-titles/route.ts',
  'lib/services/projectAutoTranslateSettingsService.ts',
  'lib/mappers/projectAutoTranslateSettingsMappers.ts',
  'lib/repositories/projectSettingChangeRepository.ts',
  'lib/services/readerTranslationContextService.ts',
  'lib/pages/surfaceTranslation.ts',
  'lib/translation/titleVerdicts.ts',
  'lib/translation/titleBound.ts',
  'lib/translation/renderSites.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The gate: the story through its HTTP doors, real database, motir-ai on the wire.
      'tests/integration/translation/autoTranslateStory.test.ts',
      'tests/integration/translation/autoTranslateStoryCharges.test.ts',
      // The predecessors' own suites.
      'tests/projects/autoTranslateSwitchSchema.test.ts', // the column and the trail (MOTIR-8825)
      'tests/settings/project-auto-translate-settings.test.ts', // the settings service (MOTIR-8826)
      'tests/api-project-auto-translate-route.test.ts', // the settings route (MOTIR-8826)
      'tests/export/autoTranslateChanges.test.ts',
      'tests/translation/readerTranslationContext.test.ts', // the context (MOTIR-8828)
      'tests/integration/translation/titleTranslationDoor.test.ts', // the many-titles door (MOTIR-8829)
      'tests/translation/titleDoorUnit.test.ts',
      'tests/translation/titleTranslationRoute.test.ts', // the batch route (MOTIR-8831)
      'tests/unit/translation/titleVerdicts.test.ts',
      'tests/translation/workContentRenderSites.test.ts', // the registry guard (MOTIR-8834)
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // MEASURED 2026-10-17 at MOTIR-8835 over this lane's suites, rounded DOWN, and
      // never below the gate. Every file reads 100 on all four except
      // `readerTranslationContextService.ts` (96.77 / 100 / 90 / 96.29): its uncovered
      // line is the default entitlement closure, which the suites replace with a
      // fake client or reach only through the billing path the charges file drives.
      thresholds: {
        'app/api/projects/**/auto-translate/route.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/api/projects/**/translate-titles/route.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/projectAutoTranslateSettingsService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/mappers/projectAutoTranslateSettingsMappers.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/repositories/projectSettingChangeRepository.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/pages/surfaceTranslation.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/translation/titleVerdicts.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/translation/titleBound.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/translation/renderSites.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/readerTranslationContextService.ts': {
          statements: 96,
          branches: 100,
          functions: 90,
          lines: 96,
        },
      },
    },
  },
});
