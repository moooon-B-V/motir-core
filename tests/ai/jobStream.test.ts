import { describe, it, expect, vi } from 'vitest';
import { failureReasonFrame } from '@/lib/ai/jobStream';
import type { JobStreamEvent } from '@/lib/ai/types';

// Unit test for the terminal-failure-reason enrichment (Subtask 8.1.8). The raw
// motir-ai stream reports THAT a job failed (a `failed` status) but not WHY; the
// stream route calls this per relayed frame to append the reason as an `error`
// frame the SSE consumers understand — so an out-of-credits refusal reaches the
// paywall. The job-error read is injected, so no boundary is touched.

const failed: JobStreamEvent = { event: 'status', data: { jobId: 'j', status: 'failed' } };

describe('failureReasonFrame', () => {
  it('returns an `error` frame carrying the reason on a terminal `failed` status', async () => {
    const readJobError = vi
      .fn()
      .mockResolvedValue({ code: 'MOTIR_AI_OUT_OF_CREDITS', message: 'out of credits' });

    const frame = await failureReasonFrame('j', failed, readJobError);

    expect(frame).toEqual({
      event: 'error',
      data: { code: 'MOTIR_AI_OUT_OF_CREDITS', message: 'out of credits' },
    });
    expect(readJobError).toHaveBeenCalledWith('j');
  });

  it('returns null for a non-failed status frame (and never reads the job error)', async () => {
    const readJobError = vi.fn();
    const running: JobStreamEvent = { event: 'status', data: { jobId: 'j', status: 'running' } };
    expect(await failureReasonFrame('j', running, readJobError)).toBeNull();
    expect(readJobError).not.toHaveBeenCalled();
  });

  it('returns null for non-status frames (token / done)', async () => {
    const readJobError = vi.fn();
    expect(
      await failureReasonFrame('j', { event: 'token', data: { text: 'hi' } }, readJobError),
    ).toBeNull();
    expect(
      await failureReasonFrame('j', { event: 'done', data: { jobId: 'j' } }, readJobError),
    ).toBeNull();
    expect(readJobError).not.toHaveBeenCalled();
  });

  it('returns null when the failed job exposes no readable error', async () => {
    expect(await failureReasonFrame('j', failed, async () => null)).toBeNull();
  });

  it('degrades to null if reading the reason throws (a boundary blip)', async () => {
    const frame = await failureReasonFrame('j', failed, async () => {
      throw new Error('boundary down');
    });
    expect(frame).toBeNull();
  });
});
