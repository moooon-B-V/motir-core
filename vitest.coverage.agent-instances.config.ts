import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE AGENT-INSTANCES STORY'S COVERAGE FLOOR (Story MOTIR-6860 · MOTIR-6876) —
// every motir-core app file the story added, held to the per-file floor of 90%
// statements, functions, branches and lines, measured over the story's own tests
// (the record, the lifecycle, the sweep and charge, the page, the story gate).
// Mirrors `vitest.coverage.hosted-agent-run.config.ts`.
//
// The persistent-machine adapters live in `packages/orchestrator` and are held by
// that package's own suite (`test/flyPersistent.test.ts`, `test/fakePersistent.test.ts`).
//
// EXTENDED BY THE AGENT-TERMINAL STORY GATE (Story MOTIR-6861 · MOTIR-6942): the
// terminal's motir-core half — the ticket, the relay and its Motir side, the one
// activity door, the connection record, and the panel beside the list — held to the
// same per-file floor, over the terminal's own suites (`tests/agentTerminal/**`,
// whose story gate drives the REAL `motir agent-terminal serve` process, and the
// panel's `AgentPanel.test.tsx`). One story extends the other's lane rather than
// opening a second: the terminal is an instance's terminal, the files interleave
// (`lib/agentInstances/terminal*.ts`, the ticket route under the instance routes),
// and the two suites share one harness.
//
// EXTENDED BY THE AGENT-BILLING STORY GATE (Story MOTIR-6914 · MOTIR-6922): the
// daily storage charge, the plan lapse and its notice, and the Agents line's
// figures, under the same per-file floor, over their suites in
// `tests/agentInstances/**` (the story gate is `agentBillingStoryGate.test.ts`)
// and `agentFigures.test.ts`. `BillingClient.tsx` is the whole billing panel, not
// this story's file, and stays with the billing suites.
//
// Held elsewhere, deliberately:
//   * the in-agent terminal server (`packages/cli/src/agentTerminal/**`) is held by
//     `packages/cli/vitest.config.ts`'s per-file thresholds (MOTIR-6938);
//   * `scripts/relay.ts` is the relay's process entrypoint (monitoring init, listen,
//     drain on SIGTERM) — it is bundled and run, not imported, like
//     `scripts/worker.ts`; everything it wires is measured here.

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

const MEASURED = [
  'lib/agentInstances/**/*.ts',
  'lib/repositories/agentInstanceRepository.ts',
  'lib/repositories/agentInstanceIntervalRepository.ts',
  'lib/mappers/agentInstanceMappers.ts',
  'lib/services/agentInstanceLifecycleService.ts',
  'lib/services/agentInstanceSweepService.ts',
  'lib/services/agentInstanceChargeService.ts',
  'lib/jobs/definitions/agentInstanceIdleCheck.ts',
  'lib/jobs/definitions/agentInstanceSweep.ts',
  'app/api/projects/[[]key]/instances/**/*.ts',
  'app/(authed)/my-agents/**/*.tsx',
  // Story MOTIR-6861 — the agent terminal (MOTIR-6942).
  'app/(authed)/my-agents/**/*.ts',
  'lib/agentTerminal/**/*.ts',
  'lib/services/agentTerminalService.ts',
  'lib/services/agentTerminalRelayService.ts',
  'lib/services/agentInstanceActivityService.ts',
  'lib/repositories/agentTerminalTicketRepository.ts',
  'lib/repositories/agentTerminalConnectionRepository.ts',
  'lib/mappers/agentTerminalMappers.ts',
  // Story MOTIR-6914 — agents are an AI-plan feature, their storage paid in
  // credits (MOTIR-6922): the daily storage charge, the plan lapse and its
  // notice, and the Agents line's figures. The plan check, the per-org cap and
  // the page's words land in files already measured above.
  'lib/services/agentInstanceStorageChargeService.ts',
  'lib/repositories/agentInstanceStorageChargeRepository.ts',
  'lib/jobs/definitions/agentInstanceStorageCharge.ts',
  'lib/services/agentInstanceLapseService.ts',
  'lib/emailTemplates/agentsDeletionScheduled.tsx',
  'app/(authed)/settings/organization/billing/_components/agentFigures.ts',
  // Story MOTIR-6864 — a run in my agent (MOTIR-7026).
  'lib/services/agentInstanceRunService.ts',
  'lib/mappers/agentInstanceRunMappers.ts',
  'lib/jobs/definitions/agentInstanceRunLaunch.ts',
  // MOTIR-7027 — the run's supervision; the lifecycle couplings live in files above.
  'lib/jobs/definitions/agentInstanceRunSupervise.ts',
  'app/api/work-items/[[]id]/agent-runs/**/*.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/agentInstances/**/*.test.ts',
      'tests/components/MyAgentsRoom.test.tsx',
      'tests/agentTerminal/**/*.test.ts',
      'tests/components/AgentPanel.test.tsx',
      // Story MOTIR-6914 (MOTIR-6922).
      'tests/components/agentFigures.test.ts',
      // Story MOTIR-6864 — the agent's live run in its panel (MOTIR-7029).
      'tests/components/AgentPanelRun.test.tsx',
      // The image update (Story MOTIR-6862 · MOTIR-6954).
      'tests/components/MyAgentsUpdate.test.tsx',
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
