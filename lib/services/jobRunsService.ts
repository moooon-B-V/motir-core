import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { toJobRunDTO } from '@/lib/mappers/jobMappers';
import type { JobRunDTO, JobRunFailure } from '@/lib/dto/jobs';

// Business logic for the job_run ledger (Story 1.6 · Subtask 1.6.2). Owns the
// transactions; `defineJob` calls `recordStart` then `recordFinish` around the
// user handler. Each method is a one-statement-flow transaction — the two
// writes can't share a transaction because the user handler runs (possibly for
// minutes) between them.

export interface RecordStartInput {
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  eventId: string;
  attempt: number;
  idempotencyKey?: string | null;
}

export const jobRunsService = {
  /** Insert the `running` row at job start; returns the persisted DTO. */
  async recordStart(input: RecordStartInput): Promise<JobRunDTO> {
    const run = await db.$transaction((tx) =>
      jobRunRepository.create(
        {
          workspace: input.workspaceId ? { connect: { id: input.workspaceId } } : undefined,
          functionId: input.functionId,
          eventName: input.eventName,
          eventId: input.eventId,
          attempt: input.attempt,
          status: 'running',
          idempotencyKey: input.idempotencyKey ?? null,
        },
        tx,
      ),
    );
    return toJobRunDTO(run);
  },

  /**
   * Flip a run to `succeeded`. Reads startedAt inside the tx to compute
   * durationMs from DB timestamps (not wall-clock in the wrapper, which would
   * be wrong across Inngest's step replays).
   */
  async recordSuccess(id: string): Promise<JobRunDTO> {
    return this.recordFinish(id, 'succeeded', null);
  },

  /** Flip a run to `failed`, capturing the serialized failure. */
  async recordFailure(id: string, failure: JobRunFailure): Promise<JobRunDTO> {
    return this.recordFinish(id, 'failed', failure);
  },

  async recordFinish(
    id: string,
    status: 'succeeded' | 'failed',
    failure: JobRunFailure | null,
  ): Promise<JobRunDTO> {
    const run = await db.$transaction(async (tx) => {
      const existing = await jobRunRepository.findById(id, tx);
      if (!existing) {
        throw new Error(`job_run ${id} not found when recording ${status}`);
      }
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - existing.startedAt.getTime();
      return jobRunRepository.update(
        id,
        {
          status,
          finishedAt,
          durationMs,
          // Prisma JSON write: a JobRunFailure object sets the column;
          // `undefined` leaves it untouched (the success path never has a
          // failure, so it stays null). The cast bridges our typed shape to
          // Prisma's structural InputJsonObject (which needs an index sig).
          failure: failure ? (failure as unknown as Prisma.InputJsonObject) : undefined,
        },
        tx,
      );
    });
    return toJobRunDTO(run);
  },
};
