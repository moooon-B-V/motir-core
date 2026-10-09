import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for PLAN APPROVAL ONLY IN THE OVERLAY — Story MOTIR-7883's integration
// gate, MOTIR-7892: every door to an undecided plan lands on the planning overlay
// over that plan's own conversation, and `/plans/<id>` redirects a member there.
//
// ⚠️ WHAT A FLOOR IS FOR HERE. Whether the assembled seams are right is
// `tests/integration/planning/planOverlayOnlyGate.test.tsx`'s question (the door's
// read through the real `GET /api/plans/<id>`, the redirect over real rows, ended
// sessions, and the two agreeing), and the one-author rule is
// `tests/planning/plan-overlay-address-one-author.test.ts`'s. What a floor catches
// is what those cannot: a LATER change that deletes a branch's only test and
// leaves the branch.
//
// ⚠️ GATED: the two files the story CREATED, PER FILE, at the MEASURED reading over
// this lane's suites, rounded DOWN, never below 90. A RATCHET. CI: the
// `story-7883-coverage` job, which needs Postgres (the gate reads real rows).
//
// ⚠️ REPORTED, NOT GATED: the shared files the story CHANGED (the
// `vitest.coverage.pages.config.ts` precedent). A whole-file floor on them would
// measure other stories' lines. The story's OWN lines in each, and whether this
// lane covers them — measured 2026-10-09 on this branch with
// `pnpm coverage:plan-overlay-only`:
//
//   lib/planning/planDestination.ts — `planSessionLaunchContext` (:105–111, exported
//     for the doors), the `'no-session'` arm and its call (:149, :152), and the renamed
//     call in `sessionHoldDestination` (:182): COVERED, every line and arm. (:182 is
//     reached by `status-held-notice.test.tsx`, included for that line alone.)
//   app/(authed)/plans/[id]/_view.tsx — the redirect block (:55–89): COVERED, every
//     arm — undecided redirects (open and ended sessions), decided / session-less /
//     Visitor fall through. The file's uncovered lines (:51–52, the access-denied
//     404; :214–222, the establish step's catch handlers) are not the story's.
//   app/(authed)/plans/_components/SessionRow.tsx — the Closed row's undecided latest
//     plan through the destination rule (:335–366, :435–443, :456): COVERED, but for
//     ONE arm of the host ternary on :352 (`qs ? `?${qs}` : ''`).
//   components/planning/GenerationFlow.tsx — the onboarding hand-off through
//     `useOpenPlanOverlay(…, { host })` (:140, :208–226): COVERED, but for the `null`
//     arm of `planId ? <PlannedHandOff/> : null` on :140 (a `planned` phase without a
//     plan id, which the generation hook does not produce).
//   app/(authed)/items/[key]/_components/PendingPlanNotice.tsx (:172–201),
//     app/(authed)/runs/_components/RunFindings.tsx (:120–164) and
//     app/(authed)/settings/project/ai-planning/_components/AiPlanningSettingsEditor.tsx
//     (:869–879) — each door: COVERED. Their uncovered lines are the surfaces' own.
//   components/approvals/usePlanGateForward.ts — the null-session throw (:54) and the
//     shared launch context (:59–63): COVERED. NOT covered: the Visitor arm of the
//     narrowed condition on :46 (`router.replace(planPage)`, :47–48) — this lane runs
//     no Visitor approval overlay.
//
// ⚠️ ROUTE GROUPS AND DYNAMIC SEGMENTS ARE MATCHED WITH `*` / `**`, NEVER THE
// LITERAL `(authed)` or `[id]` (MOTIR-2449: both are glob syntax to the matcher).

const CREATED = ['lib/hooks/useOpenPlanOverlay.ts', 'components/planning/PlanOverlayDoor.tsx'];

const SHARED = [
  'lib/planning/planDestination.ts',
  'app/*/plans/*/_view.tsx',
  'app/*/plans/_components/SessionRow.tsx',
  'components/planning/GenerationFlow.tsx',
  'app/*/items/*/_components/PendingPlanNotice.tsx',
  'app/*/runs/_components/RunFindings.tsx',
  'app/*/settings/project/ai-planning/_components/AiPlanningSettingsEditor.tsx',
  'components/approvals/usePlanGateForward.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate and the guard (MOTIR-7892).
      'tests/integration/planning/planOverlayOnlyGate.test.tsx',
      'tests/planning/plan-overlay-address-one-author.test.ts',
      // Each code card's own suite (MOTIR-7884 · 7885 · 7886 · 7888 · 7890).
      'tests/planning/planDestination.test.ts',
      'tests/components/plan-overlay-door.test.tsx',
      'tests/components/plan-page-overlay-redirect.test.tsx',
      'tests/components/plan-row-destination-agreement.test.tsx',
      'tests/components/pending-plan-notice.test.tsx',
      'tests/components/SessionRow.test.tsx',
      'tests/components/RunFindings.test.tsx',
      'tests/components/GenerationFlow.test.tsx',
      'tests/components/ai-planning-settings-editor.test.tsx',
      'tests/components/approval-overlay-plan-arm.test.tsx',
      // Reaches `sessionHoldDestination`, whose one call the story renamed (:182).
      'tests/components/status-held-notice.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [...CREATED, ...SHARED],
      // PER FILE, MEASURED 2026-10-09 at MOTIR-7892 over this lane's suites, rounded DOWN.
      thresholds: {
        'lib/hooks/useOpenPlanOverlay.ts': {
          statements: 96,
          branches: 91,
          functions: 100,
          lines: 97,
        },
        'components/planning/PlanOverlayDoor.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
