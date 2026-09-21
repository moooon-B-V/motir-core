import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE GUARDS COVERAGE CANNOT SEE on the bug ENRICHMENT surface (Story MOTIR-4930 ·
// Subtask MOTIR-5852) — structural facts that no unit test would notice breaking,
// because each is the ABSENCE of a second way to do something, or a thing that
// must stay exactly as it is.
//
// ⚠️ REGISTERED IN THE STRUCTURAL-GUARD LANE (`tests/helpers/structuralGuardLane.ts`)
// and driven by `pnpm test:guards`. A guard file run by the ordinary suite executes
// nothing and exits 0, so the lane's Test Files count is what proves these ran.
//
// Text scans only: no database, no render, only `node:fs` / `node:path` /
// `node:crypto` — the lane's profile.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Strip `//` and block comments, so prose that NAMES a call is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SERVICE = 'lib/services/monitorBugEnrichmentService.ts';
const JOB = 'lib/jobs/definitions/monitorBugEnrich.ts';
const ANSWER = 'lib/ai/authoredBug.ts';
const INGESTION = 'lib/services/monitorIngestionService.ts';
const SURFACE = [SERVICE, JOB, ANSWER];

/** The body of `applyAuthoredBug` — from its signature to the object's close. */
function applyBody(): string {
  const src = code(read(SERVICE));
  const start = src.indexOf('async applyAuthoredBug(');
  expect(start, 'applyAuthoredBug not found — the guard would read nothing').toBeGreaterThan(-1);
  return src.slice(start);
}

describe('the enrichment surface — what coverage cannot see', () => {
  it('GUARD 1 — the write is decided by BODY EQUALITY, never by a remembered flag (deleted ⇒ the guarantee can drift from the card)', () => {
    const body = applyBody();
    // The decision reads the body the item was created with…
    expect(body).toContain('findCreatedDescription(');
    expect(body).toMatch(/bug\.descriptionMd !== filedBody/);
    // …and consults NO enrichment column, flag or timestamp to decide.
    for (const remembered of ['authoringJobId', 'enrichedAt', 'authoredAt', 'isEnriched']) {
      expect(body, remembered).not.toContain(remembered);
    }
  });

  it('GUARD 2 — nothing in the surface transitions, re-parents or links (deleted ⇒ enrichment could reshape the tree)', () => {
    for (const file of SURFACE) {
      const src = code(read(file));
      for (const call of [
        'transitionStatus(',
        'applyTransition(',
        'moveToParent(',
        'linkWorkItems(',
        'unlinkWorkItems(',
        'workItemLinkRepository',
      ]) {
        expect(src, `${file} calls ${call}`).not.toContain(call);
      }
    }
  });

  it('GUARD 3 — the write goes through updateWorkItem AS THE BINDER, never a raw repository or system write (deleted ⇒ gates bypassed)', () => {
    const body = applyBody();
    expect(body).toContain('workItemsService.updateWorkItem(');
    const src = code(read(SERVICE));
    expect(src).not.toMatch(/workItemRepository\.(update|create|upsert)/);
    // The one write is under the binder's context — not inside a system transaction.
    const write = body.slice(body.indexOf('workItemsService.updateWorkItem('));
    expect(write.slice(0, 600)).toContain('binder');
    expect(write.slice(0, 600)).not.toContain('withSystemContext');
  });

  it('GUARD 4 — the dispatch is POST-COMMIT: registered on work-item/created and unreachable from reconcileIssue (deleted ⇒ an AI call can sit inside the filing transaction)', () => {
    const job = code(read(JOB));
    expect(job).toMatch(/trigger:\s*'work-item\/created'/);
    expect(read('lib/jobs/registry.ts')).toContain('monitorBugEnrichOnCreated');
    const ingestion = code(read(INGESTION));
    for (const reach of [
      'monitorBugEnrichmentService',
      'dispatchEnrichment',
      'applyAuthoredBug',
      'submitJob',
    ]) {
      expect(ingestion, `the reconciler reaches ${reach}`).not.toContain(reach);
    }
  });

  it('GUARD 5 — monitorBugBody is BYTE-IDENTICAL to what MOTIR-4929 shipped (deleted ⇒ the thin body the write predicate compares against can move)', () => {
    const src = read(INGESTION);
    const start = src.indexOf('export function monitorBugBody(');
    const end = src.indexOf('\n}\n', start) + 2;
    expect(start).toBeGreaterThan(-1);
    const digest = createHash('sha256').update(src.slice(start, end)).digest('hex');
    // Pinned from `origin/main` at the parent branch's base: the function's own
    // source, hashed. A change is not forbidden — it is a DECISION, which is why
    // it has to arrive with this pin moved on purpose.
    expect(digest).toBe('e3f2c90f0cddd074eeebf310ecf06d921057547131d407c32627bb62cb35e0a5');
  });

  it('GUARD 6 — the story gate TRAPS outbound requests and asserts none escaped to sentry.io or a real motir-ai (deleted ⇒ "no test reaches Sentry" is assumed, not measured)', () => {
    const gate = read('tests/integration/monitors/monitorBugEnrichStoryGate.test.ts');
    expect(gate).toContain('agent.disableNetConnect()');
    expect(gate).toContain('globalThis.fetch = (async');
    expect(gate).toContain('expect(escapedRequests).toEqual([])');
  });
});
