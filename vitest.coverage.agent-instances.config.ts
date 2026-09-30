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
// Held elsewhere, deliberately:
//   * the in-agent terminal server (`packages/cli/src/agentTerminal/**`) is held by
//     `packages/cli/vitest.config.ts`'s per-file thresholds (MOTIR-6938);
//   * `scripts/relay.ts` is the relay's process entrypoint (monitoring init, listen,
//     drain on SIGTERM) — it is bundled and run, not imported, like
//     `scripts/worker.ts`; everything it wires is measured here.
//
// EXTENDED BY THE AGENT-CHAT STORY GATE (Story MOTIR-6863 · MOTIR-7018): the
// chat's motir-core half — the browser's protocol mirror (`lib/agentChat/**`),
// `CHAT_PROFILES` (already under `lib/agentInstances/**`), the relay's chat
// channel and the ticket's channel (already under `lib/agentTerminal/**` and the
// services above), and the Chat tab (already under `app/(authed)/my-agents/**`) —
// held to the same per-file floor, over the chat's own suites (`tests/agentChat/**`,
// whose story gate drives the relay into the REAL in-process chat server, and the
// tab's `AgentChat.test.tsx`). The in-agent chat server and its five adapters
// (`packages/cli/src/agentTerminal/chat/**`) are held, like the terminal server,
// by `packages/cli/vitest.config.ts`'s per-file thresholds.

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
  // Story MOTIR-6863 — the agent chat (MOTIR-7018).
  'lib/agentChat/**/*.ts',
  // The Chat tab. Its parentheses are ESCAPED (`[(]` / `[)]`): the coverage
  // include is a glob, where `(authed)` is a pattern group matching the bare
  // segment `authed` — so the two `app/(authed)/my-agents/**` entries above
  // match no file at all, and the panel they name has never been measured.
  // Measured on this branch, they would hold the terminal story's own files
  // below the floor, so widening them is left to that story; the chat's files
  // are measured here, at the floor.
  'app/[(]authed[)]/my-agents/_components/AgentChat.tsx',
  'app/[(]authed[)]/my-agents/_components/useAgentChat.ts',
  'app/[(]authed[)]/my-agents/_components/chat/**/*.{ts,tsx}',
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
      // Story MOTIR-6863 — the agent chat (MOTIR-7018).
      'tests/agentChat/**/*.test.{ts,tsx}',
      'tests/components/AgentChat.test.tsx',
      // Story MOTIR-6864 — the agent's live run in its panel (MOTIR-7029).
      'tests/components/AgentPanelRun.test.tsx',
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
