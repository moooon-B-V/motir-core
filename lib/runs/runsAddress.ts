// The `/runs` ADDRESS — `?scope=<KEY>` and `?run=<id>` (Story MOTIR-5363 ·
// design MOTIR-5402, `design/runs/design-notes.md` § The ADDRESS CONTRACT).
//
// ⚠️ A DIRECTIVE-FREE MODULE, and it has to be. The server page parses `scope`
// to choose its reads, `RunsIndex` (a client island) writes both parameters as a
// run opens and closes, and the item page's Run section links into the
// narrowing. Declaring the parser inside the client component and importing it
// back into the page would make the whole module a client reference — the
// boundary follows the module, not the symbol.
//
// ⚠️ THE TWO PARAMETERS COMPOSE; NEITHER REPLACES THE OTHER. Opening a run from a
// narrowed list keeps the narrowing (`?scope=…&run=…`), and closing the modal
// returns to the narrowed list rather than to `/runs`. The index used to write
// `/runs?run=<id>` and `/runs` literally, which dropped the narrowing on the
// first click.

/** The narrowing: a work-item KEY whose scoped runs the index lists. */
export const RUNS_SCOPE_PARAM = 'scope';
/** The open run: the modal over the index (MOTIR-3895). */
export const RUNS_RUN_PARAM = 'run';

/**
 * A `?scope=` value as a page receives it → the work-item KEY it narrows to, or
 * `null` for no narrowing.
 *
 * Upper-cased, because the service resolves the key case-insensitively and every
 * link the product writes uses the upper-case key. A REPEATED parameter arrives
 * as an array and has no right answer to which one was meant, so it narrows
 * nothing — the same answer the roadmap gives a repeated `?item=`.
 */
export function parseRunsScope(raw: string | string[] | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  return key === '' ? null : key;
}

/**
 * `/runs`, `/runs?scope=KEY`, `/runs?run=id` or `/runs?scope=KEY&run=id`.
 *
 * The one place a runs address is spelled, so the index, the section and the
 * page cannot disagree about the parameter names or their order.
 *
 * ⚠️ `encodeURIComponent`, NOT `URLSearchParams`. Both round-trip, but they
 * spell a space differently (`%20` against `+`), and the run section's deep link
 * already shipped the `%20` form under test (MOTIR-5398). One address, one
 * spelling — the helper keeps the contract it inherited rather than changing
 * what an existing link looks like.
 */
export function runsHref({
  scope,
  run,
}: { scope?: string | null; run?: string | null } = {}): string {
  const parts: string[] = [];
  if (scope) parts.push(`${RUNS_SCOPE_PARAM}=${encodeURIComponent(scope)}`);
  if (run) parts.push(`${RUNS_RUN_PARAM}=${encodeURIComponent(run)}`);
  return parts.length === 0 ? '/runs' : `/runs?${parts.join('&')}`;
}
