// The RATCHETS the ratchet scanner is pointed at (MOTIR-2941).
//
// This file is never executed — it is PARSED. Every declaration below is one
// case, so the scanner is proven in both directions instead of trusted, and the
// meta-guard's negative cases live HERE rather than in the real guards (where
// they would have to be real defects to exist at all).
//
// The locals are `declare`d rather than imported for the reason
// `testSingletonStatements`' fixture gives: the scanner resolves no imports, it
// matches identifiers, and a fixture that imports the real helper could not
// carry a NON-compliant case without also carrying it into the type graph.
//
// ⚠️ Line positions are NOT load-bearing — the guard asserts on names, values,
// directions and message CONTENT, so adding a comment here cannot break it.

declare const expect: (
  value: unknown,
  message?: string,
) => {
  toBeLessThanOrEqual(bound: number): void;
  toBeGreaterThanOrEqual(bound: number): void;
  toBeGreaterThan(bound: number): void;
};
declare const remeasureFirst: (name: string) => string;
declare const population: { length: number };

// ── Enrolled: a non-zero CEILING carrying the preamble ──────────────────────
const FIXTURE_COMPLIANT_CEILING = 12;

// ── Enrolled: a non-zero FLOOR carrying the preamble. Its direction must come
// from the COMPARATOR, and it is asserted far below its declaration, next to a
// constant it is not.
const FIXTURE_COMPLIANT_FLOOR = 7;

// ── Enrolled and IMMUNE: zero needs no preamble. Nothing a sibling merges can
// move a count below zero, which is the whole exemption.
const FIXTURE_IMMUNE_CEILING = 0;

// ── Enrolled and NON-compliant: a real message, no preamble. The case the
// meta-guard exists to catch.
const FIXTURE_BARE_MESSAGE_CEILING = 3;

// ── Enrolled and NON-compliant: no message argument at all.
const FIXTURE_NO_MESSAGE_CEILING = 5;

// ── Enrolled ORPHAN: declared, never asserted. A ratchet nothing reads is not a
// ratchet, and the meta-guard says so rather than skipping it.
const FIXTURE_ORPHAN_CEILING = 41;

// ── NOT enrolled: named, numeric, and not a ratchet. The suffix is the
// enrolment mechanism.
const FIXTURE_MAX_HOPS = 3;

export function fixtureAssertions(): void {
  expect(
    population.length,
    remeasureFirst('FIXTURE_COMPLIANT_CEILING') +
      `${population.length} things exceed the ceiling ${FIXTURE_COMPLIANT_CEILING}.`,
  ).toBeLessThanOrEqual(FIXTURE_COMPLIANT_CEILING);

  expect(population.length, 'a plain message with no preamble anywhere in it').toBeLessThanOrEqual(
    FIXTURE_BARE_MESSAGE_CEILING,
  );

  expect(population.length).toBeLessThanOrEqual(FIXTURE_NO_MESSAGE_CEILING);

  expect(
    population.length,
    'the zero ceiling is at its floor; adjudicate rather than raising it',
  ).toBeLessThanOrEqual(FIXTURE_IMMUNE_CEILING);

  // A bare sanity floor: no named constant, so not a ratchet and not enrolled.
  expect(population.length).toBeGreaterThan(20);

  // Asserted last, and against the constant declared SECOND — attribution has to
  // follow the identifier the comparator reads, not declaration adjacency.
  expect(
    population.length,
    remeasureFirst('FIXTURE_COMPLIANT_FLOOR') +
      `fewer than ${FIXTURE_COMPLIANT_FLOOR} things remain untouched.`,
  ).toBeGreaterThanOrEqual(FIXTURE_COMPLIANT_FLOOR);

  expect(population.length).toBeLessThanOrEqual(FIXTURE_MAX_HOPS);
  void FIXTURE_ORPHAN_CEILING;
}
