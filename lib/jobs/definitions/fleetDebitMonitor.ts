import { defineJob } from '../defineJob';

/**
 * THE FLEET DEBIT MONITOR'S SCHEDULE (Story MOTIR-6905 · MOTIR-7318).
 *
 * Every debit period: judge every organisation running containers (or accruing
 * in the window) and alert once per mismatched (org, reason)
 * (`fleetDebitMonitorService.run`).
 *
 * ⚠️ THE CADENCE IS THE DEBIT PERIOD. The verdicts are judged over a window of
 * two periods, so a run every period sees a mismatch within one cycle of it
 * becoming one. Five lands on MOTIR-6893's default sub-hourly cadence, so it
 * needs no exception entry (`fleet-per-org-pool.md` §3).
 *
 * ⚠️ NEVER GATED ON ACTIVITY. A meter that quietly stopped is exactly the case
 * where nothing else in Motir notices.
 */
export const FLEET_DEBIT_MONITOR_CRON = '*/5 * * * *';

export const fleetDebitMonitor = defineJob(
  {
    id: 'system.fleet-debit-monitor',
    cron: FLEET_DEBIT_MONITOR_CRON,
    // `latest`: a run reads the CURRENT state, so a missed one is not work to
    // replay — the next one alerts on whatever still disagrees.
    catchUp: 'latest',
    // `idempotent`: it writes nothing, and a retried capture adds an event to the
    // same fingerprinted issue rather than opening a new one.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('fleet-debit-monitor', () => services.fleetDebitMonitor.run(new Date()));
  },
);
