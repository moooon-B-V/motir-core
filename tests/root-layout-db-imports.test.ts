import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainsToModule, describeChains, DB_MODULE, REPO_ROOT } from './helpers/importGraph';

// MOTIR-2381 — the ROOT layout's database reach is an explicit, justified list.
//
// `app/layout.tsx` is in EVERY route's module graph, so anything it imports is
// traced into every server function Next builds — a 404, the token specimen and
// the public docs tree included. And `lib/db.ts` constructs its `PrismaClient`
// at MODULE SCOPE (and throws when `DATABASE_URL` is unset), so "carried" here
// means "instantiated", not merely "bundled".
//
// Measured on this build (see `scripts/measure-prisma-traces.mjs`): 340 of 348
// traced functions carry `@prisma/client`. Dropping the two imports below took
// that to 330 — the landing page, the four `(auth)` screens, `_not-found` and
// the four `/tokens` specimen routes. They are NOT dropped, and the docstring
// in `app/layout.tsx` records why; this test exists so that the next import
// with a database behind it has to pass through the same question rather than
// arriving unnoticed.
//
// The graph walk lives in `tests/helpers/importGraph.ts` — MOTIR-2452 needed
// the same walk for the public docs tree, so it moved there rather than being
// copied.

const ROOT_LAYOUT = 'app/layout.tsx';

/**
 * The imports of the ROOT layout that are allowed to reach `lib/db.ts`.
 *
 * Adding an entry here is a deliberate act with a measurable cost: it puts a
 * database client into every route in the product. Justify it in
 * `app/layout.tsx`'s docstring, and re-run the measurement script.
 */
const APPROVED_DB_REACHING_IMPORTS = [
  // The session the shell renders against. `<html>`'s appearance attributes and
  // the pre-paint FOUC script are root-scoped, so this read cannot move down.
  '@/lib/auth',
  // The signed-in user's applied appearance (7.3.61's cross-device, no-flash
  // guarantee). Same root scoping — see the layout docstring.
  '@/lib/services/appearancePreferenceService',
] as const;

describe('the root layout’s database reach (MOTIR-2381)', () => {
  it('reaches lib/db.ts through exactly the approved imports', () => {
    const offenders = chainsToModule(ROOT_LAYOUT);
    const reaching = offenders.map((o) => o.specifier).sort();

    expect(
      reaching,
      offenders.length > 0
        ? `Root-layout imports reaching ${DB_MODULE}:\n` +
            describeChains(offenders) +
            `\nEvery route in the product carries what this list reaches. If the new one ` +
            `belongs here, add it to APPROVED_DB_REACHING_IMPORTS and record why in ` +
            `${ROOT_LAYOUT}'s docstring.`
        : undefined,
    ).toEqual([...APPROVED_DB_REACHING_IMPORTS].sort());
  });

  it('lib/db.ts still constructs the client at module scope — the reason "carried" means "instantiated"', () => {
    // If this ever becomes lazy, the blast-radius half of MOTIR-2381's finding
    // changes and the trade-off recorded in app/layout.tsx should be re-read.
    const source = readFileSync(join(REPO_ROOT, DB_MODULE), 'utf8');
    expect(source).toMatch(/^export const db =/m);
  });
});
