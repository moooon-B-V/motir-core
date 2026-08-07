// The pragmatic "is this shaped like an email address" check, shared by every
// caller that used to keep its own copy of `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
// (MOTIR-2418 follow-up). Two services carried that regex byte-identically,
// and CodeQL flagged both as `js/polynomial-redos`: `.` is itself a member of
// `[^\s@]`, so `[^\s@]+\.[^\s@]+` can split a dotted domain in as many ways as
// it has dots, and a non-matching input is re-tried at every one of them —
// quadratic in the domain length. CodeQL's witness is a string starting `!@!.`
// with many repetitions of `!.`.
//
// The rewrite below computes the SAME predicate with index arithmetic, so it
// is linear by construction and has no backtracking to reason about. The
// original accepted exactly: no whitespace anywhere, a non-empty local part,
// exactly one `@`, and a domain carrying a `.` with at least one character on
// each side. Each of those is one line here, in that order.
//
// The authority on whether an address is real remains delivery plus the
// confirmation click; this only rejects obvious garbage before a token is
// issued.

/** Matches a single whitespace character — no quantifier, so no backtracking. */
const WHITESPACE = /\s/;

/**
 * True when `value` is shaped like an email address: no whitespace, a
 * non-empty local part, exactly one `@`, and a dot inside the domain with at
 * least one character on either side of it.
 */
export function isEmailShape(value: string): boolean {
  if (WHITESPACE.test(value)) return false;

  const at = value.indexOf('@');
  if (at < 1) return false; // no `@`, or an empty local part

  const domain = value.slice(at + 1);
  if (domain.includes('@')) return false; // more than one `@`

  // A dot at index i of the domain with 0 < i < len-1 is exactly a dot in the
  // domain minus its first and last character.
  return domain.slice(1, -1).includes('.');
}
