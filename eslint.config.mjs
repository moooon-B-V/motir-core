import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

// Background-jobs boundary (Story 1.6). The raw Inngest SDK may be imported
// ONLY by the jobs runtime (lib/jobs/**) and the serve route
// (app/api/inngest/**). Everywhere else goes through sendEvent() / defineJob().
const INNGEST_RESTRICTION = {
  group: ['inngest', 'inngest/*'],
  message:
    'Import the Inngest SDK only in lib/jobs/** or app/api/inngest/. Elsewhere use sendEvent() / defineJob() from @/lib/jobs.',
};

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
      //   - INNGEST: raw SDK only in lib/jobs/** + app/api/inngest/**.
      //   - EMAIL: `@/lib/email` only in lib/services/emailService.ts.
      'no-restricted-imports': [
        'error',
        {
          paths: [EMAIL_RESTRICTION],
          patterns: [INNGEST_RESTRICTION],
        },
      ],
    },
  },

  // The jobs runtime + serve route MAY import the Inngest SDK — but still may
  // NOT import @/lib/email (the job handler calls emailService, it doesn't
  // dispatch mail itself). So we drop the inngest pattern, keep the email path.
  {
    files: ['lib/jobs/**/*.{ts,tsx}', 'app/api/inngest/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [EMAIL_RESTRICTION] }],
    },
  },

  // emailService is the ONE file allowed to import @/lib/email — but it must
  // not reach for the Inngest SDK. So we drop the email path, keep the inngest
  // pattern.
  {
    files: ['lib/services/emailService.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [INNGEST_RESTRICTION] }],
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
    // Workspace-package BUILD output only — the bundled binary, not source.
    // The package SOURCE is linted by the shared config (Subtask 7.9.1; 7.9.5
    // wires the CLI's own coverage gate).
    'packages/*/dist/**',
  ]),
]);

export default eslintConfig;
