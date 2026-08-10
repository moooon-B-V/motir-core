import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The ROUTING guard for the membership gates (MOTIR-2527).
//
// `workspaceMembershipRepository.findByUserAndWorkspace` reads through the `db`
// singleton, so it binds none of the per-transaction GUCs
// `membership_visible_active_or_own` keys off. Under the non-bypass `motir_app` role
// it therefore returns `null` for a row that exists, and every access gate reports
// that as "not a member" — 1048 measured failures, one root cause
// (`docs/rls-runtime-role-inventory.md`, Finding 1).
//
// Routing the twelve call sites through `lib/workspaces/membershipGate.ts` fixes the
// instances. This test is what stops the THIRTEENTH: the trap is still exported (the
// existing test suite calls it as an owner-side assertion, and migrating those is
// MOTIR-2528's), and it is the shorter, more obvious name of the two. Nothing about
// reading it suggests it is unsafe — which is exactly why a comment is not enough.
//
// The check is a text walk rather than a type-level one because the hazard is the
// NAME being reachable at all from shipped code. A lint rule would be the other
// option; this keeps the reasoning next to the reason.

const ROOT = join(__dirname, '..', '..');
const SHIPPED_DIRS = ['lib', 'app'];

/** The unbound read. The `(` matters — `findByUserAndWorkspaceInTx(` must not match. */
const TRAP = 'findByUserAndWorkspace(';

/** Its own definition, which necessarily contains the string. */
const DEFINITION = join('lib', 'repositories', 'workspaceMembershipRepository.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no shipped code reads a membership through the unbound variant', () => {
  it('finds the trap ONLY in its own definition', () => {
    const offenders: string[] = [];
    for (const dir of SHIPPED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === DEFINITION) continue;
        if (readFileSync(file, 'utf8').includes(TRAP)) offenders.push(rel);
      }
    }
    // Named rather than counted: a failure should say WHERE, because the fix is
    // per-call-site (each one has to acquire a transaction or self-bind — the card
    // is explicit that this is not a find-replace).
    expect(offenders).toEqual([]);
  });

  it('is not vacuous — the trap it hunts for still exists to be found', () => {
    // Without this, deleting or renaming `findByUserAndWorkspace` would leave the
    // guard above passing while proving nothing at all.
    const source = readFileSync(join(ROOT, DEFINITION), 'utf8');
    expect(source).toContain(`async ${TRAP}`);
  });

  it('does not mistake the tx-aware variant for the trap', () => {
    // The two names differ by a suffix, so the guard's own pattern is the thing most
    // likely to be wrong. `findByUserAndWorkspaceInTx(` must NOT contain the trap
    // string — and it does not, because of the `(`.
    expect('findByUserAndWorkspaceInTx('.includes(TRAP)).toBe(false);
  });
});
