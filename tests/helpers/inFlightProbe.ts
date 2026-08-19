import { afterEach } from 'vitest';

/**
 * The empirical half of MOTIR-3077 — a suite-wide `afterEach` that asks, after
 * every single test, whether anything this worker started is STILL RUNNING.
 *
 * MOTIR-3066's leak (`getQuickView`'s refused peek abandoning four bound reads)
 * was found by accident, from a deadlock in an unrelated file. The source scan
 * this card also carries can only see the fan-outs whose arms open a transaction
 * IN THE BLOCK; this instrument sees any abandoned work at all, whatever shape
 * produced it, and names the test that left it behind.
 *
 * OFF by default and gated on `MOTIR_INFLIGHT_PROBE=1`: it costs one
 * `pg_stat_activity` read per test, and the import is dynamic so a run without
 * the flag does not even construct the admin client. Enable it for a deliberate
 * sweep, never in the normal lane:
 *
 *   MOTIR_INFLIGHT_PROBE=1 pnpm vitest run --shard=2/3
 *
 * Findings go to stderr with a fixed `[in-flight]` prefix so a whole shard's
 * output can be grepped for them.
 */
afterEach(async (ctx) => {
  if (process.env['MOTIR_INFLIGHT_PROBE'] !== '1') return;
  const { inFlightBackends, describeInFlight } = await import('./inFlightWork');
  let leftover;
  try {
    leftover = await inFlightBackends();
  } catch {
    // A file that never touched the database (a pure component test) has no
    // worker DB connection to ask; that is not a finding.
    return;
  }
  if (leftover.length === 0) return;
  console.error(
    `[in-flight] ${leftover.length} backend(s) after "${ctx.task.name}" (${ctx.task.file?.name ?? '?'}):\n${describeInFlight(leftover)}`,
  );
});
