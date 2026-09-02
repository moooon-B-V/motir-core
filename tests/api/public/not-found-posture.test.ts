import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../../helpers/stripSourceComments';
import { PUBLIC_OPERATIONS } from '@/lib/api/public/openapi/operations';

// THE 404-NOT-403 POSTURE, over the whole surface (MOTIR-4120).
//
// ── What the per-route suites already prove, and what they cannot ─────────
//
// Every read this story added has a route test asserting that its not-found
// error maps to a bare `{ code }` 404 that echoes nothing back. Those are
// per-route and each was WRITTEN; what none of them can say is that the NEXT
// read added here will have one. So this suite asks the question of the
// filesystem instead: every GET on the public surface either maps a not-found
// error to 404, or is one of a named, reasoned set that has nothing to be
// not-found ABOUT.
//
// ⚠️ WHY THE POSTURE MATTERS MORE HERE THAN ELSEWHERE. On this surface a 403
// would be an ORACLE: it distinguishes "there is no such project" from "there
// is one and you may not see it", across tenants, to an anonymous caller. The
// services already answer both with one error type; the risk is a route that
// helpfully translates one of them into something more informative.

const REPO_ROOT = process.cwd();

/** Every tracked `route.ts` under the public surface's two roots. */
function routeFiles(): string[] {
  return execFileSync('git', ['ls-files', 'app/api/public', 'app/api/public-requests'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('/route.ts'));
}

const sourceOf = (file: string) => stripSourceComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

/**
 * The reads with nothing to be not-found about, each with the reason.
 *
 * ⚠️ A LIST, AND DELIBERATELY A SHORT ONE WITH REASONS ATTACHED — the thing a
 * derived check exists to avoid. It is here because these three genuinely
 * cannot 404: they address no subject, so there is no subject to be missing.
 * Anything ADDED to this list is a decision somebody writes a reason for.
 */
/**
 * The shared error mappers that own the 404 on a route's behalf. A route
 * delegating to one of these is keeping the posture, not skipping it.
 */
const SHARED_MAPPERS = ['mapPublicProjectError', 'projectErrorResponse'];

const NO_SUBJECT: Record<string, string> = {
  'app/api/public/explore/route.ts':
    'the directory — a filter over every public project, never one',
  'app/api/public/categories/route.ts': 'a facet list — no subject at all',
  'app/api/public/projects/route.ts': 'the crawl enumeration — a page of the whole set',
};

describe('every public read answers a missing subject with 404', () => {
  it('finds routes at all — the vacuous-pass floor', () => {
    expect(routeFiles().length).toBeGreaterThanOrEqual(13);
  });

  it('maps a not-found error to status 404, or is a declared no-subject read', () => {
    const offenders: string[] = [];

    for (const file of routeFiles()) {
      if (file in NO_SUBJECT) continue;
      const code = sourceOf(file);
      if (!/export\s+(?:async\s+)?function\s+GET/.test(code)) continue;
      // Either the route maps it ITSELF, or it delegates to the SHARED mapper
      // that owns the whole posture. Accepting only the literal would push
      // routes away from the shared mapper to satisfy a test, which is the
      // opposite of what this suite wants.
      const mapsItself = /status:\s*404/.test(code);
      const delegates = SHARED_MAPPERS.some((mapper) => code.includes(mapper));
      if (!mapsItself && !delegates) {
        offenders.push(
          `${file} — a public GET with no 404 arm. Map its not-found error, delegate to a ` +
            'shared mapper, or add it to NO_SUBJECT with the reason it has no subject.',
        );
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('answers 404 and never 403 — a 403 on this surface is an existence oracle', () => {
    // `ProjectAccessDeniedError → 403` is legitimate on the two WRITE routes
    // under `public-requests` (a signed-in caller who may not act on a project
    // they can already see), so the check is scoped to the READS, where a 403
    // could only ever distinguish "missing" from "not yours".
    const offenders: string[] = [];

    for (const file of routeFiles()) {
      const code = sourceOf(file);
      const reads = /export\s+(?:async\s+)?function\s+GET/.test(code);
      const writes = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(code);
      if (!reads || writes) continue;
      if (/status:\s*403/.test(code)) offenders.push(`${file} — a public READ answers 403`);
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it("a READ's 404 body carries a `code` and nothing else — no message, no echo", () => {
    // A read that included the error's own `message` would name the subject it
    // was asked about back to the caller: every one of these error classes puts
    // the identifier in its message.
    //
    // ⚠️ SCOPED TO THE READS, and the exception is stated rather than silently
    // allowed. `app/api/public-requests/[id]/{upvote,comments}` answer
    // `{ code, error: err.message }` and are left as they are: they are WRITES
    // reached only with a session, by a caller who supplied the id in the URL,
    // so the message tells them nothing they did not just type — and changing a
    // shipped response body would be a contract change dressed as a test fix.
    const offenders: string[] = [];

    for (const file of routeFiles()) {
      const code = sourceOf(file);
      const isRead =
        /export\s+(?:async\s+)?function\s+GET/.test(code) &&
        !/export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(code);
      if (!isRead) continue;
      for (const match of code.matchAll(/NextResponse\.json\(([^;]*?)\{\s*status:\s*404/g)) {
        const body = match[1] ?? '';
        if (/err\.message|error:|message:/.test(body)) {
          offenders.push(`${file} — its 404 body carries more than a code: ${body.trim()}`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the two request WRITES, and where MOTIR-4114 decided they live', () => {
  // AMENDMENT 3 §F decided this, and the decision has two halves. The first is a
  // placement — they STAY outside `app/api/public/*` — which is only a decision
  // if something would otherwise drift; the second is the gate, which was
  // genuinely missing and is asserted by `cloud-gate-totality.test.ts` now that
  // it walks this root too.
  const WRITES = [
    'app/api/public-requests/[id]/upvote/route.ts',
    'app/api/public-requests/[id]/comments/route.ts',
  ];

  it('exist where the decision says they do', () => {
    for (const file of WRITES) expect(routeFiles()).toContain(file);
  });

  it('carry the capability gate, which they did not before MOTIR-4114', () => {
    // The real hole: `cloud-gate-totality` walked `app/api/public` only, so a
    // self-hosted build answered these two — endpoints belonging to a feature
    // it is not supposed to have.
    for (const file of WRITES) {
      expect(sourceOf(file), file).toContain('publicSurfaceUnavailable()');
    }
  });

  it('are NOT in the public contract, and each says why in its own words', () => {
    // The other half of the decision. They are absent from the document because
    // no consumer of it can call them: after AMENDMENT 3 nothing on motir.co
    // does, and `sameSite: 'lax'` means nothing on motir.co could.
    const declared = PUBLIC_OPERATIONS.map((operation) => operation.path);
    expect(declared.some((path) => path.includes('public-requests'))).toBe(false);

    for (const file of WRITES) {
      const prose = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(prose, `${file} must record WHY it stays outside the contract`).toContain(
        'AMENDMENT 3',
      );
    }
  });
});
