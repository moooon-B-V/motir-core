// ── THE BASELINE PROBE (MOTIR-4422) ──────────────────────────────────────────
//
// One trivial test body and nothing else. It is never RUN — no vitest config
// globs this directory — and it exists so that
// `scripts/ci/assert-typecheck-headroom.mjs --baseline` can read the tests
// project's FIXED cost DIRECTLY, in one build, instead of inferring it from the
// difference between two configurations.
//
// `scripts/ci/typecheck-baseline/tsconfig.json` is this file's project: the
// tests project's options and the tests project's references, with the include
// set replaced by this one file. So the difference between that project's
// reading and `tsconfig.tests.json`'s is exactly the test BODIES — which is the
// line MOTIR-4422 re-derives.
import { describe, expect, it } from 'vitest';

describe('the baseline probe', () => {
  it('is one test body and nothing else', () => {
    expect(1).toBe(1);
  });
});
