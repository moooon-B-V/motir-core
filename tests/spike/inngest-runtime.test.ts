// ─────────────────────────────────────────────────────────────────────────
// Subtask 1.6.1 — Validation #3: CI test harness (in-process, no live server).
//
// Proves `@inngest/test`'s `InngestTestEngine` runs `example.ping` to
// completion inside Vitest with NO live Inngest server, NO dev CLI, and NO
// network — exactly the shape 1.6.2's production job tests will use. This is
// the surface most worth de-risking here because the Subtask card flagged
// "@inngest/test doesn't compose with Vitest 4" as a candidate failure mode
// (this repo is on Vitest 4.1.7; @inngest/test 1.0.0 pins vitest ^3 in its own
// devDeps, but is framework-agnostic / Jest-compatible — this test confirms it
// composes).
//
// Runs in the default `node` Vitest environment (no DB, so the global
// vitest.config.ts include glob `tests/**/*.test.ts` picks it up with zero
// config changes — confirmed: no CI edit needed).
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { ping } from '@/app/api/inngest/spike';

describe('Subtask 1.6.1 spike — Inngest CI harness (@inngest/test + Vitest 4)', () => {
  const t = new InngestTestEngine({ function: ping });

  it('runs example.ping to completion in-process and returns the expected shape', async () => {
    const { result } = await t.execute({
      events: [{ name: 'example/ping', data: { from: 'vitest' } }],
    });

    // The function's return value is handed back verbatim by the harness.
    expect(result).toMatchObject({
      ok: true,
      echo: { from: 'vitest' },
    });
    // receivedAt is Date.now() captured inside the run — assert it's a sane ms epoch.
    expect((result as { receivedAt: number }).receivedAt).toBeTypeOf('number');
    expect((result as { receivedAt: number }).receivedAt).toBeGreaterThan(0);
  });

  it('injects a synthetic event when none is supplied', async () => {
    // SPIKE FINDING for 1.6.2: with no `events` mock, @inngest/test injects a
    // synthetic `inngest/function.invoked` event whose `data` is an empty
    // object `{}` (NOT undefined). So `event.data ?? null` echoes `{}`, not
    // null. Production tests that rely on a default-event run must expect `{}`
    // for `event.data`, and should pass an explicit `events:` mock whenever the
    // function branches on payload contents.
    const { result } = await t.execute({});
    expect(result).toMatchObject({ ok: true, echo: {} });
  });
});
