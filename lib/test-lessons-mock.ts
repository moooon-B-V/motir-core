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

import { readFixtureFileSync } from '@/lib/test-fixture-file';
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
    retentionDays,
  };
}

function pathOnly(p: string): string {
  return p.includes('?') ? p.slice(0, p.indexOf('?')) : p;
}

function limitOf(p: string): number | null {
  const q = p.includes('?') ? p.slice(p.indexOf('?') + 1) : '';
  const raw = new URLSearchParams(q).get('limit');
  return raw === null ? null : Number(raw);
}

export function installLessonsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // GET /v1/lessons/:id — the DETAIL. Registered FIRST: undici matches
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
}
