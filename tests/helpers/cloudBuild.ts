import { afterAll, beforeAll } from 'vitest';

// MOTIR-4034 — the CLOUD arm, for suites that were written before the public
// surface had a build gate.
//
// `app/api/public/*` is gated behind `isCloud()` (`MOTIR_CLOUD`), which is
// EXPLICIT and defaults to false — so a Vitest run, which sets nothing, is a
// SELF-HOSTED build and every one of those routes answers 404. That is the
// product working. It also means a suite asserting what those routes SERVE is
// asserting about the cloud build and has to say so.
//
// Call `runAsCloudBuild()` at the top of such a file. (Named with a verb rather
// than `use…`: the `use` prefix makes ESLint's `react-hooks/rules-of-hooks`
// read a file-scope call as a misplaced React hook.) It is deliberately a plain
// `process.env` assignment rather than `vi.stubEnv`: several of these suites
// already run `vi.unstubAllEnvs()` in an `afterEach`, which would drop a stub
// after the first test and leave the rest of the file quietly measuring the
// self-hosted arm — green, and about the wrong build. The same reason
// `tests/billingService.test.ts` sets the flag this way.
//
// ⚠️ A suite that wants the SELF-HOSTED arm does NOT call this: unset is the
// default and is the arm that has never existed, which is exactly why
// `tests/api/public/cloud-gate.test.ts` drives both.

/** Run this file's tests as a Motir CLOUD build (`MOTIR_CLOUD=true`). */
export function runAsCloudBuild(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['MOTIR_CLOUD'];
    else process.env['MOTIR_CLOUD'] = previous;
  });
}
