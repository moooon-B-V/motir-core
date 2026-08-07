import { defineConfig } from 'vitest/config';

// The `@motir/cli` package suite + its COVERAGE GATE (Subtask 7.9.5 · MOTIR-883;
// `motir batch` brought under it by 7.9.5b · MOTIR-1829).
//
// These tests run with no Postgres and no Next app, so they stay in the package
// rather than joining the root vitest lane (which globs only `tests/**`). CI runs
// them as their own job — the same shape `@motir/design-system` uses — while the
// story-closing suite that spawns the BUILT binary against the real `/api/mcp`
// route lives in the root lane at `tests/cli/`.
//
// ── The gate ────────────────────────────────────────────────────────────────
// Per-FILE thresholds, keyed by glob, exactly like the root config: a blended
// average would let a weak module hide behind a strong one. Every file the CLI's
// behaviour depends on is held at ≥90% branches / functions / lines, with two
// documented carve-outs and three ungated files (below).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Measure the WHOLE source tree — an ungated file still appears in the
      // report, so a regression in one is visible even where it is not fatal.
      include: ['src/**/*.ts'],
      // …EXCEPT the generated v1 client (Subtask 11.5.2). It is machine-written
      // from the server's own schemas and kept correct by the freshness guard +
      // the round-trip assertions in `test/api-validators.test.ts`, not by line
      // coverage over generated branches nobody wrote.
      exclude: ['src/api/**'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        // The client core, the command modules, and the pure decision layers.
        'src/agentProfiles.ts': { branches: 90, functions: 90, lines: 90 },
        'src/agentRun.ts': { branches: 90, functions: 90, lines: 90 },
        'src/autoLoop.ts': { branches: 90, functions: 90, lines: 90 },
        'src/batchPlan.ts': { branches: 90, functions: 90, lines: 90 },
        'src/browser.ts': { branches: 90, functions: 90, lines: 90 },
        'src/deviceAuth.ts': { branches: 90, functions: 90, lines: 90 },
        'src/dispatch.ts': { branches: 90, functions: 90, lines: 90 },
        'src/doctor.ts': { branches: 90, functions: 90, lines: 90 },
        'src/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'src/git.ts': { branches: 90, functions: 90, lines: 90 },
        'src/output.ts': { branches: 90, functions: 90, lines: 90 },
        'src/plan.ts': { branches: 90, functions: 90, lines: 90 },
        'src/projectLink.ts': { branches: 90, functions: 90, lines: 90 },
        'src/render.ts': { branches: 90, functions: 90, lines: 90 },
        'src/serverResolve.ts': { branches: 90, functions: 90, lines: 90 },
        'src/session.ts': { branches: 90, functions: 90, lines: 90 },
        'src/transport.ts': { branches: 90, functions: 90, lines: 90 },
        'src/sessionExcludes.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/auth.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/auto.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/batch.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/dispatch.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/doctor.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/link.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/login.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/plan.ts': { branches: 90, functions: 90, lines: 90 },
        'src/commands/read.ts': { branches: 90, functions: 90, lines: 90 },
        'src/config/linkConfig.ts': { branches: 90, functions: 90, lines: 90 },
        'src/config/userConfig.ts': { branches: 90, functions: 90, lines: 90 },
        // The `/api/v1` adapter boundary (Subtask 11.5.4) — wire shapes in, the
        // CLI's view models out. Fully gated: it is pure mapping, so every
        // branch in it is a real shape decision and none is unreachable.
        'src/adapters/reads.ts': { branches: 90, functions: 90, lines: 90 },

        // These two gate on FUNCTIONS + LINES only (both are at 100% / ~98%):
        // each carries DEFENSIVE branches that are unreachable under shipped
        // invariants, so a 90% BRANCH bar would fail on un-coverable code — the
        // same carve-out the root `vitest.config.ts` makes for `whoami` and
        // friends.
        //   • mcpClient: the `content ?? []` arm (a tool result always carries a
        //     content block) and the two `err instanceof Error ? … : String(err)`
        //     fallbacks (the SDK only ever throws Errors).
        //   • help: the `context.command !== program` guard in the after-help
        //     hook — commander fires that hook for the ROOT command only, so the
        //     guard states an invariant rather than handling a reachable case.
        'src/mcpClient.ts': { functions: 90, lines: 90 },
        'src/help.ts': { functions: 90, lines: 90 },

        // UNGATED, deliberately — each is proven end-to-end instead, by the
        // story suite that runs the real binary (`tests/cli/cli-story.test.ts`):
        //   • src/index.ts   — the bin entrypoint: `process.exit` + the
        //     CliError-vs-crash split. Asserted there as "an unknown command
        //     exits 1 with one line and no stack".
        //   • src/program.ts — the commander wiring. Its `.action()` wrappers
        //     only run when a real argv is parsed; the story suite parses every
        //     one of them through the built binary, and `help.test.ts` covers the
        //     command tree's shape.
        //   • src/prompts.ts — a readline against a real TTY, with no seam and no
        //     TTY under a runner. Its CONSUMERS' interactive branches are covered
        //     with the reader stubbed (`commands.interactive.test.ts`), and the
        //     non-interactive refusals are covered for real.
      },
    },
  },
});
