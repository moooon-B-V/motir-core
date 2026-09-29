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
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['tests/agentInstances/**/*.test.ts', 'tests/components/MyAgentsRoom.test.tsx'],
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
