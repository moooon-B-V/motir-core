// Node-only motir-ai LESSON-LIBRARY boundary mock for E2E (Subtask MOTIR-3340).
//
// The library crosses the motir-core → motir-ai seam on every screen it has, and
// NONE of those crossings is reachable from a browser-level `page.route`:
//
//   - the AI-planning page's door card is SERVER rendered
//     (`projectLessonsService.listLessons` inside the Next server);
//   - `/settings/project/ai-planning/lessons` and its detail are Server
//     Components doing the same.
//
// So this is that seam, in the SAME shape `test-code-health-mock` already uses:
// an undici intercept installed by `instrumentation.ts` behind an
// `E2E_TEST_LESSONS=1` env gate, dormant everywhere else.
//
// ⚠️ IT IS A TRANSPORT MOCK, NOT A SERVICE MOCK, and that is the point. The real
// `motirAiClient` builds the URL, sends the real bearer and parses a real
// Response; the real `projectLessonsService` asserts `lesson:view` before any of
// it and applies its own tenant narrowing afterwards. A mocked client would
// prove the pages render given a well-behaved one and say nothing about the
// guard or the boundary — which are most of what the story is.
//
// State comes from a JSON FIXTURE FILE (`MOTIR_AI_LESSONS_FIXTURE_PATH`),
// re-read on EVERY request, so a spec can rewrite it mid-run — a project with
// lessons and the same project with none are both real screens, and the empty
// one is what most projects see for weeks.
//
// ── THE CAPTURE GATE (Story MOTIR-3331 · Subtask MOTIR-3353) ────────────────
//
// This seam also answers `POST /v1/jobs`, and it does one thing with it that a
// plain 202 would not: it MODELS motir-ai's capture gate. The envelope carries
// `context.recordPlanningMistakes` (MOTIR-3350); unless that field is explicitly
// `false`, the submit APPENDS a captured lesson to the fixture — the store —
// exactly as a planning run that corrected itself would.
//
// ⚠️ WHAT THAT MAKES REAL, AND WHAT IT DOES NOT. Everything on motir-core's side
// is the shipped code: the toggle writes through the real PATCH, the real
// `projectAiSettingsService` persists it, `resolveRecordPlanningMistakesForJob`
// reads it back at submit time, and the real `motirAiClient` serializes the
// envelope. What is SIMULATED is motir-ai's own decision, because motir-ai does
// not run in this lane — and that decision has its own tests over there
// (`lessonCaptureConsent`, `lessonCaptureEnvelopeContract`).
//
// So the property this seam lets a browser-level spec prove is the one no other
// test covers: that the switch a person flips in the interface reaches the wire.
// The gate is written here as motir-ai writes it — ABSENT MEANS ON, only an
// explicit `false` disables — so a spec asserting "nothing was recorded" is
// asserting against a store that would have grown had the flag not arrived.

import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import { observeAiJobSubmit } from '@/lib/test-ai-jobs-mock';
import type { MockAgent } from 'undici';

/** One lesson, in motir-ai's WIRE shape (what `RawLesson` parses). */
export interface LessonFixtureRow {
  id: string;
  title: string;
  body?: string;
  why?: string;
  howToApply?: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  sourceRef?: string | null;
  lastOccurredAt?: string;
  recurrenceCount?: number;
  /** Absent ⇒ applied. Otherwise the reason it is not. */
  injectionBlock?: 'disabled' | 'not_recurred';
  /** A person's standing decision (MOTIR-3330) — written by the retire/apply
   *  intercepts below, and read back by every later request. */
  humanOverride?: 'retired' | 'exempt' | null;
  humanOverrideAt?: string | null;
  humanOverrideBy?: string | null;
}

export interface LessonsFixture {
  lessons: LessonFixtureRow[];
  /** Defaults to the lesson count — a spec can set it to prove the door quotes
   *  the LIBRARY total rather than the page it was handed. */
  total?: number;
  retentionDays?: number;
}

const json: { headers: Record<string, string> } = {
  headers: { 'content-type': 'application/json' },
};
const problemJson: { headers: Record<string, string> } = {
  headers: { 'content-type': 'application/problem+json' },
};

function readFixture(): LessonsFixture {
  const p = process.env['MOTIR_AI_LESSONS_FIXTURE_PATH'];
  if (!p) return { lessons: [] };
  try {
    return JSON.parse(readFixtureFileSync(p)) as LessonsFixture;
  } catch {
    // An unreadable/absent fixture reads as "this project has no lessons" — the
    // EMPTY STATE, which is a legible screen rather than a 500 from the
    // boundary. A spec that forgot its fixture sees the empty state, not a
    // crash it has to diagnose.
    return { lessons: [] };
  }
}

/** The wire row, defaulted — every field the surface reads is always present. */
function toWire(row: LessonFixtureRow, retentionDays: number) {
  const block = row.injectionBlock ?? null;
  return {
    id: row.id,
    // `scope` is asserted by motir-core's own narrowing, so the mock states it:
    // a fixture row is one of THIS project's lessons.
    scope: 'tenant',
    aiProjectId: 'ai_e2e',
    mistakeType: 'regular_planning',
    title: row.title,
    body: row.body ?? `${row.title} — what happened`,
    why: row.why ?? `${row.title} — why it matters`,
    howToApply: row.howToApply ?? `${row.title} — how to apply it`,
    categories: [],
    kinds: row.kinds ?? [],
    types: row.types ?? [],
    phases: row.phases ?? [],
    sourceRef: row.sourceRef ?? null,
    enabled: block !== 'disabled',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastOccurredAt: row.lastOccurredAt ?? '2026-08-21T00:00:00.000Z',
    recurrenceCount: row.recurrenceCount ?? 1,
    injected: block === null,
    injectionBlock: block,
    humanOverride: row.humanOverride ?? null,
    humanOverrideAt: row.humanOverrideAt ?? null,
    humanOverrideBy: row.humanOverrideBy ?? null,
    retentionDays,
  };
}

/**
 * Persist a mutated fixture, so the write is DURABLE across requests.
 *
 * ⚠️ This is what makes the E2E's no-flicker assertion mean anything. The
 * control keeps the response locally AND calls `router.refresh()`; if the mock
 * answered the write from memory and the next GET re-read an unchanged fixture,
 * the row would visibly revert — which is the exact bug the spec is watching
 * for, arriving from the test harness rather than from the product.
 */
function writeFixture(fixture: LessonsFixture): void {
  const p = process.env['MOTIR_AI_LESSONS_FIXTURE_PATH'];
  if (!p) return;
  writeFixtureFileSync(p, JSON.stringify(fixture, null, 2));
}

function pathOnly(p: string): string {
  return p.includes('?') ? p.slice(0, p.indexOf('?')) : p;
}

function limitOf(p: string): number | null {
  const q = p.includes('?') ? p.slice(p.indexOf('?') + 1) : '';
  const raw = new URLSearchParams(q).get('limit');
  return raw === null ? null : Number(raw);
}

/**
 * The retire / apply WRITE, with motir-ai's own rule for what `apply` means.
 *
 * ⚠️ The rule is reproduced here rather than parameterised, because it is the
 * thing under test at the product level: `apply` CLEARS the retirement on a row
 * somebody switched off, and EXEMPTS a row the clock aged out — the two
 * not-applied rows §L6 draws, which need opposite writes. A mock that took the
 * value from the request would let the browser choose it, and the spec would
 * then pass over a client that had implemented the state machine it must not.
 */
function applyWrite(
  fixture: LessonsFixture,
  row: LessonFixtureRow,
  action: 'retire' | 'apply',
  actorId: string,
): void {
  if (action === 'retire') {
    row.humanOverride = 'retired';
    row.humanOverrideAt = '2026-08-23T12:00:00.000Z';
    row.humanOverrideBy = actorId;
    row.injectionBlock = 'disabled';
  } else if (row.injectionBlock === 'not_recurred') {
    // Aged out: clearing alone would leave it exactly where it was, so the
    // decision is recorded as an exemption and the row returns to applied.
    row.humanOverride = 'exempt';
    row.humanOverrideAt = '2026-08-23T12:00:00.000Z';
    row.humanOverrideBy = actorId;
    delete row.injectionBlock;
  } else {
    row.humanOverride = null;
    row.humanOverrideAt = null;
    row.humanOverrideBy = null;
    delete row.injectionBlock;
  }
  writeFixture(fixture);
}

/**
 * Record the lesson a planning run's correction would have captured.
 *
 * Extracted (MOTIR-4137) because it now has TWO callers — this seam's own
 * `POST /v1/jobs` interceptor, and the observer it attaches to the jobs seam
 * when that one owns the protocol. One body, so the two paths cannot drift.
 */
function captureLesson(): void {
  const fixture = readFixture();
  const n = fixture.lessons.length + 1;
  writeFixture({
    ...fixture,
    lessons: [
      ...fixture.lessons,
      {
        id: `les_captured_${n}`,
        title: `Captured from a planning run (${n})`,
        body: 'The planner corrected itself during this run.',
        why: 'Recorded because this project has recording switched on.',
        howToApply: 'Do the thing the correction implies.',
      },
    ],
    // The library total tracks the rows this seam actually holds; a spec that
    // pinned `total` separately keeps its own number.
    ...(fixture.total === undefined ? {} : { total: fixture.total + 1 }),
  });
}

/**
 * motir-ai's gate, verbatim in its polarity: only an explicit `false` disables.
 * An ABSENT field means the producer predates the contract, which reads as ON —
 * so a spec that forgot to send it does NOT accidentally assert the gated path.
 */
function envelopeAllowsCapture(rawBody: string): boolean {
  try {
    const body = JSON.parse(rawBody) as { context?: { recordPlanningMistakes?: unknown } };
    return body.context?.recordPlanningMistakes !== false;
  } catch {
    return true;
  }
}

export function installLessonsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // POST /v1/lessons/:id/{retire,apply} — the WRITE (Subtask MOTIR-3346's seam;
  // the endpoints are MOTIR-3344's). Registered before the GETs so the path
  // predicates below cannot claim them.
  pool
    .intercept({
      path: (p) => /^\/v1\/lessons\/[^/?]+\/(retire|apply)$/.test(pathOnly(p)),
      method: 'POST',
    })
    .reply(
      (
        req,
      ): {
        statusCode: number;
        data: object;
        responseOptions: { headers: Record<string, string> };
      } => {
        const fixture = readFixture();
        const parts = pathOnly(req.path).split('/');
        const id = decodeURIComponent(parts[3] ?? '');
        const action = parts[4] === 'retire' ? 'retire' : 'apply';
        const row = fixture.lessons.find((l) => l.id === id);
        if (!row) {
          return {
            statusCode: 404,
            data: { code: 'not_found', title: 'not_found', status: 404, detail: 'no such lesson' },
            responseOptions: problemJson,
          };
        }
        const body = (() => {
          try {
            return JSON.parse(String(req.body ?? '{}')) as { actorId?: string };
          } catch {
            return {};
          }
        })();
        applyWrite(fixture, row, action, body.actorId ?? 'unknown');
        return {
          statusCode: 200,
          data: toWire(row, fixture.retentionDays ?? 90),
          responseOptions: json,
        };
      },
    )
    .persist();

  // GET /v1/lessons/:id — the DETAIL. Registered after the writes: undici matches
  // interceptors in registration order, and the list's path predicate would
  // otherwise swallow every detail request (both start `/v1/lessons`).
  pool
    .intercept({
      path: (p) => /^\/v1\/lessons\/[^/?]+/.test(pathOnly(p)),
      method: 'GET',
    })
    .reply(
      (
        req,
      ): {
        statusCode: number;
        data: object;
        responseOptions: { headers: Record<string, string> };
      } => {
        const fixture = readFixture();
        const id = decodeURIComponent(pathOnly(req.path).split('/')[3] ?? '');
        const row = fixture.lessons.find((l) => l.id === id);
        if (!row) {
          // The same `not_found` motir-ai raises for an unknown id AND for another
          // project's — indistinguishable by construction, which is the posture
          // the endpoint documents for itself.
          return {
            statusCode: 404,
            data: { code: 'not_found', title: 'not_found', status: 404, detail: 'no such lesson' },
            responseOptions: problemJson,
          };
        }
        return {
          statusCode: 200,
          data: toWire(row, fixture.retentionDays ?? 90),
          responseOptions: json,
        };
      },
    )
    .persist();

  // GET /v1/lessons — one PAGE, plus the library's counts.
  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/lessons', method: 'GET' })
    .reply((req) => {
      const fixture = readFixture();
      const retentionDays = fixture.retentionDays ?? 90;
      const limit = limitOf(req.path);
      const page = limit === null ? fixture.lessons : fixture.lessons.slice(0, limit);
      return {
        statusCode: 200,
        data: {
          lessons: page.map((row) => toWire(row, retentionDays)),
          nextCursor: null,
          // `total` is the LIBRARY, deliberately settable apart from the page —
          // it is what the door's "View all N lessons" quotes, and a mock that
          // derived it from the page could not fail the way the product would.
          total: fixture.total ?? fixture.lessons.length,
          applied: fixture.lessons.filter((l) => !l.injectionBlock).length,
          staleCutoff: '2026-05-23T00:00:00.000Z',
          retentionDays,
        },
        responseOptions: json,
      };
    })
    .persist();

  // ── The planning submit, and the CAPTURE it would produce ────────────────
  //
  // The CAPTURE belongs to this seam — the thing under test is what a submit
  // does to the LESSON STORE, and this module owns that store. The `/v1/jobs`
  // PROTOCOL does not: it belongs to `test-ai-jobs-mock`, which mints a job id
  // carrying the job's KIND and settles each kind with its own result shape.
  //
  // ⚠️ THIS SEAM USED TO CLAIM BOTH, AND THAT REDDENED `main` (MOTIR-4137). It
  // registered its own `/v1/jobs` interceptors here; undici matches in
  // REGISTRATION ORDER and `instrumentation.ts` installs this seam before the
  // jobs seam, so with both flags on the jobs seam's replies were unreachable
  // and every caller got the constant `job_lessons_e2e` id and an empty
  // `{ operations: [] }` result. Nothing noticed while the two flags lived in
  // different lanes — until MOTIR-4094 promoted `cloud-ask-about-this-project`
  // into the cloud lane, which sets BOTH, and the ask journey (whose three
  // crossings all read the jobs protocol) went silent on every turn.
  //
  // So the split is now by SUBJECT rather than by registration order: when the
  // jobs seam is installed it answers, and this seam attaches the write as an
  // OBSERVER. The interceptors below remain for the lanes that turn lessons on
  // WITHOUT the jobs seam, where their stated job — keeping a planning submit
  // from escaping to an unresolvable host mid-walk — is still the whole point.
  if (process.env['E2E_TEST_AI_JOBS'] === '1') {
    observeAiJobSubmit((rawBody) => {
      if (envelopeAllowsCapture(rawBody)) captureLesson();
    });
    return;
  }

  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/jobs', method: 'POST' })
    .reply((req) => {
      if (envelopeAllowsCapture(String(req.body ?? '{}'))) captureLesson();
      return { statusCode: 202, data: { jobId: 'job_lessons_e2e' }, responseOptions: json };
    })
    .persist();

  // The two reads a submit's caller makes afterwards. Minimal on purpose — this
  // seam is not the jobs seam, and a spec that needs a real generation stream
  // uses `E2E_TEST_AI_JOBS` (and gets that seam's replies, per the guard above).
  pool
    .intercept({ path: (p) => /^\/v1\/jobs\/[^/?]+\/stream/.test(pathOnly(p)), method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: 'event: done\ndata: {"status":"succeeded"}\n\n',
      responseOptions: { headers: { 'content-type': 'text/event-stream' } },
    }))
    .persist();

  pool
    .intercept({ path: (p) => /^\/v1\/jobs\/[^/?]+$/.test(pathOnly(p)), method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: { jobId: 'job_lessons_e2e', status: 'succeeded', result: { operations: [] } },
      responseOptions: json,
    }))
    .persist();
}
