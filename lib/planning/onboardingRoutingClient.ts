import {
  readOnboardingRoutingVerdict,
  type OnboardingRoutingRead,
} from '@/lib/dto/onboardingRouting';

// THE ROUTING RUN, from the browser (Story MOTIR-4753 · MOTIR-4769).
//
// The plan window has just opened on a project whose first plan has never been
// approved. Ask for a verdict, watch the job, and hand back what it decided.
//
// ⚠️ POLLED RATHER THAN STREAMED, deliberately. The generation stream exists to
// show `add` PlanItems appearing live; this run appends nothing — it halts with
// one answer (MOTIR-4767) — so there is no intermediate state to watch and a
// stream would be a subscription to a single event.
//
// ⚠️ EVERY FAILURE FALLS THROUGH TO THE WORKSPACE, and none of them routes
// anybody. A job that failed, a request that never came back, a browser that
// went offline: none of those is a finding about the project, and turning one
// into an onboarding hand-off would move a user on the strength of a network
// error. The window opens and the session behaves as it would for any project —
// which is the outcome the user asked for by pressing the button.

/** How the routing run ended, as the surface reads it. */
export type OnboardingRoutingResolution =
  /** A verdict arrived and could be read. */
  | { kind: 'verdict'; read: OnboardingRoutingRead }
  /**
   * Nothing decided anybody's route — the run failed, was refused, or this
   * project had nothing to decide. The window is a workspace.
   */
  | { kind: 'none'; reason: string };

const NONE = (reason: string): OnboardingRoutingResolution => ({ kind: 'none', reason });

/** How long to wait between job polls, and how long to keep asking. */
export const ROUTING_POLL_INTERVAL_MS = 1_200;
export const ROUTING_POLL_TIMEOUT_MS = 90_000;

/**
 * Ask for the verdict and wait for it.
 *
 * Never throws: every path an error can take ends in a `none`, because the
 * caller's only two options are *route the user* and *open the workspace*, and
 * an error is never evidence for the first.
 */
export async function resolveOnboardingRouting(opts: {
  signal?: AbortSignal;
  /** Injected so a test can drive the clock rather than wait on it. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<OnboardingRoutingResolution> {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + ROUTING_POLL_TIMEOUT_MS;

  let jobId: string | null;
  try {
    const res = await fetch('/api/ai/plan/route-onboarding', {
      method: 'POST',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return NONE(`dispatch failed: ${res.status}`);
    jobId = ((await res.json()) as { jobId?: string | null }).jobId ?? null;
  } catch {
    return NONE('dispatch failed');
  }
  // An established project answers `null` — there is no route to decide, and
  // that is not a failure.
  if (!jobId) return NONE('nothing to decide');

  while (now() < deadline) {
    if (opts.signal?.aborted) return NONE('aborted');
    let body: { status?: string; result?: unknown };
    try {
      const res = await fetch(`/api/ai/jobs/${encodeURIComponent(jobId)}`, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) return NONE(`job read failed: ${res.status}`);
      body = (await res.json()) as { status?: string; result?: unknown };
    } catch {
      return NONE('job read failed');
    }
    if (body.status === 'failed' || body.status === 'cancelled') {
      return NONE(`job ${body.status}`);
    }
    if (body.status === 'succeeded') {
      const read = readOnboardingRoutingVerdict(body.result);
      // A SUCCEEDED run carrying no verdict is a run that was never asked for
      // one — an established project, or a producer that predates the field.
      // Not a refusal, and not a reason to move anybody.
      return read ? { kind: 'verdict', read } : NONE('no verdict on the envelope');
    }
    await sleep(ROUTING_POLL_INTERVAL_MS);
  }
  // ⚠️ A TIMEOUT OPENS THE WORKSPACE. The alternative is a reading state that
  // never resolves, which is the one outcome worse than an unrouted user: they
  // pressed *Plan with AI* and would be left watching a sentence forever.
  return NONE('timed out');
}
