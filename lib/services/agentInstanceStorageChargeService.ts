import type { AgentInstance } from '@/generated/prisma/client';
import { INSTANCE_STORAGE_CREDITS_PER_DAY } from '@/lib/agentInstances/config';
import { debitAgentStorage } from '@/lib/ai/motirAiClient';
import { MotirAiConfigError, MotirAiError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { isCloudBilling } from '@/lib/billing/availability';
import { platformMeterReportEnqueue } from '@/lib/services/platformMeterReportEnqueue';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  agentInstanceStorageChargeRepository,
  type AgentInstanceStorageDayInput,
} from '@/lib/repositories/agentInstanceStorageChargeRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// AN AGENT INSTANCE'S STORAGE IS CHARGED ONCE PER UTC DAY (Story MOTIR-6914 ·
// MOTIR-6919; `docs/decisions/agent-instance-storage.md` §2).
//
// ⚠️ ONE DEBIT PER AGENT PER UTC DAY ON WHICH IT EXISTED AT ANY MOMENT — running,
// hibernated or failed. The day it was created is charged, and so is the day it
// was deleted, and no day after. The rate is `INSTANCE_STORAGE_CREDITS_PER_DAY`.
//
// ⚠️ WRITE THE DAY, THEN CHARGE IT — the interval charge's shape
// (`agentInstanceChargeService`): each (instance, day) is first written as a
// `pending` row keyed `agent-storage:<instance id>:<day>`, and only then is
// motir-ai asked. A transport failure leaves the row `pending` with the attempt
// counted, and the next pass asks again with the same key; motir-ai builds its
// ledger key from the same instance and day, so a debit that landed before a
// timed-out answer is answered `idempotent` rather than charged twice.
//
// ⚠️ THE WINDOW IS YESTERDAY AND TODAY. The job runs early each UTC day, so
// "yesterday" is a day that has ended: an agent created or deleted late in it is
// caught whole. "Today" charges what exists now. A day already written is skipped
// by the unique key, so running twice — or the catch-up after a missed fire —
// adds nothing. It deliberately does not reach further back: a pass never bills a
// customer for days before the charge existed.
//
// ⚠️ A SELF-HOSTED BUILD CHARGES NOTHING and writes nothing (§1: there is no AI
// plan and no storage charge off-cloud), exactly as `assertCredits` returns early.

/** The days before today the pass writes — yesterday. */
export const STORAGE_CHARGE_LOOKBACK_DAYS = 1;

/** How many pending days one pass asks motir-ai about. The rest wait a pass. */
export const STORAGE_CHARGE_BATCH = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentInstanceStorageChargeSummary {
  /** Days newly written `pending` this pass. */
  written: number;
  charged: number;
  refused: number;
  notCharged: number;
  /** Still `pending` — motir-ai could not be reached; the next pass asks again. */
  retryable: number;
}

/** Midnight UTC of the day `at` falls in. */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** `YYYY-MM-DD` of a midnight-UTC date. */
export function utcDayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function storageChargeReference(instanceId: string, day: Date): string {
  return `agent-storage:${instanceId}:${utcDayKey(day)}`;
}

/**
 * The UTC days in `[windowStart, today]` on which `instance` existed at any moment:
 * from the day it was created (or the window's first day) to the day it was
 * deleted (or today).
 */
export function daysExisted(instance: AgentInstance, windowStart: Date, today: Date): Date[] {
  const created = utcDayStart(instance.createdAt);
  const first = created > windowStart ? created : windowStart;
  const deleted = instance.deletedAt ? utcDayStart(instance.deletedAt) : null;
  const last = deleted && deleted < today ? deleted : today;
  const days: Date[] = [];
  for (let t = first.getTime(); t <= last.getTime(); t += DAY_MS) days.push(new Date(t));
  return days;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

export const agentInstanceStorageChargeService = {
  /**
   * One pass: write every (instance, day) in the window that is not written yet,
   * then charge every day still `pending` — this pass's and any an earlier pass
   * could not. Never throws for a cross-boundary failure.
   */
  async chargeDays(opts: { now?: Date } = {}): Promise<AgentInstanceStorageChargeSummary> {
    const summary: AgentInstanceStorageChargeSummary = {
      written: 0,
      charged: 0,
      refused: 0,
      notCharged: 0,
      retryable: 0,
    };
    if (!isCloudBilling()) return summary;

    const today = utcDayStart(opts.now ?? new Date());
    const windowStart = new Date(today.getTime() - STORAGE_CHARGE_LOOKBACK_DAYS * DAY_MS);
    const windowEnd = new Date(today.getTime() + DAY_MS);

    // 1 · Discover, across tenants, every instance that stood in the window.
    const instances = await withSystemContext((tx) =>
      agentInstanceRepository.listExistedBetween(windowStart, windowEnd, tx),
    );

    // 2 · Write its days `pending`, each workspace under its own binding.
    const byWorkspace = new Map<string, AgentInstanceStorageDayInput[]>();
    for (const instance of instances) {
      const rows = byWorkspace.get(instance.workspaceId) ?? [];
      for (const day of daysExisted(instance, windowStart, today)) {
        rows.push({
          workspaceId: instance.workspaceId,
          organizationId: instance.organizationId,
          agentInstanceId: instance.id,
          day,
          credits: INSTANCE_STORAGE_CREDITS_PER_DAY,
          chargeReference: storageChargeReference(instance.id, day),
        });
      }
      byWorkspace.set(instance.workspaceId, rows);
    }
    for (const [workspaceId, rows] of byWorkspace) {
      summary.written += await withWorkspaceServiceContext(workspaceId, (tx) =>
        agentInstanceStorageChargeRepository.createDays(rows, tx),
      );
    }

    // 3 · Charge every pending day, oldest first.
    const pending = await withSystemContext((tx) =>
      agentInstanceStorageChargeRepository.listPending(STORAGE_CHARGE_BATCH, tx),
    );
    for (const row of pending) {
      const record = (
        data: Parameters<typeof agentInstanceStorageChargeRepository.recordCharge>[1],
      ) =>
        withWorkspaceServiceContext(row.workspaceId, (tx) =>
          agentInstanceStorageChargeRepository.recordCharge(row.id, data, tx),
        );
      try {
        await debitAgentStorage({
          coreOrganizationId: row.organizationId,
          instanceId: row.agentInstanceId,
          day: utcDayKey(row.day),
          credits: row.credits,
          reason: 'agent instance storage',
        });
        await record({ outcome: 'charged', chargedAt: new Date(), detail: null });
        summary.charged += 1;
      } catch (err) {
        if (err instanceof MotirAiConfigError) {
          await record({ outcome: 'not_charged', detail: 'motir-ai is not configured' });
          summary.notCharged += 1;
          continue;
        }
        const detail = describe(err);
        if (err instanceof MotirAiUnavailableError || !(err instanceof MotirAiError)) {
          // Still `pending`, with the attempt counted — the next pass asks again.
          await record({ outcome: 'pending', detail });
          summary.retryable += 1;
          continue;
        }
        await record({ outcome: 'refused', detail });
        summary.refused += 1;
        continue;
      }
      // CHARGED: the day's usage and Motir cost go to the platform rollup
      // (MOTIR-7294) — a job, enqueued after the charge is recorded and OUTSIDE the
      // charge's try, so it can never reclassify, undo or fail the charge.
      await platformMeterReportEnqueue.storage(row.id);
    }
    return summary;
  },
};
