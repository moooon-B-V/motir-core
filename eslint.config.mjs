import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

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

      // Background-jobs boundary (Story 1.6). The raw Inngest SDK may be
      // imported ONLY by the jobs runtime (lib/jobs/**) and the serve route
      // (app/api/inngest/**) — see the override below. Everywhere else (routes,
      // services, components) must go through sendEvent() / defineJob() from
      // @/lib/jobs so the 4-layer split + the run-ledger bookkeeping stay
      // uniform. Keeps a route from firing a background event by reaching past
      // the wrapper into inngest.send().
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['inngest', 'inngest/*'],
              message:
                'Import the Inngest SDK only in lib/jobs/** or app/api/inngest/. Elsewhere use sendEvent() / defineJob() from @/lib/jobs.',
            },
          ],
        },
      ],
    },
  },

  // The two surfaces allowed to import the raw Inngest SDK: the jobs runtime
  // and the serve route. This override MUST come after the rule above to win.
  {
    files: ['lib/jobs/**/*.{ts,tsx}', 'app/api/inngest/**/*.{ts,tsx}'],
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
  ]),
]);

export default eslintConfig;
