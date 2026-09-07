import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

// Postgres job-engine boundary (Story MOTIR-3414 · Subtask MOTIR-3426). The
// engine's internals — the claim loop, the step shim, the dispatcher, the queue
// repositories — may be imported ONLY by the jobs runtime (lib/jobs/**) and the
// worker entrypoint (scripts/worker.ts). Everywhere else goes through
// sendEvent() / defineJob().
//
// ⚠️ IT IS THE SURVIVING HALF OF A PAIR, AND ITS TWIN IS WHY IT EXISTS. There
// used to be an `INNGEST_RESTRICTION` beside it, holding the vendor SDK inside
// the same two directories. MOTIR-3418 deleted that rule because the package it
// named is gone — and a rule guarding an absent package is dead weight, which is
// why its removal was made an acceptance criterion rather than a tidy-up: it is
// the machine-checkable proof the dependency left.
//
// This rule is the reason that removal cost one epic instead of two. The vendor's
// abstractions never reached past `lib/jobs/**`, so retiring it was a deletion
// rather than a rewrite — exactly three files imported the SDK at the end, as at
// the beginning. The boundary is cheap to hold now and expensive to establish
// later, and the next substrate will be retired by whoever holds this one.
const JOB_ENGINE_RESTRICTION = {
  group: ['@/lib/jobs/engine', '@/lib/jobs/engine/*', '**/lib/jobs/engine/*'],
  message:
    'The Postgres job engine is internal to the jobs runtime. Import it only in lib/jobs/** or scripts/worker.ts; elsewhere use sendEvent() / defineJob() from @/lib/jobs.',
};

// ⚠️ A THIRD RESTRICTION LIVED HERE AND ITS LESSON OUTLIVED IT
// (`INNGEST_CLIENT_RESTRICTION`, MOTIR-3415 · MOTIR-3456). The SDK rule above
// restricted the vendor PACKAGE and held from Story 1.6 — while every emitter
// that bypassed `sendEvent` imported `@/lib/jobs/client`, our own thin wrapper
// around that package, which is not the SDK and so was never restricted. Four
// `system.*` events reached the queue without the emit seam being consulted at
// all, under a green lint run.
//
// The rule went with the client file in MOTIR-3418. **The lesson is why
// `JOB_ENGINE_RESTRICTION` above names `@/lib/jobs/engine/*` and not a package:**
// a boundary that can be walked around by importing one file over is a
// convention, not a guard, so it is stated in terms of OUR module graph rather
// than a vendor's name.

// Async-email boundary (Story 1.6 · Subtask 1.6.3). The provider primitive
// `@/lib/email` (`sendEmail`) may be imported ONLY by lib/services/emailService.ts,
// which the `email.send` job calls. Every other caller — auth wiring, the
// invites service, routes — enqueues via sendEvent('email.send', …) so the
// send is durable + retried, never a synchronous fire-and-pray in the request.
const EMAIL_RESTRICTION = {
  name: '@/lib/email',
  message:
    "Don't send email synchronously. Enqueue via sendEvent('email.send', …); only lib/services/emailService.ts (run by the email.send job) imports @/lib/email. See Story 1.6.3 / docs/jobs.md.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Project-specific rules. These come AFTER the Next config so they win on conflict.
  {
    rules: {
      // Unused vars are errors, EXCEPT names prefixed with `_` (intentional unused).
      // Disable the base rule first; the TS version handles types correctly.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // console.log is a smell in committed code; warn (not error) so it surfaces in
      // CI but doesn't block a developer mid-debug. console.warn/.error are fine.
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Implicit any is already forbidden by tsconfig's `noImplicitAny`; this rule
      // catches the lint-side equivalent for completeness.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Two import boundaries enforced together (a file is checked against the
      // single no-restricted-imports rule, so both live here and the overrides
      // below re-state the subset that applies to each special surface):
      //   - JOB ENGINE: `@/lib/jobs/engine/*` only in lib/jobs/** + scripts/worker.ts.
      //   - EMAIL: `@/lib/email` only in lib/services/emailService.ts.
      'no-restricted-imports': [
        'error',
        {
          paths: [EMAIL_RESTRICTION],
          patterns: [JOB_ENGINE_RESTRICTION],
        },
      ],
    },
  },

  // The jobs runtime MAY import the engine — it IS the jobs runtime — but still
  // may NOT import @/lib/email (the job handler calls emailService, it doesn't
  // dispatch mail itself). So we drop the engine pattern, keep the email path.
  {
    files: ['lib/jobs/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [EMAIL_RESTRICTION] }],
    },
  },

  // The WORKER ENTRYPOINT is the one file outside lib/jobs/** that is allowed to
  // reach the engine: it is the process that RUNS it (fly.toml's `worker` group),
  // so it necessarily constructs the loop and the ledger wrapper directly. The
  // email boundary still applies to it — it sends no mail.
  {
    files: ['scripts/worker.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [EMAIL_RESTRICTION] }],
      // ⚠️ AND ITS STDOUT IS AN INTERFACE, NOT DEBUG OUTPUT (MOTIR-3564). This
      // process has no request, no response and no UI: its boot line, its drain
      // line and its exit line are the whole of what an operator — or a lane —
      // can observe. `tests/e2e/_helpers/job-worker-process.ts` RESOLVES on
      // `[worker] started as`, so the line is load-bearing rather than
      // incidental. The file carried three `no-console` warnings before this
      // override existed, which meant `--max-warnings=0` refused any commit that
      // touched it; the honest fix is to say the rule does not apply here rather
      // than to sprinkle three disables over lines that are doing their job.
      'no-console': 'off',
    },
  },

  // The E2E mutation→assert scanner (MOTIR-4399) is a REPORTING command, and the
  // same reasoning as `scripts/worker.ts` above applies for the same reason: its
  // stdout IS its interface. It prints a site list, a drop ladder or a JSON
  // payload — that output is the whole of what it does, and `docs/e2e/
  // mutation-assert-sweep.md` quotes it verbatim. `--max-warnings=0` in the
  // lint-staged hook means the alternative is ten `eslint-disable` comments over
  // lines that are doing their job.
  {
    files: ['scripts/scan-e2e-mutation-assert.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  // Experiment harnesses (`scripts/experiments/**`) MAY reach past the app's
  // seams. They exist to MEASURE substrate behaviour — building a standalone
  // client on a throwaway port precisely so it is not the app's job substrate —
  // and going through `defineJob`/`sendEvent` would measure our wrapper instead
  // of the thing under measurement. Nothing here ships in the app; the email
  // boundary still applies, same as for lib/jobs.
  {
    files: ['scripts/experiments/**/*.{ts,mjs,js}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [EMAIL_RESTRICTION] }],
    },
  },

  // emailService is the ONE file allowed to import @/lib/email — but it must not
  // reach into the job engine. So we drop the email path, keep the engine pattern.
  {
    files: ['lib/services/emailService.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [JOB_ENGINE_RESTRICTION] }],
    },
  },

  // Tests may reach across layers (assert DB state, drive jobs, exercise the
  // email provider directly) — both import boundaries are off here. Mirrors
  // the CLAUDE.md "tests may import repositories directly" exception.
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // MUST come last: turns off ESLint rules that conflict with Prettier formatting.
  // Without this, ESLint and Prettier fight over things like trailing commas.
  prettier,

  globalIgnores([
    // Defaults inherited from eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Project additions:
    'node_modules/**',
    'prisma/migrations/**',
    // The project-references declaration output (MOTIR-4293). `tsc -b
    // tsconfig.solution.json` writes one `.d.ts` tree per project here; it is
    // git-ignored build state, and linting it would make `pnpm lint` depend on
    // whether a type-check has been run in this working tree.
    '.tsout/**',
    // Workspace-package BUILD output only — the bundled binary, not source.
    // The package SOURCE is linted by the shared config (Subtask 7.9.1; 7.9.5
    // wires the CLI's own coverage gate).
    'packages/*/dist/**',
    // …and the coverage report a package's own `vitest --coverage` writes
    // (MOTIR-4300). Istanbul's HTML reporter ships vendored JS carrying its own
    // eslint directives, so linting it produces findings about somebody else's
    // bundled code — and whether they appear at all depends on whether a package's
    // tests have been run in this working tree.
    'packages/*/coverage/**',
    // The GENERATED v1 client (Subtask 11.5.2) — machine-written, regenerated by
    // `pnpm generate:cli-api`, and held honest by a CI freshness guard rather
    // than by lint. Linting it would only ever produce edits the next
    // regeneration destroys.
    'packages/cli/src/api/**',
  ]),
]);

export default eslintConfig;
