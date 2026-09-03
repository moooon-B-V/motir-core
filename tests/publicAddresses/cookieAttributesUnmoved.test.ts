import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// THE SESSION COOKIE DID NOT MOVE — Story MOTIR-3878 · Subtask MOTIR-4218.
//
// ── Why a whole test for a change that touches no cookie ──────────────────
//
// `public-surface-hosts.md` §4 accepted tenant content on a domain adjacent to
// the session's ON ONE CONDITION: the session cookie stays HOST-ONLY, with no
// `Domain=` widening. That condition is what made the residual exposure
// survivable, and the ADR (§2, AMENDMENT 6) closes §4's reversal by moving
// tenant addresses to a separate registrable domain — it does NOT spend the
// condition.
//
// This card widens two ORIGIN allow-lists. The tempting adjacent change — "the
// public site now has several origins, so widen the cookie to `.motir.co`" —
// would undo the one property the whole arrangement rests on, and it would do
// it in a file this card otherwise never opens. So the guard lives here, beside
// the widening, rather than in the auth suite where nobody editing CORS would
// meet it.
//
// It reads the SOURCE rather than a running config on purpose: the attributes
// are a literal in `lib/auth/index.ts`, and a `Domain` added there is the
// change to catch — before it ever reaches a runtime somebody could inspect.

const AUTH = join(process.cwd(), 'lib', 'auth', 'index.ts');

// ⚠️ THE `Domain` PROPERTY IS NOT RE-ASSERTED HERE. `tests/navigation/public-surface-cors.test.ts`
// already owns it — § *the session cookie is not widened, and this card did not
// widen it* — and it was written for exactly this pressure. Restating it would
// buy a second place for it to drift, which is the failure a duplicated guard
// actually produces. What follows is the property that test does NOT have.
describe('the session cookie attributes are unchanged by the address widening', () => {
  it('is byte-identical to origin/main — measured, not eyeballed', () => {
    // The stronger form of the assertion above: not "it still looks right", but
    // "this card changed nothing in it". A future edit that keeps the four
    // properties above while altering the block still fails here, and having to
    // update this test is exactly the moment to ask whether §4's condition is
    // being spent.
    let onMain: string;
    try {
      onMain = execFileSync('git', ['show', 'origin/main:lib/auth/index.ts'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
    } catch {
      // No git, or no `origin/main` — a shallow CI checkout. The first test
      // still holds the property; skipping is honest rather than passing on a
      // comparison that never ran.
      return;
    }
    const slice = (s: string) =>
      s.slice(s.indexOf('session_token:'), s.indexOf('session_token:') + 600);
    expect(slice(readFileSync(AUTH, 'utf8'))).toBe(slice(onMain));
  });
});
