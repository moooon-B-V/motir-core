import { defineJob } from '../defineJob';

// THE DAILY AGENT STORAGE CHARGE (Story MOTIR-6914 · MOTIR-6919) — a thin caller
// over `agentInstanceStorageChargeService.chargeDays`, whose header carries the
// argument: one debit per agent per UTC day on which it existed, keyed on the
// instance and the day (`docs/decisions/agent-instance-storage.md` §2).

/**
 * Hourly at :30, ON the cluster (`SCHEDULE_CLUSTER_MINUTES`, `[0, 30]`), so it
 * opens no new wake-minute. The charge is per DAY, but the pass runs hourly: a
 * day already written is skipped by its unique key, so the extra passes cost a
 * read and charge nothing, and a failed debit is retried within the hour rather
 * than the next day. It also means an outage has to swallow a whole day before
 * the pass's one-day lookback could miss anything.
 */
export const AGENT_INSTANCE_STORAGE_CHARGE_CRON = '30 * * * *';

export const agentInstanceStorageCharge = defineJob(
  {
    id: 'system.agent-instance-storage-charge',
    cron: AGENT_INSTANCE_STORAGE_CHARGE_CRON,
    /**
     * `latest` — the days a pass writes are chosen by what existed in the window
     * (yesterday and today), never by the fire instant, so one pass covers every
     * missed fire inside that window.
     */
    catchUp: 'latest',
    /**
     * `idempotent`: a day is written once under its unique key, and motir-ai's
     * ledger is keyed on the same instance and day, so a retried pass charges
     * nothing twice.
     */
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('charge-agent-instance-storage', () =>
      services.agentInstanceStorageCharge.chargeDays(),
    );
  },
);
