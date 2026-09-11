import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import { isSettledState } from '@/lib/projectRepos/transitions';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// WHAT THE ESTABLISH STEP ASKS OF A REPOSITORY SET (bug MOTIR-5049 · design
// `design/repository-set/design-notes.md` §7b, v6) — the three predicates the
// post-approval step and the review rail read, in ONE module so no consumer
// re-derives them.
//
// ⚠️ PURE AND CLIENT-SAFE ON PURPOSE, exactly as `roomSections.ts` is and for the
// same reason: every one of these is applied on BOTH sides — the server page that
// seeds the plan-detail island, and the island itself, which re-reads the set on
// every poll tick. Nothing here imports a workspace context, a service or a
// Prisma client; the two type imports are type-only and erase.
//
// ── ⚠️ THERE ARE TWO QUESTIONS HERE, NOT ONE, AND CONFLATING THEM IS THE BUG ──
//
// §7b states the split in one line: **`state` decides whether the band APPEARS;
// `seedSource` decides what the band may CLAIM.** They are answered by
// {@link setHasEstablishWork} and {@link setHasOrganizationRow} respectively, and
// a set can answer yes to both — that is the MIXED set, where the step is drawn
// AND its two set-wide sentences have to be scoped.
//
// The shipped gate asked a THIRD question that is neither of them —
// `set.rows.length > 0`, a row COUNT — which is what put "Motir will host your
// code" over an approved plan's canvas for every project whose repositories are
// its organisation's. A count was a correct gate for exactly as long as the
// establish step was the only writer of `project_repository` rows; MOTIR-4669's
// org tier added `organizationRepoService.linkRealized` / `connectAndLink` as a
// second writer, and nobody swept the readers.

/**
 * Does this row hold WORK THE ESTABLISH STEP DOES — something Motir will create,
 * is creating, has just created, or failed to create?
 *
 * ⚠️ THIS IS NOT THE NEGATION OF {@link isSettledRow}, and the difference is the
 * whole of MOTIR-5049. **`created` is the single state where the equivalence
 * breaks**: it is SETTLED (no legal move left) and it is still the step's work,
 * because the step owes a report on the repository it just made — that report is
 * `AccessReport`. So `!isSettledRow` would drop the band for a set Motir had
 * just built, taking the report with it, and that is exactly the substitution a
 * builder makes in good faith.
 *
 * (`failed` is CONSISTENT with the negation — not settled, and the step's work —
 * but it is worth naming beside it, because settledness there is itself
 * counter-intuitive: a failure is resumable at any later visit, so it is not a
 * settled row, and the band is drawn for it.)
 *
 * Written POSITIVELY — the four states Motir establishes — rather than as
 * `!connected && !skipped`, because the positive form is the one §7b states and
 * the one a reader can check against the ADR §4.1 machine. The equivalence is
 * noted there: *"a set whose every row is `connected` or `skipped` draws no
 * band."*
 */
export function isEstablishRow(row: Pick<ProjectRepoDto, 'state'>): boolean {
  return (
    row.state === 'proposed' ||
    row.state === 'creating' ||
    row.state === 'created' ||
    row.state === 'failed'
  );
}

/**
 * ⚠️ THE DRAW PREDICATE — whether the post-approval establish step is rendered at
 * all (design §7b · `design/ai-planning/design-notes.md` Part VI §4's v6
 * amendment). **The band is drawn if and only if the set holds at least one row
 * Motir ESTABLISHES.**
 *
 * So a set whose every row is `connected` or `skipped` — every BYOK project,
 * since MOTIR-4753 made a repository a precondition of planning at all — draws no
 * band, and the approved plan's canvas has the whole pane.
 *
 * An EMPTY set draws nothing either, which is what the row count it replaces got
 * right and is preserved here by `some` over no rows being false.
 *
 * **The two plausible alternatives are both wrong, and §7b says why** (recorded
 * here because each is what a builder reaches for in good faith):
 *
 *   • `set.ownership` is NULL for exactly this population — it is *"null until
 *     the establish step decides"*, and a settled set never ran the step;
 *   • `codeOutcomeOf(...) === 'ready'` cannot tell the two populations apart — it
 *     counts `created` as settled too, so it is `ready` both for a set Motir just
 *     built (which DOES owe a report) and for one that arrived settled (which
 *     does not).
 */
export function setHasEstablishWork(rows: readonly Pick<ProjectRepoDto, 'state'>[]): boolean {
  return rows.some(isEstablishRow);
}

/**
 * Does the set hold a repository the ORGANISATION already owns — the second half
 * of §7b's split, and the predicate that scopes what the band may CLAIM.
 *
 * A set answering yes to this AND to {@link setHasEstablishWork} is the MIXED
 * set: `organizationRepoService` appends a `connected` / `organization` row to
 * whatever set the project already has, so a project can hold an organisation row
 * and a Motir row at once (MOTIR-5017 pins a test on the shape). The step is
 * drawn for it — there IS a row to establish — but its two set-wide sentences
 * would otherwise speak for a repository that is not Motir's to speak for, so
 * they render as `titleMixed` / `promiseMixed` instead.
 *
 * ⚠️ IT IS DELIBERATELY NOT THE DRAW PREDICATE. A `skipped` row is not
 * organisation-sourced and still leaves nothing to establish, and a `connected`
 * row need not be the organisation's — which is exactly why `state` decides the
 * band and this decides only the copy.
 *
 * Routed through `isOrganizationSeedSource`, which its own doc comment calls
 * *"the room's section split, and the only place the distinction is decided"* —
 * so this module adds a caller rather than a second answer.
 */
export function setHasOrganizationRow(
  rows: readonly Pick<ProjectRepoDto, 'seedSource'>[],
): boolean {
  return rows.some((row) => isOrganizationSeedSource(row.seedSource));
}

/**
 * Is this row SETTLED — has it no legal move left (ADR §4.1)? `created`,
 * `connected` and `skipped` are settled; `failed` deliberately is NOT, because it
 * is resumable at any later visit.
 *
 * ⚠️ ONE DEFINITION, REACHED THROUGH THE STATE MACHINE. This delegates to
 * `transitions.isSettledState`, which derives the answer from the machine's own
 * edge table (a state with no outgoing edge is settled) rather than restating the
 * three members. Before MOTIR-5049 there were THREE copies of this list — here in
 * `RepositorySetStep`, again inside `PlanDetail.codeOutcomeOf`, and the real one
 * in `transitions.ts` — so a fourth ADR state would have had to be found in three
 * places by whoever added it.
 */
export function isSettledRow(row: Pick<ProjectRepoDto, 'state'>): boolean {
  return isSettledState(row.state);
}

/**
 * Can the user REACH this row's repository (MOTIR-1900)?
 *
 * TRUE for every row that raises no access question at all — a `connected` row is
 * the user's own repository and a `skipped` row has none — so only a repository
 * MOTIR created and nobody has been invited to counts as unfinished. `invited`
 * counts as reached: Motir has done everything it can, and the remaining step is
 * the user's to take on GitHub.
 *
 * The second predicate MOTIR-5049 found duplicated verbatim across
 * `RepositorySetStep` and `PlanDetail.codeOutcomeOf`.
 */
export function rowIsReachable(row: Pick<ProjectRepoDto, 'state' | 'access'>): boolean {
  return row.state !== 'created' || row.access.state !== 'not_invited';
}
