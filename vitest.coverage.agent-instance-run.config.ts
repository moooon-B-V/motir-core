import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE RUN-IN-MY-AGENT STORY'S COVERAGE FLOOR (Story MOTIR-6864 · MOTIR-7030) —
// every motir-core app file the story's children changed (MOTIR-7023 … MOTIR-7029),
// NAMED below in one of two lists, and every file in the first held to the
// per-file floor of 90% statements, functions, branches and lines. Measured over
// the story gate (`tests/agentInstances/agentInstanceRunStoryGate.test.ts`: the
// start → run record → run credential → git credential seam against Postgres and
// the fake persistent fleet) plus the per-card suites. Mirrors
// `vitest.coverage.agent-instances.config.ts` and
// `vitest.coverage.hosted-agent-run.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// ⚠️ THE GLOBS NEVER SPELL A ROUTE GROUP OR A DYNAMIC SEGMENT. `(authed)` is an
// extglob group to the coverage matcher, which matches `authed` WITHOUT the
// parentheses — so `app/(authed)/…` silently measures nothing — and `[key]` is a
// character class (MOTIR-2449). A single path segment is `*` here instead.
//
// Held elsewhere, deliberately:
//   * the CLI half of the story (`packages/cli/src/**` — agent mode, the profiles'
//     unattended commands, the terminal server's launcher) is held by
//     `packages/cli/vitest.config.ts`'s own per-file thresholds, run by the `cli`
//     job's `test:coverage`;
//   * the orchestrator's fake / Fly persistent adapters by `packages/orchestrator`'s
//     own suite;
//   * `design/**`, `docs/**`, `messages/*.json`, `prisma/**` carry no code to measure.

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/** Every file below is held to {@link FLOOR}, whole-file. */
const MEASURED = [
  // MOTIR-7023 — the run record knows its agent.
  'lib/dto/dispatchRuns.ts',
  'lib/dto/workItemContinue.ts',
  'lib/runs/runLiveness.ts',
  'lib/api/v1/contractVersion.ts',
  // MOTIR-7026 — the start service, its routes and its launch job.
  'lib/services/agentInstanceRunService.ts',
  'lib/mappers/agentInstanceRunMappers.ts',
  'lib/dto/agentInstanceRuns.ts',
  'lib/agentInstances/errors.ts',
  'lib/agentInstances/errorResponse.ts',
  'lib/agentInstances/profiles.ts',
  'lib/agentInstances/terminal.ts',
  'lib/jobs/definitions/agentInstanceRunLaunch.ts',
  'lib/jobs/registry.ts',
  'lib/jobs/services.ts',
  'lib/jobs/types.ts',
  'app/api/work-items/*/agent-runs/route.ts',
  'app/api/work-items/*/agent-runs/agents/route.ts',
  // MOTIR-7027 — the lifecycle couplings, the supervision and every close.
  'lib/agentInstances/runEnd.ts',
  'lib/jobs/definitions/agentInstanceRunSupervise.ts',
  'lib/services/agentInstanceLifecycleService.ts',
  'lib/services/agentInstanceSweepService.ts',
  'lib/services/agentInstanceActivityService.ts',
  'lib/repositories/agentInstanceRepository.ts',
  'lib/mappers/agentInstanceMappers.ts',
  'lib/dto/agentInstances.ts',
  'app/api/dispatch-runs/*/cancel/route.ts',
  // MOTIR-7028 — Run in my agent on the card, the Run section and the run modal.
  'app/*/items/*/_components/StartBar.tsx',
  'app/*/items/*/_components/SendToAgentDoor.tsx',
  'app/*/items/*/_components/useAgentSend.ts',
  'app/*/items/*/_components/RunHostedButton.tsx',
  'app/*/items/*/_components/HostedRunProvider.tsx',
  'app/*/runs/_components/AgentRunParts.tsx',
  'app/*/runs/_components/RunLogPane.tsx',
  'components/github/ContinuePart.tsx',
  // MOTIR-7029 — My agents shows the live run.
  'app/*/my-agents/_components/AgentRunLine.tsx',
  'app/*/my-agents/_components/useRunSessionWatch.ts',
  'app/*/my-agents/_components/AgentPanel.tsx',
  'app/*/my-agents/_components/MyAgentsRoom.tsx',
  'app/*/my-agents/_components/agentRefusal.tsx',
];

/**
 * SHARED files the story also changed, NAMED and deliberately NOT floored here —
 * the hosted-run lane's precedent for `dispatchRunMappers.ts` and friends. Each is
 * a large, older file where the story's change is a handful of lines (an `origin`
 * arm made total over `instance`, a prop threaded through, a refusal's words), and
 * whose uncovered remainder is OTHER stories' code measured by their own suites in
 * the main `test` job. A whole-file floor here would measure those stories, not
 * this one. The story's own lines in them were read off this lane's merged report
 * when it landed (MOTIR-7030); where one is not reached here, its owner's suite
 * reaches it.
 */
export const SHARED_NOT_FLOORED = [
  // Server components — rendered by Next, reached by the E2E (MOTIR-7031), not by Vitest.
  'app/*/items/*/_view.tsx',
  'app/*/runs/_view.tsx',
  'app/*/items/*/_components/LateSections.tsx',
  // The run surfaces the hosted-run and continue stories own; the story threads
  // `viewerId` and the agent's parts through them.
  'app/*/items/*/_components/RunSection.tsx',
  'app/*/items/*/_components/HostedDoorNotices.tsx',
  'app/*/runs/_components/RunModal.tsx',
  'app/*/runs/_components/RunsIndex.tsx',
  'app/*/runs/_components/HostedRunParts.tsx',
  'app/*/runs/_components/HostedRunCancel.tsx',
  // The agent terminal story's (MOTIR-6861) — the story adds the run session's tab.
  'app/*/my-agents/_components/AgentTerminal.tsx',
  'app/*/my-agents/_components/useAgentTerminal.ts',
  'app/*/my-agents/_components/AgentPanelHeader.tsx',
  // The dispatch-run record (Story MOTIR-1789) and its every origin switch.
  'lib/services/dispatchRunService.ts',
  'lib/services/dispatchRunSweepService.ts',
  'lib/repositories/dispatchRunRepository.ts',
  'lib/repositories/dispatchRunEventRepository.ts',
  'lib/mappers/dispatchRunMappers.ts',
  'lib/dispatchRuns/errors.ts',
  'lib/api/v1/workLoop/schema.ts',
  // Hosted runs, continue, repair and the design re-run — one `origin` arm each.
  'lib/services/hostedRunService.ts',
  'lib/services/hostedRunChargeService.ts',
  'lib/services/workItemContinueService.ts',
  'lib/services/workItemRepairService.ts',
  'lib/services/designAutoRerunService.ts',
  'lib/mappers/repairRunMappers.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate, and the per-card suites of MOTIR-7023 · 7026 · 7027 beside
      // the agents story's own (the lifecycle, sweep and routes the couplings changed).
      'tests/agentInstances/**/*.test.ts',
      'tests/agentTerminal/**/*.test.ts',
      'tests/api/v1/dispatch-runs-route.test.ts',
      'tests/dispatchRunRepository.test.ts',
      'tests/dispatchRunSchemaBoundaries.test.ts',
      'tests/ready/continueViewReasons.test.ts',
      'tests/hostedRuns/hostedRunEnd.test.ts',
      // MOTIR-7028 — the card's control, the Run section and the run modal.
      'tests/components/SendToAgentDoor.test.tsx',
      'tests/components/AgentRunSurfaces.test.tsx',
      'tests/components/HostedRunSurfaces.test.tsx',
      'tests/components/RunHostedDoor.test.tsx',
      'tests/components/RunSection.test.tsx',
      'tests/components/RunModal.test.tsx',
      'tests/components/RunLogPane.test.tsx',
      'tests/components/RunCanvasPane.test.tsx',
      'tests/components/RunsIndex.test.tsx',
      'tests/components/ContinueHostedDoor.test.tsx',
      'tests/components/continue-hosted-control.test.tsx',
      'tests/components/continue-part.test.tsx',
      'tests/components/fix-hosted-door.test.tsx',
      // MOTIR-7029 — the panel, the room, and the run session's watch.
      'tests/components/AgentPanel.test.tsx',
      'tests/components/AgentPanelRun.test.tsx',
      'tests/components/MyAgentsRoom.test.tsx',
      'tests/components/useRunSessionWatch.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      all: true,
      include: MEASURED,
      thresholds: {
        perFile: true,
        ...FLOOR,
      },
    },
  },
});
