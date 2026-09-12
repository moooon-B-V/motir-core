// The GUARD the CONTRACT-ratchet fixture is read by (MOTIR-5207).
//
// This file is never executed — it is PARSED, and it is DISCOVERED: the scanner
// derives a contract's guard by finding the source that names the contract's
// path, which is the string literal below. Nothing here is registered anywhere.
//
// Its two messages are the meta-guard's positive and negative cases, in one
// file, because that is the shape the rule has to rule on: a guard is compliant
// only when EVERY message it can print opens with the preamble.

declare const expect: (
  value: unknown,
  message?: string,
) => { toEqual(other: unknown): void; toBeGreaterThan(bound: number): void };
declare const remeasureFirst: (name: string, rerun?: string) => string;
declare const offenders: string[];
declare const stale: string[];
declare const filesScanned: number;

const CONTRACT = 'tests/rls/__fixtures__/ratchets/fixtureAllowList.json';

export function fixtureContractAssertions(): void {
  // COMPLIANT — opens with the preamble.
  expect(
    offenders,
    remeasureFirst(CONTRACT) + 'these locators are in the tree and not in the contract.',
  ).toEqual([]);

  // NON-compliant — a real message, no preamble. The case the meta-guard exists
  // to catch, and the exact shape MOTIR-5037's guard shipped in.
  expect(stale, 'these contract entries no longer match anything').toEqual([]);

  // Not a message at all, so not in scope: it accuses nobody, which is the same
  // ground the scanner gives for excluding a bare numeric sanity floor.
  expect(filesScanned).toBeGreaterThan(200);
}
