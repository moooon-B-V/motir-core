// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// THE COMPOSER STAYS LIVE (Story MOTIR-4054 · MOTIR-4274) — the client half of
// the boundary mailbox.
//
// The pipe shipped with MOTIR-4067 and the drawing with MOTIR-4066, and nothing
// connected them: the product wrote to the mailbox from nowhere and the drawn
// queued state rendered nowhere. This is that connection, and the two things it
// has to get right are both invisible when they go wrong:
//
//   1. THE BRANCH. One control, two destinations, chosen by the run's phase. A
//      mid-run turn sent down the SUBMIT path opens a SECOND planning job on a
//      thread that already has one; a between-runs turn sent to the MAILBOX
//      lands in a box nothing will ever check. Neither throws.
//   2. QUEUED IS NOT DELIVERED. The run reads at a phase boundary that can be a
//      whole authoring session away, so a turn that looks delivered and changes
//      nothing for thirty seconds reads as a bug.
//
// ⚠️ RE-POINTED BY MOTIR-7996 (ADR AMENDMENT 4). A mid-run turn no longer goes
// to the mailbox: it is posted to `ask_project` WITH A RUN SNAPSHOT
// (`submitMidRunAskTurn`), streamed and settled on its OWN controller, and the
// mailbox is written only when the settle says `forwarded`. The mailbox still
// carries what is forwarded, so the queued → read poll below is unchanged; what
// changed is the DOOR the turn takes to get there, and that the run's own
// `jobId` / `phase` / `stopping` are untouched while it does.
//
// Driven through the ANCHORED door for the same reason the stop suite is: the
// project thread's `send` goes through the ONE DOOR (`submitAskTurn`), a second
// settle path this card does not touch.

const openSession = vi.fn();
const resumeContextual = vi.fn();
const recordPlannerTurn = vi.fn();
const submitContextualPlan = vi.fn();
const attachMidRunTurn = vi.fn();
const submitMidRunAskTurn = vi.fn();
const settleAskJob = vi.fn();
const streamAskJob = vi.fn();
const peekMailbox = vi.fn();
const stopRun = vi.fn();
const streamContextual = vi.fn();
const readPending = vi.fn();

vi.mock('@/lib/planning/planChangeClient', () => ({
  // The resume read answers `{ session, earlier }` (MOTIR-6024); these cases
  // mock the SESSION, so the factory wraps it.
  findResumableSession: async (...a: unknown[]) => ({
    session: await (openSession as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  resumeContextualSession: (...a: unknown[]) => resumeContextual(...a),
  recordPlannerTurn: (...a: unknown[]) => recordPlannerTurn(...a),
  submitContextualPlan: (...a: unknown[]) => submitContextualPlan(...a),
  attachMidRunTurn: (...a: unknown[]) => attachMidRunTurn(...a),
  peekMailbox: (...a: unknown[]) => peekMailbox(...a),
  stopPlanChangeRun: (...a: unknown[]) => stopRun(...a),
  submitPlanChange: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: vi.fn(),
  rerunAskTurn: vi.fn(),
  submitMidRunAskTurn: (...a: unknown[]) => submitMidRunAskTurn(...a),
  settleAskJob: (...a: unknown[]) => settleAskJob(...a),
}));

vi.mock('@/lib/planning/planEditsClient', () => ({
  streamContextualPlanJob: (...a: unknown[]) => streamContextual(...a),
  streamAugmentJob: vi.fn(),
  streamAskJob: (...a: unknown[]) => streamAskJob(...a),
  PlanEditsClientError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null,
    ) {
      super(`Plan edits request failed (${status})`);
    }
  },
  OUT_OF_CREDITS_CODE: 'MOTIR_AI_OUT_OF_CREDITS',
}));

vi.mock('@/lib/planning/planReview', async (orig) => ({
  ...(await orig<typeof import('@/lib/planning/planReview')>()),
  readPendingProposal: (...a: unknown[]) => readPending(...a),
}));

// The run's plan is live-polled while it is written (MOTIR-6295). This suite is
// about the stream, not the poll, so the poll's read never settles: no request
// leaves the process, and the hook aborts it on unmount.
vi.mock('@/lib/planning/planReviewClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/planning/planReviewClient')>()),
  fetchPlanReview: () => new Promise(() => {}),
}));

const { usePlanChangeConversation } = await import('@/lib/hooks/usePlanChangeConversation');
const { PlanEditsClientError } = await import('@/lib/planning/planEditsClient');

const SESSION = {
  id: 's1',
  projectId: 'p1',
  turnCount: 0,
  targetKeys: [],
  lastJobId: null,
  lastSubmittedAt: null,
  turns: [],
  refs: {},
};

const TARGETS = [
  { id: 'wi-1', identifier: 'MOTIR-1', title: 'A card', kind: 'story' },
] as unknown as Parameters<ReturnType<typeof usePlanChangeConversation>['send']>[1];

/** A settle that FORWARDED: the mailbox as it stands, one [id, text] per entry. */
function forwarded(...pairs: Array<[string, string]>) {
  return {
    outcome: 'forwarded' as const,
    delivery: {
      turns: pairs.map(([id, text]) => ({
        id,
        text,
        receivedAt: 'x',
        disposition: 'fold',
        target: null,
      })),
      stopped: false,
    },
    session: SESSION,
  };
}

function heldStream() {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  streamContextual.mockImplementation(async () => {
    await held;
  });
  return release;
}

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi-1' }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

/** Start a run and leave it streaming. Returns the release + the pending promise.
 *
 *  ⚠️ REAL TIMERS ONLY. `waitFor` polls, and under fake timers it waits on a
 *  clock nobody is advancing while the promise chain it is actually waiting for
 *  resolves on microtasks — which deadlocks. Every fake-timer test below
 *  therefore installs its timers AFTER this helper has returned, never before. */
async function running(hook: Awaited<ReturnType<typeof mounted>>) {
  const release = heldStream();
  let promise!: Promise<void>;
  await act(async () => {
    promise = hook.result.current.send('Add a stop control.', TARGETS);
    await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
  return { release, promise };
}

beforeEach(() => {
  vi.clearAllMocks();
  openSession.mockResolvedValue(SESSION);
  resumeContextual.mockResolvedValue(SESSION);
  recordPlannerTurn.mockResolvedValue(SESSION);
  submitContextualPlan.mockResolvedValue({ jobId: 'job-1', planId: 'plan-1', session: SESSION });
  readPending.mockResolvedValue(null);
  streamContextual.mockResolvedValue(undefined);
  submitMidRunAskTurn.mockResolvedValue({ jobId: 'ask-1', turnId: 't1', session: SESSION });
  streamAskJob.mockResolvedValue(undefined);
  settleAskJob.mockResolvedValue(forwarded(['m1', 'Also drop the narration card.']));
  peekMailbox.mockResolvedValue({ turns: [], stopped: false });
});

describe('THE BRANCH — one control, two destinations, chosen by the phase', () => {
  it('a turn typed DURING a run goes to the ANSWERING session, not the mailbox, and starts no second job', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitContextualPlan.mockClear();

    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });

    expect(submitMidRunAskTurn).toHaveBeenCalledTimes(1);
    expect(submitMidRunAskTurn).toHaveBeenCalledWith(
      's1',
      'job-1',
      'plan-1',
      'Also drop the narration card.',
      expect.anything(),
    );
    // The mailbox is written by the SERVER at settle, when the verdict is a
    // change; the browser no longer posts to it.
    expect(attachMidRunTurn).not.toHaveBeenCalled();
    // ⚠️ THE HALF THAT WOULD BE SILENT. A mid-run turn down the submit path opens
    // a SECOND planning job on a thread that already has one — nothing throws,
    // and two runs then race for the same plan.
    expect(submitContextualPlan).not.toHaveBeenCalled();
    // The ask is streamed and settled as ITS OWN job.
    expect(streamAskJob).toHaveBeenCalledWith(
      'ask-1',
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
    );
    expect(settleAskJob).toHaveBeenCalledWith('ask-1', expect.anything(), 's1');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('keeps the planning run’s jobId, phase and stopping across a mid-run ask', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    // Hold the ask's settle open so the assertions run WHILE it is in flight.
    let finish!: () => void;
    settleAskJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ outcome: 'answered', session: SESSION });
        }),
    );

    let sent!: Promise<void>;
    await act(async () => {
      sent = hook.result.current.send('How far along are you?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(settleAskJob).toHaveBeenCalled());

    expect(hook.result.current.state.jobId).toBe('job-1');
    expect(hook.result.current.state.phase).toBe('streaming');
    expect(hook.result.current.state.stopping).toBe(false);

    // And Stop still raises the stop on the PLANNING job, not on the ask.
    await act(async () => {
      await hook.result.current.stop();
    });
    expect(stopRun).toHaveBeenCalledWith('s1', 'job-1', expect.any(String));

    await act(async () => {
      finish();
      await sent;
    });
    expect(hook.result.current.state.jobId).toBe('job-1');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('an answered question writes nothing into the queue', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    settleAskJob.mockResolvedValue({ outcome: 'answered', session: SESSION });

    await act(async () => {
      await hook.result.current.send('How far along are you?', TARGETS);
    });

    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.refusedForward).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('⚠️ a forward refused because the run ended sets refusedForward — the words come back', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    settleAskJob.mockResolvedValue({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      jobStatus: 'succeeded',
      text: 'Also drop the narration card.',
      session: SESSION,
    });

    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });

    expect(hook.result.current.state.refusedForward).toEqual({
      text: 'Also drop the narration card.',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
    });
    expect(hook.result.current.state.queued).toEqual([]);

    // The next mid-run send clears it.
    settleAskJob.mockResolvedValue({ outcome: 'answered', session: SESSION });
    await act(async () => {
      await hook.result.current.send('Never mind, how far along?', TARGETS);
    });
    expect(hook.result.current.state.refusedForward).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('a turn typed BETWEEN runs still takes the shipped submit path, unchanged', async () => {
    // The regression this card is most likely to cause, so it is asserted rather
    // than assumed: the other silent failure is a turn landing in a mailbox
    // nothing will ever check.
    const hook = await mounted();

    await act(async () => {
      await hook.result.current.send('Add a stop control.', TARGETS);
    });

    expect(submitContextualPlan).toHaveBeenCalledTimes(1);
    expect(attachMidRunTurn).not.toHaveBeenCalled();
  });

  it('submits each mid-run send as its own ask — a new sentence is never a replay', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn
      .mockResolvedValueOnce({ jobId: 'ask-1', turnId: 't1', session: SESSION })
      .mockResolvedValueOnce({ jobId: 'ask-2', turnId: 't2', session: SESSION });

    await act(async () => {
      await hook.result.current.send('First thing.', TARGETS);
    });
    await act(async () => {
      await hook.result.current.send('Second thing.', TARGETS);
    });

    // The forward's idempotency is the SERVER's (`forward:<ask job id>`), keyed on
    // the ask job each send produced — so two sentences are two jobs.
    expect(settleAskJob.mock.calls.map((c) => c[0])).toEqual(['ask-1', 'ask-2']);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('does not send an empty turn down either path', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);

    await act(async () => {
      await hook.result.current.send('   \n ', TARGETS);
    });

    expect(attachMidRunTurn).not.toHaveBeenCalled();
    expect(submitMidRunAskTurn).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await promise;
    });
  });
});

describe('QUEUED is not DELIVERED', () => {
  it('records what the door says is waiting, unread', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);

    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });

    expect(hook.result.current.state.queued).toEqual([
      { id: 'm1', text: 'Also drop the narration card.', read: false },
    ]);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('takes the WHOLE pending set from the answer, not a local append', async () => {
    // The door answers with the mailbox as it stands, which keeps the count right
    // when the run consumed something between two sends — a local append would
    // show a turn that is already gone.
    const hook = await mounted();
    const { release, promise } = await running(hook);

    settleAskJob.mockResolvedValue(forwarded(['m1', 'one'], ['m2', 'two']));
    await act(async () => {
      await hook.result.current.send('two', TARGETS);
    });

    expect(hook.result.current.state.queued.map((t) => t.id)).toEqual(['m1', 'm2']);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('⚠️ flips to READ when the turn leaves the pending set — the TRANSITION', async () => {
    // There is no push for this: `motir-ai` consumes at a boundary and emits no
    // frame, and its `MailboxReport` never reaches motir-core. Absence from the
    // pending set IS the evidence, which is why the client asks.
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await hook.result.current.send('Also drop the narration card.', TARGETS);
      });
      expect(hook.result.current.state.queued[0]!.read).toBe(false);

      // The run took it: the pending set no longer holds it.
      peekMailbox.mockResolvedValue({ turns: [], stopped: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      const [turn] = hook.result.current.state.queued;
      expect(turn!.read).toBe(true);
      // NOT removed. The transcript is a record, and the turn the run took is
      // exactly the one worth still seeing.
      expect(turn!.text).toBe('Also drop the narration card.');

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays UNREAD while the turn is still waiting', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await hook.result.current.send('Also drop the narration card.', TARGETS);
      });

      peekMailbox.mockResolvedValue({
        turns: [
          {
            id: 'm1',
            text: 'Also drop the narration card.',
            receivedAt: 'x',
            disposition: 'fold',
            target: null,
          },
        ],
        stopped: false,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6200);
      });

      expect(hook.result.current.state.queued[0]!.read).toBe(false);

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠️ asks NOTHING on an ordinary run — the poll is bounded by its own condition', async () => {
    // The property that makes a poll acceptable here. Nobody typed anything, so
    // there is nothing unread and no request is made at all.
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(peekMailbox).not.toHaveBeenCalled();

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking once everything queued has been read', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await hook.result.current.send('Also drop the narration card.', TARGETS);
      });

      peekMailbox.mockResolvedValue({ turns: [], stopped: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      const afterRead = peekMailbox.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      // The LAST READ stops it, not a timeout.
      expect(peekMailbox.mock.calls.length).toBe(afterRead);

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the queue is per-RUN — a new run starts with an empty one', async () => {
    const hook = await mounted();
    const first = await running(hook);
    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });
    expect(hook.result.current.state.queued).toHaveLength(1);
    await act(async () => {
      first.release();
      await first.promise;
    });

    streamContextual.mockResolvedValue(undefined);
    await act(async () => {
      await hook.result.current.send('A whole new request.', TARGETS);
    });

    // Carrying them over would show the user sentences that can never be read
    // again — the previous job's mailbox is not this one's.
    expect(hook.result.current.state.queued).toEqual([]);
  });
});

describe('A REFUSAL IS LEGIBLE', () => {
  it('an UNTYPED failure still says something — `MAILBOX_FAILED`, not silence', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn.mockRejectedValue(new Error('network'));

    await act(async () => {
      await hook.result.current.send('Also drop it.', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBe('MAILBOX_FAILED');
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.phase).toBe('streaming');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('an ABORTED send is not an error — nothing is written', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn.mockRejectedValue(new DOMException('gone', 'AbortError'));

    await act(async () => {
      await hook.result.current.send('Also drop it.', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.queued).toEqual([]);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('surfaces the door’s typed code when the run settled between render and send', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn.mockRejectedValue(
      new PlanEditsClientError(409, 'PLAN_CHANGE_JOB_NOT_RUNNING'),
    );

    await act(async () => {
      await hook.result.current.send('Too late.', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBe('PLAN_CHANGE_JOB_NOT_RUNNING');
    // The THREAD is untouched: a state conflict on one turn is not a failure of
    // the conversation, and nothing queued was invented.
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.phase).toBe('streaming');

    await act(async () => {
      release();
      await promise;
    });
  });
});
