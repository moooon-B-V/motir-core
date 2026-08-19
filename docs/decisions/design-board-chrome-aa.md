# ADR: A design board's own CHROME owes AA — there is no mock-annotation exemption

- **Status:** Accepted (2026-08-19)
- **Story / Subtask:** Bug MOTIR-3054 (the design tree's other 277 failing ink/surface pairs) · filed by MOTIR-3014
- **Extends:** MOTIR-2455's measured contrast table (`motir-core/CLAUDE.md`) and
  MOTIR-3014's design-asset arm of the ink-contrast guard
  (`tests/theme/inkContrastMockScan.ts`).
- **Consumed by:** every `design/<area>/*.mock.html`, the guard that reads them,
  and MOTIR-3068 (the `--el-text-faint` population, declined here for size).
- **Supersedes / superseded by:** none. It CLOSES boundary (2) of
  `inkContrastMockScan.ts`'s header, which existed to hold the question open
  until it was answered.

> Structured **Context → Decision → Consequences → References**, the convention the
> repo's ADRs set. What ships with this decision is one token swap in 51 assets and
> the removal of a filter. What it freezes is the answer, and the reason the
> obvious-looking alternative was not taken.

---

## Context

### The question

A design mock is two artefacts in one file. It carries the **product surface** it
specifies — the rows, controls, panels an implementer copies into code — and the
**board** that surface is presented on: the panel captions, the numbered
annotations, the fold measurements a reviewer navigates by. Both are painted by
the same stylesheet, and nothing in the markup separates them.

The product surface plainly owes the product's accessibility contract; it IS the
product, one step before it exists. The board is read by exactly one person, on a
PNG, while accepting a Story. Holding it to the same 4.5:1 is a decision somebody
has to make rather than a fact to look up — which is why MOTIR-3014 shipped its
guard enforcing only the layer it could rule on without answering this, and said
so in its header rather than leaving the gap silent.

The clearest fixture is
`design/work-items/repository-set-quick-view.mock.html`'s `.foldNote`:
`--el-text-muted` on a tinted strip, reading _"MEASURED at 1280×900: the modal is
680px"_ — text no user will ever see, and text a reviewer of the asset does.

### What the population actually contained

The decision was framed around that fixture, and the fixture turned out to be
unrepresentative. Classified by the class that carried the ink, the 277
stylesheet-declared findings are dominated by the PRODUCT surface, not the board:

| class                                               | findings | what it is                                                    |
| --------------------------------------------------- | -------- | ------------------------------------------------------------- |
| `.drill`                                            | 29       | a roadmap drill-down row                                      |
| `.tbtn`                                             | 28       | a toolbar button                                              |
| `.chev` / `.lane-chevron`                           | 39       | collapse affordances on a backlog region and a board swimlane |
| `.mnum`                                             | 14       | a roadmap month header                                        |
| `.meta`                                             | 9        | a sprint header's metadata line                               |
| `.icon-btn`                                         | 8        | an icon button                                                |
| `.st-sub` / `.rail-sub` / `.station-sub`            | 14       | secondary lines in shipped rails                              |
| `.pr-meta` / `.lr-id` / `.col-count` / `.q-snippet` | 21       | GitHub PR metadata, link ids, column counts, a triage snippet |
| **`.foldNote`**                                     | **5**    | **the board annotation the question was framed around**       |

`.caption`, `.lede`, `.panelNote`, `.sw-cap` and their siblings — the genuine
board chrome — are a minority. An exemption sized for the whole population would
have been granted on the strength of its clearest example rather than its actual
contents.

### What an exemption would have cost

The card's own second question was the right one: an exemption the guard can see
has to be STRUCTURAL — a `data-mock-chrome` attribute on the annotation layer, a
reserved class prefix, a wrapper element — never a list of class names in the
scanner, which is the allowlist `inkContrastLint`'s header argues against at
length. Priced out, that is:

- **an edit to every annotation in 126 mocks**, plus a standing obligation on
  every future one, against **one token per rule, 86 lines**, for compliance;
- **a hole exactly where the guard is load-bearing.** A marker is inherited: the
  moment a product element sits under a marked wrapper — or an author copies a
  marked panel as a starting point, which is how mocks are actually written — the
  guard goes quiet on the product surface. That is the failure this guard exists
  to prevent, reintroduced by its own exemption, and it fails SILENTLY, which is
  the direction that never gets argued with.

### And the chrome is read by a person

The last argument runs the other way from where it looks. The board's annotations
exist to be read — by Yue, accepting a Story from a PNG (Principle #18). Ink that
measures 4.12–4.34:1 on a tinted strip is not a stylistic choice there either; it
is the same legibility problem, on the surface where the product's own review
happens. "It is not product UI" is true and is not a reason to make it harder to
read.

---

## Decision

**A design board's own chrome owes AA. There is no mock-annotation exemption, and
none is to be introduced.**

Concretely:

1. `--el-text-muted` may not carry text over `--el-surface`, `--el-surface-soft`
   or `--el-muted` anywhere in `design/**` — in a `text-(--el-text-muted)`
   utility class, in a rule in the mock's own `<style>` block, or in an inline
   `style` attribute. The reach of the rule does not depend on which layer the
   ink was written in.
2. The only exemptions are the two WCAG 1.4.3 grants, **declared on the element**
   and never inferred: `aria-hidden` / a labelled `role="img"` for a decorative
   glyph, and `disabled` / `aria-disabled` for inactive text. These are the same
   two `inkContrastScan` takes on the code side.
3. `tests/theme/inkContrastMockScan.ts`'s `violations()` carries no `via` filter,
   and the scanner carries no allowlist. The guard is enforced at zero.
4. The ink to reach for instead is `--el-text-secondary` — 6.18–6.80:1 on all
   four surfaces in both themes, so it is right whichever surface the element
   lands on.

**This decision is spent for any future decline.** A later boundary in this guard
may be declined for SIZE, or for a measured property of the population, but not
on the grounds that a mock's chrome is outside the product's contract. That
question is answered.

---

## Consequences

### What shipped with it

51 mocks, 86 lines: 71 stylesheet rules and 15 inline `style` attributes swapped
from `--el-text-muted` to `--el-text-secondary`, and every touched asset's `.png`
re-exported (`CLAUDE.md` § design assets — all three files or none). The scanner's
census over `design/**` is `0` violations, from 277.

### The re-export cost is now a tool, not a per-card tax

The card predicted that a tree-wide sweep would be dominated by the re-render
rather than the edit, and it was right — which is why
`scripts/render-design-mock.mjs` ships with this decision rather than a throwaway
script. It searches the viewport width out of the committed PNG (a full-page
screenshot is as wide as the DOCUMENT, so an overflowing mock's viewport is
narrower than its export), renders the asset AS IT STANDS AT `HEAD` first, and
reports per file whether the committed export is reproducible:

| verdict | assets | meaning                                                                            |
| ------- | ------ | ---------------------------------------------------------------------------------- |
| `EXACT` | 27     | the baseline render is byte-identical, so the new PNG differs by exactly this diff |
| `DIMS`  | 2      | same dimensions, different bytes — a renderer-build difference with no reflow      |
| `DRIFT` | 19     | different height: the committed export predates an environment change              |

**The DRIFT split is by DATE, not by asset**: every PNG last exported before
~2026-06-20 drifts, every one after it is `EXACT`. So a drifting asset's height
delta belongs to the months since its last export, not to this diff — and
re-exporting it closes that gap rather than opening one.

Two things the search had to learn, both of which fail loudly enough to be worth
recording. A full-page screenshot is as wide as the DOCUMENT, so an overflowing
asset's viewport is NARROWER than its export (`design/backlog/backlog-scale.png`
is 2380 wide from a 1160 viewport); and `deviceScaleFactor: 2` is the convention
but not a law — `design/onboarding-migrate/onboarding-migrate.png` is 1200×4755,
an ODD dimension a 2× render cannot produce, and rendering it at half the
intended viewport reflows it to three times its height. Both are searched now
rather than assumed.

Three mocks (`design/boards/board.mock.html`, `design/work-items/links.mock.html`,
`design/work-items/list.mock.html`) have no `.png` at all, which predates this
card and is filed as MOTIR-3069.

### What is NOT settled by this

`--el-text-faint` — 1745 findings across 101 files, an ink that clears AA on NO
surface (2.37–2.61:1). It is declined for **size**, and the scanner reports its
findings (`ink: 'faint'`) so that the decline has a measured subject rather than a
sentence. `MOTIR-3068` owns it. Because the two declines look identical from the
outside, the scanner's header names the reason for each explicitly — a decline
whose stated reason has been refuted is exactly the shape a later reader
re-derives from the same clearest example.

### The authoring rule this creates

Every new `.mock.html` inherits it: micro-labels, captions, annotations and fold
notes take `--el-text-secondary`, not `--el-text-muted`, on any tinted surface —
and `--el-text-muted` on the white page/card remains legal (4.54:1) but is a
narrow win, so the safe default across a mock is `--el-text-secondary`. The rule
is stated in `motir-core/CLAUDE.md` § design assets, which every coding agent
in this repo auto-loads.

---

## References

- `tests/theme/inkContrastMockScan.ts` — the guard, its header, and the boundary
  this ADR closes.
- `tests/design-ink-contrast.test.ts` — the spec, its fixtures, and the
  non-empty assertion that keeps the remaining boundary honest.
- `tests/theme/inkContrastScan.ts` / `tests/theme/inkContrastLint.test.ts` — the
  code-side guard this mirrors, and its own argument against an allowlist.
- `motir-core/CLAUDE.md` — MOTIR-2455's measured contrast table, and the
  three-file design-asset rule.
- `scripts/render-design-mock.mjs` — the re-export tool and its verdict table.
- `docs/decisions/design-result.md` — how a design card's result reaches the
  work item, which is the surface the board chrome is actually read on.
