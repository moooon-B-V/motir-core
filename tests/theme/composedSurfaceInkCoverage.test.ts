import { describe, expect, it } from 'vitest';
import { abstainedByModule, abstainedMutedSites } from './composedInkAbstentions';

// MOTIR-4251 — the POPULATION guard behind the render-time ink sweep.
//
// ── Why a coverage claim needs its own test ────────────────────────────────
// `tests/components/composed-surface-ink.test.tsx` says it covers "the composed
// surfaces the static walk abstains on". That is a claim about a SET, and a
// claim about a set is exactly as large as the command behind it. Before this
// file the abstention had only ever been described in prose — "every composed
// surface in the product" — which reads as a measurement and is a sentence.
//
// So the population is enumerated by running the muted arm's OWN predicates over
// the same file set it scans (`scanMutedSurfaceResolution` in
// `tests/theme/inkContrastScan.ts`) and recording the sites it walks past. This
// file then asserts the two things that keep the render sweep honest:
//
//  1. **Every module the render sweep claims is REALLY in the hole.** A surface
//     added there that the static guard already rules on buys nothing and reads
//     as coverage — it fails here, by name.
//  2. **The residue is stated, not implied away.** The uncovered count is
//     printed in the failure message of the claim that names it, so the number in
//     MOTIR-4251's pull-request body is reproducible by running this file rather
//     than by trusting a paragraph.
//
// ⚠️ It deliberately does NOT pin the residue COUNT. A ratchet on that number
// goes red on every unrelated card that adds a muted caption, which trains
// people to raise it; and the honest reading of a growing residue is not "this
// test is wrong" but "the guard covers a smaller share than it did", which is a
// judgement for a planning pass rather than a red check on somebody's feature.

/** The modules `tests/components/composed-surface-ink.test.tsx` mounts. */
export const COVERED_MODULES: Readonly<Record<string, string>> = {
  'app/(authed)/items/_components/IssueQuickViewPanel.tsx':
    'the quick view peek and its rail — MOTIR-4196, guarded by ' +
    'tests/components/quick-view-rail-ink.test.tsx',
  'components/ui/CommandPalette.tsx':
    'a portalled dialog body: the group headings and the footer hint are painted ' +
    'by the dialog primitive in another module',
};

// ⚠️ `components/issues/actions/WorkItemActionsMenu.tsx` is deliberately ABSENT,
// and this test caught it. The render sweep mounts it — a portalled menu body is
// the shape this guard exists for — but every one of its nine muted sites is an
// `aria-hidden` glyph, so the static arm rules them EXEMPT rather than abstaining
// and the module is not in the population. The mount is still worth keeping (it
// pins the exemption arm reading the composed DOM instead of an AST's guess about
// it) and it is not COVERAGE of the hole, which is the distinction this file
// exists to hold. Claiming it here was the first thing this test failed on.

// ⚠️ `components/planning/PlanItemNode.tsx` was an entry here until MOTIR-4260
// shipped, and it is GONE rather than re-pointed — the same disposition, for the
// same reason, as MOTIR-4246's two modules below. That card re-inked the `remove`
// node's title from `--el-text-muted` to `--el-text-secondary` (4.12:1 → 6.18:1
// on the node's own `--el-muted` frame), and that title was the module's ONLY
// non-exempt muted site: what remains is a `bg-(--el-text-muted)` spine and an
// `aria-hidden` chevron, so the static arm rules rather than abstains and the
// module is not in the population any more. **Its two mounts stay** in
// `tests/components/composed-surface-ink.test.tsx` — they are the regression
// guard for MOTIR-4030's and MOTIR-4260's fixes, which is a different claim from
// coverage of the hole, and holding those two apart is what this file is for.
// This test is what caught the stale pointer, on the run that made it stale.

// ⚠️ MOTIR-4246's two `/items` modules — `issueColumns.tsx` and
// `IssueTreeTable.tsx` — were entries here until that card shipped (#2543). They
// are gone rather than re-pointed: the fix moved both sites OFF `--el-text-muted`
// (to `--el-text-identifier` and `--el-text-secondary`), so neither module carries
// a muted site at all any more and neither is in the abstention for this guard to
// defer on. Its own render-time guard is `tests/components/items-row-ink.test.tsx`.
// This test is what caught the stale pointer, which is the job it was written for.

// ── ⚠️ THE OWNED-DEFERRAL LIST IS RETIRED, AS ITS OWN TRIP-WIRE ASKED ───────
//
// `UNCOVERED_WITH_OWNERS` recorded composed surfaces the sweep did not cover,
// each with the card that owned it — AC 5 of MOTIR-4251: a coverage claim owes
// its population, and the half you did not cover is the half nobody re-reads.
// It held ONE entry, `components/planning/PlanItemNode.tsx#remove`, owned by
// MOTIR-4260. Its `it` carried a deliberate trip-wire beside the staleness
// check — `expect(keys.length).toBeGreaterThan(0)` — with its own disposition
// written into the comment above it: *"when the residue is finally all owned or
// all fixed, this fails and a person retires the list rather than leaving a
// tautology behind."*
//
// MOTIR-4260 fixed that entry, the list emptied, and the trip-wire fired on the
// very run that emptied it. This is that retirement. Deleting the limb is the
// disposition the author chose over an empty object, and it is the right one:
// an empty registry passes its own staleness check for free, which is precisely
// the vacuous green this file exists to refuse.
//
// **What still holds the coverage claim honest, so nothing was traded away:**
// the residue assertion in the last `it` (`expect(residue.length)
// .toBeGreaterThan(0)`) measures the ~190 abstained modules `COVERED_MODULES`
// does NOT name, and it is the check that stops "the composed surfaces the
// static walk abstains on" from ever reading as total. The list retired here
// was the OWNED subset of that residue, not the residue itself.
//
// **To reinstate it, when a card next DEFERS a composed surface:** restore the
// `UNCOVERED_WITH_OWNERS` record, keyed by module path (or `path#state` for one
// state of a module), valued with the card that owns it; restore `moduleOf =
// (file: string) => file.split('#')[0]!` so a state-scoped key is checked by its
// module half; and restore the `it` asserting every key is a module the static
// walk really abstains on. A deferral is a card, never a paragraph — this
// registry is how one is pinned to a check that goes red when it goes stale.

describe('MOTIR-4251 · the abstention this guard is pointed at', () => {
  const sites = abstainedMutedSites();
  const byModule = abstainedByModule(sites);
  const modules = new Set(byModule.map(([file]) => file));

  it('the population is non-empty — the hole this guard exists for is real', () => {
    // If this ever returns nothing, the static walk stopped abstaining and the
    // render sweep is guarding a hole that closed. That is a good outcome and it
    // still needs a person: it means this whole mechanism can retire.
    expect(sites.length).toBeGreaterThan(0);
    expect(modules.size).toBeGreaterThan(0);
  });

  it('every module the render sweep claims is genuinely inside the abstention', () => {
    const claimedButNotAbstained = Object.keys(COVERED_MODULES).filter((f) => !modules.has(f));
    expect(
      claimedButNotAbstained,
      'these modules are claimed as covered by tests/components/composed-surface-ink.test.tsx ' +
        'but the static walk already rules on them — covering them buys nothing and reads as ' +
        'coverage. Either the static guard widened (drop them here) or the path is stale.',
    ).toEqual([]);
  });

  // The mirror of the check above — 'every module named as UNCOVERED is one the
  // static walk really abstains on' — is RETIRED with the list it read, on the
  // run that emptied it. See the block above `COVERED_MODULES`'s consumers for
  // why deletion rather than an empty object, and for the shape to restore.

  it('every covered module carries abstained sites, and the residue is reported', () => {
    const covered = byModule.filter(([file]) => file in COVERED_MODULES);
    const coveredSites = covered.reduce((n, [, count]) => n + count, 0);
    const residue = byModule.filter(([file]) => !(file in COVERED_MODULES));
    const summary =
      `abstained muted sites: ${sites.length} across ${modules.size} modules · ` +
      `covered: ${coveredSites} across ${covered.length} · ` +
      `residue: ${sites.length - coveredSites} across ${residue.length} modules`;

    // A covered module with ZERO abstained sites is a mount that measures
    // nothing — the vacuous-green shape the render sweep's own header is written
    // against, caught here from the population side.
    expect(
      covered.filter(([, count]) => count === 0).map(([file]) => file),
      `covered modules with no abstained site — ${summary}`,
    ).toEqual([]);
    expect(coveredSites, `no covered module is in the abstention — ${summary}`).toBeGreaterThan(0);

    // The residue is the half of the population this card did NOT cover. It is
    // asserted to EXIST so the coverage claim can never read as total: when it
    // reaches zero this expectation fails and a person decides what that means.
    expect(residue.length, `the residue is empty — ${summary}`).toBeGreaterThan(0);
  });
});
