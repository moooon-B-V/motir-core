import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for GUIDE ME THROUGH OFFERS A RE-PLAN — Story MOTIR-8684's `motir-core`
// integration gate, MOTIR-8695 (decision MOTIR-8685, the amendment to A3.9 (b) of
// `docs/decisions/guide-turn-files.md`): the stored offer's derived state, the Decline
// door, the guide-offer seed read, the overlay's start from an offer, and the rail's
// offer and the overlay's guide-origin card.
//
// ⚠️ MEASURED: the files the story ADDED in core (re-listed with
// `git log --diff-filter=A --name-only` over the story's commits, MOTIR-8687 …
// MOTIR-8694), held at the story's GATE — at least 90 on statements, branches,
// functions and lines, PER FILE. The shared files the story extended by a branch
// each are NOT measured, because a per-file number over them would measure their
// pre-existing code, which this lane does not run:
//   lib/ai/guideWorkItem.ts                     (`needs_replan` widened, the stored
//                                                `replanOffer`, `readGuideTurnRecord`)
//   lib/services/aiGuideService.ts              (`card.ancestors`, the door's `planning`)
//   lib/services/guideLandingService.ts         (`resolveReplanTarget`, the offer landing,
//                                                `declineReplanOffer`)
//   lib/services/planChangeSessionsService.ts   (`declineGuideReplanOffer`,
//                                                `startGuideSeededWithFirstTurn`,
//                                                `findGuideSeededSession`)
//   lib/services/contextualPlanningService.ts   (the `seedGuideTurnId` branch)
//   lib/services/planningSeedService.ts         (`getGuidePlanningSeed`)
//   lib/repositories/planChangeSessionRepository.ts, planChangeTurnRepository.ts
//   lib/planChange/errors.ts, app/api/ai/plan-change/_errors.ts (the offer errors)
//   app/api/work-items/[id]/ai/plan/route.ts    (`seedGuideTurnId` on the body)
//   lib/mappers/planSessionMappers.ts, lib/dto/planSessions.ts (the `guide` seed origin)
//   lib/dto/planChange.ts, lib/dto/planningSeed.ts
//   lib/planning/planningSeedClient.ts, lib/planning/planChangeClient.ts,
//   lib/planning/launcher.ts, lib/planning/guideClient.ts, lib/planning/guideView.ts
//   lib/hooks/usePlanChangeConversation.ts, lib/hooks/useGuideConversation.ts
//   components/planning/{PlanChangeRail,PlanningWorkspaceHost,PlanningWorkspaceOverlay,
//                        GuideRail,GuideTodoCanvas,GuideWorkspaceHost}.tsx
//   app/(authed)/plans/_components/SessionRow.tsx
// The story's lines in them are exercised by the suites in `include` below — the gate,
// which drives the doors end to end, and each predecessor's own suites — which is the
// `mid-run-turns` precedent.
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET: never below the 90 gate, and moved up — never down —
// when a file’s reading rises. CI: the `story-8684-coverage` job, which needs
// Postgres.

const MEASURED = [
  'lib/planning/guideReplanOffer.ts',
  'lib/planning/guideSeed.ts',
  'lib/planning/guideOfferLaunch.ts',
  'app/api/ai/guide/offer/decline/route.ts',
  // ⚠️ A dynamic segment is matched with `**`, never the literal `[turnId]` — a glob
  // character class to the coverage matcher (MOTIR-2449).
  'app/api/ai/guide/offer/**/planning-seed/route.ts',
  'components/planning/GuideReplanOffer.tsx',
  'components/planning/GuideOriginCard.tsx',
  'components/planning/useGuideOfferSeed.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The gate: the core half of the story through its HTTP doors.
      'tests/integration/planning/guideReplanOfferStoryGate.test.ts',
      // The predecessors' own suites.
      'tests/ai/guideWorkItem.test.ts', // the contract (MOTIR-8687)
      'tests/ai/guideLandingService.test.ts', // the landing (MOTIR-8689)
      'tests/planning/guideReplanOffer.test.ts',
      'tests/integration/planning/guideOfferSeedStamp.test.ts', // the session memory (MOTIR-8691)
      'tests/planning/guideSeed.test.ts', // the seed read (MOTIR-8692)
      'tests/api/guide-offer-planning-seed-route.test.ts',
      'tests/integration/planning/guideOfferSeedRead.test.ts',
      'tests/planning/planningSeedClient.test.ts',
      'tests/components/planning-guide-seed.test.tsx', // the overlay start (MOTIR-8693)
      'tests/planning/launcher.test.ts',
      'tests/planning/planChangeClient.test.ts',
      'tests/components/guide-replan-offer.test.tsx', // the rail (MOTIR-8694)
      'tests/components/guide-host-network.test.tsx',
      'tests/planning/guideView.test.ts',
      'tests/mappers/planSessionMappers.test.ts', // the Plans row (MOTIR-8697)
      'tests/components/SessionRow.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // MEASURED 2026-10-15 at MOTIR-8695 over this lane's suites, rounded DOWN, and
      // never below the gate. Uncovered on purpose, each a guard no request can reach
      // through a door (the door decides first):
      //   * `…/offer/decline/route.ts`: the closing `throw err` for an error the
      //     plan-change mapper does not know (every service refusal is typed);
      //   * `lib/planning/guideReplanOffer.ts`: `replanOfferOf` on a turn id the
      //     thread does not hold — every caller looks the turn up first.
      //
      // The four client files that were BELOW THE GATE at MOTIR-8695 gained their
      // cases in the client suites and were re-measured (stmts / branches / funcs /
      // lines): `GuideOriginCard.tsx` 100 / 100 / 100 / 100, `GuideReplanOffer.tsx`
      // 100 / 93.93 / 100 / 100, `useGuideOfferSeed.ts` 96.66 / 92.59 / 100 / 100,
      // `guideOfferLaunch.ts` 100 / 100 / 100 / 100.
      thresholds: {
        'app/api/ai/guide/offer/**/planning-seed/route.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/api/ai/guide/offer/decline/route.ts': {
          statements: 95,
          branches: 92,
          functions: 100,
          lines: 94,
        },
        'lib/planning/guideReplanOffer.ts': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        'lib/planning/guideSeed.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/planning/guideOfferLaunch.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'components/planning/GuideOriginCard.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'components/planning/GuideReplanOffer.tsx': {
          statements: 100,
          branches: 93,
          functions: 100,
          lines: 100,
        },
        'components/planning/useGuideOfferSeed.ts': {
          statements: 96,
          branches: 92,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
