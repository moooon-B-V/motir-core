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
  'components/planning/PlanItemNode.tsx':
    'the plan canvas node and its inline diff overlay — MOTIR-4030',
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

// ⚠️ MOTIR-4246's two `/items` modules — `issueColumns.tsx` and
// `IssueTreeTable.tsx` — were entries here until that card shipped (#2543). They
// are gone rather than re-pointed: the fix moved both sites OFF `--el-text-muted`
// (to `--el-text-identifier` and `--el-text-secondary`), so neither module carries
// a muted site at all any more and neither is in the abstention for this guard to
// defer on. Its own render-time guard is `tests/components/items-row-ink.test.tsx`.
// This test is what caught the stale pointer, which is the job it was written for.

/**
 * Composed surfaces the sweep does NOT cover, each with the card that owns it or
 * the reason it is out. AC 5 of MOTIR-4251: a coverage claim owes its population,
 * and the half of a population you did not cover is the half nobody re-reads.
 */
export const UNCOVERED_WITH_OWNERS: Readonly<Record<string, string>> = {
  'components/planning/PlanItemNode.tsx#remove':
    'MOTIR-4260 — the module IS covered (the render sweep mounts its `modify` ' +
    'state), but its `remove` STATE paints the title in `--el-text-muted` on the ' +
    'node’s own `--el-muted` frame at 4.12:1. Found by this guard on its first ' +
    'run; the state is not mounted because the case would ship red. That card ' +
    'carries the fix and the mount.',
};

/**
 * The MODULE an `UNCOVERED_WITH_OWNERS` key names. An entry may be scoped to one
 * STATE of a module — `path#state` — and the membership check below is about
 * modules, so a state-scoped key is checked by its module half rather than
 * skipped. A `path#state` deferral whose module has left the abstention is
 * exactly as stale a pointer as a bare one, and skipping it would also let this
 * check go VACUOUSLY green the moment the last bare entry is resolved — the
 * shape this file's own header is written against.
 */
const moduleOf = (file: string) => file.split('#')[0]!;

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

  it('every module named as UNCOVERED is one the static walk really abstains on', () => {
    // The mirror of the check above. An entry here that is NOT in the hole is a
    // deferral pointing at nothing — the shape `run.md`'s "a recorded deviation
    // that names an open defect is a card, never a paragraph" warns about, with
    // the paragraph dressed as a citation.
    const keys = Object.keys(UNCOVERED_WITH_OWNERS);
    const notAbstained = keys.filter((f) => !modules.has(moduleOf(f)));
    expect(notAbstained).toEqual([]);
    // …and the check above has something to rule on. An empty deferral list
    // satisfies it for free, which is the one way it can pass without meaning
    // anything: when the residue is finally all owned or all fixed, this fails
    // and a person retires the list rather than leaving a tautology behind.
    expect(keys.length).toBeGreaterThan(0);
  });

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
