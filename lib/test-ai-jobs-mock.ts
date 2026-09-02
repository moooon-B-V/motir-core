// Node-only motir-ai JOBS boundary mock for E2E (Story MOTIR-1343 · MOTIR-1823).
//
// The ask journey crosses the motir-core → motir-ai seam THREE times, and only
// one of the three is reachable from a browser-level `page.route`:
//
//   - `POST /api/ai/ask` calls `submitJob` inside the Next server;
//   - `GET  /api/ai/ask/:jobId/stream` RELAYS `streamJob` — the browser sees the
//     relay, not the upstream;
//   - `POST /api/ai/ask/settle` calls `getJob` inside the Next server.
//
// A spec could stub the two core ROUTES at the browser boundary, and that is
// what the shipped plan-change spec does for its single submit. It does not
// work here, and the reason is the assertion this card exists for: **step 4
// reloads the workspace and expects the answer to still be on the thread.** An
// answer the browser faked was never written, so a stub at that boundary would
// make the persistence claim untestable by the very spec that has to prove it.
//
// So this mock sits UNDER the routes, at the same seam `test-code-health-mock` /
// `test-billing-mock` use: an undici intercept installed by `instrumentation.ts`
// behind an `E2E_TEST_AI_JOBS=1` env gate, dormant everywhere else. The real
// route, the real service, the real repository and the real Postgres all run.
//
// What it intercepts (on the MOTIR_AI_URL origin the E2E lane points at — an
// unresolvable host, so a MISSING intercept fails loud rather than escaping):
//   - POST /v1/jobs                 → `{ jobId }`, and RECORDS the kind it was
//     asked for, which is how a spec proves an ask ran an `ask_project` job and
//     a plan change ran the shipped `augment` one.
//   - GET  /v1/jobs/:id             → the settled result, from the fixture.
//   - GET  /v1/jobs/:id/stream      → the SSE the relay forwards.
//
// The fixture is a JSON FILE (MOTIR_AI_JOBS_FIXTURE_PATH), re-read on EVERY
// request, so a spec can rewrite it between turns — one question answers with
// citations, the next answers honestly with none, the third redirects to a plan
// change — without a second harness and without a timing assumption.

import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

/** What the next `ask_project` job should settle as. */
export interface AskJobOutcome {
  intent: 'ask' | 'plan_change';
  answer?: string | null;
  citations?: string[];
}

export interface AiJobsFixture {
  /**
   * The `ask_project` outcomes, CONSUMED IN ORDER — one per ask job submitted.
   * The last entry repeats once the queue is exhausted, so a spec only declares
   * the turns it actually cares about.
   */
  ask?: AskJobOutcome[];
  /** Appended to by the mock: the job kind of every submit, in order. */
  submitted?: { kind: string }[];
}

const json = { headers: { 'content-type': 'application/json' } } as const;

function fixturePath(): string | null {
  return process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? null;
}

function readFixture(): AiJobsFixture {
  const p = fixturePath();
  if (!p) return {};
  try {
    return JSON.parse(readFixtureFileSync(p)) as AiJobsFixture;
  } catch {
    // An unreadable/absent fixture reads as "nothing declared" rather than
    // throwing: the ask then settles as an answer with no citations, which is a
    // legible surface instead of a 500 from the boundary.
    return {};
  }
}

/** Record a submit so the SPEC can read back which job kinds actually ran. */
function recordSubmit(kind: string): number {
  const p = fixturePath();
  const f = readFixture();
  const index = (f.submitted ?? []).filter((s) => s.kind === kind).length;
  if (!p) return index;
  try {
    f.submitted = [...(f.submitted ?? []), { kind }];
    writeFixtureFileSync(p, JSON.stringify(f, null, 2));
  } catch {
    // Recording is diagnostic only — never fail the request over it.
  }
  return index;
}

/** The ask outcome for the `n`-th ask job, with the last entry repeating. */
function askOutcomeAt(n: number): AskJobOutcome {
  const queue = readFixture().ask ?? [];
  if (queue.length === 0) return { intent: 'ask', answer: 'No answer was declared.' };
  return queue[Math.min(n, queue.length - 1)]!;
}

/** A job id that CARRIES its kind and ordinal, so a failure names what it was. */
function jobIdFor(kind: string, index: number): string {
  return `e2e-${kind}-${index}`;
}

function kindOf(jobId: string): { kind: string; index: number } {
  const m = /^e2e-(.+)-(\d+)$/.exec(jobId);
  return m ? { kind: m[1]!, index: Number(m[2]) } : { kind: 'unknown', index: 0 };
}

/**
 * A side effect ANOTHER seam wants on a `POST /v1/jobs`, without intercepting it.
 *
 * ⚠️ THIS EXISTS BECAUSE TWO SEAMS CANNOT SHARE ONE UNDICI PATH (MOTIR-4137).
 * `test-lessons-mock` used to register its own `/v1/jobs` interceptors on this
 * same origin to record a lesson capture. undici matches interceptors in
 * REGISTRATION ORDER and `instrumentation.ts` installs the lessons seam first,
 * so with both flags on the lessons seam answered the whole jobs protocol —
 * a constant `job_lessons_e2e` id and a `{ operations: [] }` result — and this
 * seam's own replies were unreachable. The ask journey reads its outcome out of
 * the job id and the settled `result`, so it went silent on every turn.
 *
 * An observer is the shape that cannot regress that way: it names the effect a
 * neighbouring seam needs (the write) without claiming the reply (the protocol),
 * so the two are no longer competing for the same interceptor.
 */
type JobSubmitObserver = (rawBody: string) => void;

const submitObservers: JobSubmitObserver[] = [];

/** Attach a side effect to every `POST /v1/jobs` this seam answers. */
export function observeAiJobSubmit(observer: JobSubmitObserver): void {
  submitObservers.push(observer);
}

function notifySubmitObservers(rawBody: string): void {
  for (const observe of submitObservers) {
    try {
      observe(rawBody);
    } catch {
      // An observer is a neighbouring seam's bookkeeping — never fail the
      // request (and never skip the remaining observers) over it.
    }
  }
}

export function installAiJobsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // POST /v1/jobs — accept any kind and answer with an id that encodes it.
  pool
    .intercept({ path: (p) => p === '/v1/jobs' || p.startsWith('/v1/jobs?'), method: 'POST' })
    .reply((req) => {
      const rawBody = String(req.body ?? '{}');
      let kind = 'unknown';
      try {
        kind = (JSON.parse(rawBody) as { jobKind?: string }).jobKind ?? 'unknown';
      } catch {
        kind = 'unknown';
      }
      notifySubmitObservers(rawBody);
      const index = recordSubmit(kind);
      return { statusCode: 202, data: { jobId: jobIdFor(kind, index) }, responseOptions: json };
    })
    .persist();

  // GET /v1/jobs/:id/stream — the SSE the relay forwards to the rail.
  //
  // ⚠️ It carries the REAL frame vocabulary rather than assistant tokens: the
  // stream is NOT the answer (the settle is), so what a spec should see here is
  // a run progressing and closing, exactly as motir-ai sends it.
  pool
    .intercept({ path: (p) => /^\/v1\/jobs\/[^/]+\/stream(\?|$)/.test(p), method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: `event: search\ndata: {}\n\nevent: done\ndata: {}\n\n`,
      responseOptions: { headers: { 'content-type': 'text/event-stream' } },
    }))
    .persist();

  // GET /v1/jobs/:id — the settled result. `ask_project` reads its outcome from
  // the fixture queue; every other kind settles as a plain success, which is
  // what the shipped plan-change path expects (its proposals arrive through the
  // Plan, never through the job result).
  pool
    .intercept({ path: (p) => /^\/v1\/jobs\/[^/]+(\?|$)/.test(p), method: 'GET' })
    .reply((req) => {
      const id = decodeURIComponent(req.path.split('?')[0]!.split('/').pop()!);
      const { kind, index } = kindOf(id);
      // ONE shape for both arms. undici infers the reply type from what this
      // callback returns, so two differently-shaped `result` objects leave the
      // overload unresolvable — and a `result` that is sometimes absent is
      // exactly what the ENVELOPE contract says anyway (per-kind, additive).
      const outcome = askOutcomeAt(index);
      const result: Record<string, unknown> =
        kind === 'ask_project'
          ? {
              ask: {
                intent: outcome.intent,
                answer: outcome.answer ?? null,
                citations: outcome.citations ?? [],
              },
            }
          : {};
      return {
        statusCode: 200,
        data: { status: 'succeeded', result },
        responseOptions: json,
      };
    })
    .persist();
}
