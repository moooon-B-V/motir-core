// Node-only motir-ai CODE-HEALTH boundary mock for E2E (MOTIR-2253).
//
// The audit-coverage journey (MOTIR-2244) crosses the motir-core → motir-ai seam
// TWICE, and neither crossing is reachable from a browser-level `page.route`:
//
//   - `/code-health` is SERVER rendered — `loadCodeHealthSurfaces` calls
//     `motirAiClient.getCodeAudit` / `getConvention` inside the Next server;
//   - the trigger POSTs through a route handler that calls `refreshCodeAudit`,
//     again server-side.
//
// So the spec's `page.route` can seed the `/planning` banner (a client island
// that fetches its own state) and NOTHING on `/code-health`. This is that seam,
// the SAME shape `test-billing-mock` / `test-oauth-mock` / `test-blob-mock`
// already use: an undici intercept installed by `instrumentation.ts` behind an
// `E2E_TEST_CODE_HEALTH=1` env gate, dormant everywhere else.
//
// What it intercepts (on the MOTIR_AI_URL origin the E2E lane points at — an
// unresolvable host, so a MISSING intercept fails loud rather than escaping):
//   - GET  /v1/code-audit           → one repo's audit surface
//   - GET  /v1/convention           → the empty convention surface
//   - POST /v1/code-context/refresh → the queued { auditJobId, conventionJobId }
//
// PER-REPO state comes from a JSON FIXTURE FILE (MOTIR_AI_CODE_HEALTH_FIXTURE_PATH),
// re-read on EVERY request — so a spec can REWRITE it mid-test (a repo goes from
// never-audited to audited) and assert the page reflects it on its next
// authoritative read, with no optimistic-UI race.
//
// The fixture also RECORDS every refresh it received, so a spec can assert which
// repos a press actually paid to derive — the one fact this story turns on —
// read back from the server side rather than inferred from the browser.

import { readFileSync, writeFileSync } from 'node:fs';
import type { MockAgent } from 'undici';

/** One repo's state, as the fixture declares it. */
export interface CodeHealthFixtureRepo {
  /** `owner/name`. */
  repoKey: string;
  /** Has a derived audit? Absent/false ⇒ the never-audited surface. */
  audited?: boolean;
  grade?: string;
  conformancePct?: number;
  findingCount?: number;
}

export interface CodeHealthFixture {
  repos: CodeHealthFixtureRepo[];
  /** Appended to by the mock: one entry per refresh, in order. */
  refreshes?: { repoRef: string | null }[];
}

const json = { headers: { 'content-type': 'application/json' } } as const;

function fixturePath(): string | null {
  return process.env['MOTIR_AI_CODE_HEALTH_FIXTURE_PATH'] ?? null;
}

function readFixture(): CodeHealthFixture {
  const p = fixturePath();
  if (!p) return { repos: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CodeHealthFixture;
  } catch {
    // An unreadable/absent fixture reads as "no repo has an audit" rather than
    // throwing — a spec that forgot to write one gets the empty surface, which
    // is a legible failure instead of a 500 from the boundary.
    return { repos: [] };
  }
}

/** Append a refresh to the fixture so the SPEC can read back what was queued. */
function recordRefresh(repoRef: string | null): void {
  const p = fixturePath();
  if (!p) return;
  try {
    const f = readFixture();
    f.refreshes = [...(f.refreshes ?? []), { repoRef }];
    writeFileSync(p, JSON.stringify(f, null, 2));
  } catch {
    // Recording is diagnostic only — never fail the request over it.
  }
}

function queryParam(path: string, name: string): string | null {
  const q = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  return new URLSearchParams(q).get(name);
}

/** motir-ai's real `GET /v1/code-audit` body (`RawCodeAuditSurface`). */
function auditSurfaceFor(repoKey: string | null) {
  const entry = readFixture().repos.find((r) => r.repoKey === repoKey);
  if (!entry?.audited) {
    // A SUCCESSFUL read of a repo with nothing derived — never an error. This is
    // the distinction the whole story turns on.
    return { audit: null, findings: [], total: 0, nextOffset: null };
  }
  return {
    audit: {
      id: `audit_${repoKey}`,
      aiProjectId: 'ai_e2e',
      healthSummary: {
        grade: entry.grade ?? 'B',
        conformancePct: entry.conformancePct ?? 78,
      },
      codeGraphRef: repoKey,
      repoKey,
      jobId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total: entry.findingCount ?? 12,
    nextOffset: null,
  };
}

export function installCodeHealthBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // GET /v1/code-audit — ONE repo's surface. The page reads it once per
  // connected repo, so the fixture is what makes a project partly audited.
  pool
    .intercept({ path: (p) => p.startsWith('/v1/code-audit'), method: 'GET' })
    .reply((req) => ({
      statusCode: 200,
      data: auditSurfaceFor(queryParam(req.path, 'repoKey')),
      responseOptions: json,
    }))
    .persist();

  // GET /v1/convention — the empty surface. This story never renders the
  // Convention tab, but the page reads it per repo, so it must answer.
  pool
    .intercept({ path: (p) => p.startsWith('/v1/convention'), method: 'GET' })
    .reply(200, { convention: null, versions: [], nextCursor: null }, json)
    .persist();

  // POST /v1/code-context/refresh — the derivation trigger. One call per TARGET
  // repo (the fan-out lives in motir-core), so the recorded `repoRef` sequence
  // IS the answer to "which repos did that press pay for".
  pool
    .intercept({ path: '/v1/code-context/refresh', method: 'POST' })
    .reply((req) => {
      let repoRef: string | null = null;
      try {
        const body = JSON.parse(String(req.body ?? '{}')) as {
          context?: { code?: { repoRef?: string } };
        };
        repoRef = body.context?.code?.repoRef ?? null;
      } catch {
        repoRef = null;
      }
      recordRefresh(repoRef);
      return {
        statusCode: 200,
        data: {
          auditJobId: `job_audit_${repoRef ?? 'all'}`,
          conventionJobId: `job_conv_${repoRef ?? 'all'}`,
        },
        responseOptions: json,
      };
    })
    .persist();
}
