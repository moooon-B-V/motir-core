import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The ROUTING guard for the membership gates (MOTIR-2527), now a TOMBSTONE
// (MOTIR-2812).
//
// `workspaceMembershipRepository.findByUserAndWorkspace` read through the `db`
// singleton, so it bound none of the per-transaction GUCs
// `membership_visible_active_or_own` keys off. Under the non-bypass `motir_app` role
// it returned `null` for a row that existed, and every access gate reported that as
// "not a member" — 1048 measured failures, one root cause
// (`docs/rls-runtime-role-inventory.md`, Finding 1).
//
// MOTIR-2527 routed the twelve call sites through `lib/workspaces/membershipGate.ts`
// and this guard was written to stop the THIRTEENTH, because the trap was STILL
// EXPORTED — the test suite kept it alive as an owner-side assertion. That is the
// condition MOTIR-2812 removed: it had zero production callers, its seven test
// consumers moved to `adminDb`, and the method is DELETED.
//
// ⚠️ SO THE ASSERTION FLIPPED, and the file is kept rather than deleted for one
// reason: the strongest possible form of this guard is "the name does not exist
// anywhere", and that is a claim worth pinning permanently. A deleted guard would
// let the method be reintroduced by anyone who found the old shape convenient; this
// one fails the build if it comes back. The check stays a text walk because the
// hazard is still the NAME being reachable at all.
//
// Its predecessor's non-vacuity test — "the trap it hunts for still exists to be
// found" — is retired with the trap. Its replacement is the inverse: the definition
// file must NOT contain it, and the tx-aware variant must still be there, so a
// wholesale deletion of the repository cannot make this pass by accident.

const ROOT = join(__dirname, '..', '..');
const SHIPPED_DIRS = ['lib', 'app'];

/** The retired read. The `(` matters — `findByUserAndWorkspaceInTx(` must not match. */
const TRAP = 'findByUserAndWorkspace(';

/** Where it used to live, and where a reintroduction would most likely land. */
const DEFINITION = join('lib', 'repositories', 'workspaceMembershipRepository.ts');

/** The tx-aware variant that replaced it, and must still exist. */
const SURVIVOR = 'async findByUserAndWorkspaceInTx(';

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

describe('the unbound membership read is gone and stays gone', () => {
  it('appears NOWHERE in shipped code — not even in its old definition', () => {
    const offenders: string[] = [];
    for (const dir of SHIPPED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        if (readFileSync(file, 'utf8').includes(TRAP)) offenders.push(relative(ROOT, file));
      }
    }
    // Named rather than counted: a failure should say WHERE. And note the
    // definition file is no longer exempt — that exemption existed only while the
    // method did.
    expect(offenders).toEqual([]);
  });

  it('is not vacuous — the file it guards still exists and still has the SAFE variant', () => {
    // The inverse of the old non-vacuity check. Deleting the whole repository would
    // otherwise make the assertion above pass while proving nothing, so pin that the
    // survivor is still there: `findByUserAndWorkspaceInTx`, which takes the
    // caller's transaction and is what every gate uses.
    const source = readFileSync(join(ROOT, DEFINITION), 'utf8');
    expect(source).toContain(SURVIVOR);
  });

  it('does not mistake the tx-aware variant for the trap', () => {
    // The two names differ by a suffix, so the guard's own pattern is the thing most
    // likely to be wrong. `findByUserAndWorkspaceInTx(` must NOT contain the trap
    // string — and it does not, because of the `(`.
    expect('findByUserAndWorkspaceInTx('.includes(TRAP)).toBe(false);
  });
});
