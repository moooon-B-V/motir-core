# `design/agent-sandbox` — the agent sandbox guide

**Story MOTIR-2268 · Subtask MOTIR-2270.** The published guide for adopting the
confined container an unattended `motir auto` run executes in. Route:
**`/docs/sandbox`**. One area, one three-file asset:

| File                      | What it is                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `design-notes.md`         | this spec — structure, primitives, tokens, ownership           |
| `agent-sandbox.mock.html` | the SOURCE, built from the real design system (three panels)   |
| `agent-sandbox.png`       | the full-page export a reviewer skims without opening the HTML |

Built against ADR **Amendment 8** (`docs/decisions/public-api-conventions.md`,
Subtask MOTIR-2269), which pins the route (Q1), the boundary between this page
and `packages/cli/sandbox/README.md` (Q2), and `AGENT_PROFILES` as the profile
table's single derivation source (Q3). This asset draws to those answers; it does
not re-decide them.

> **Why its own area, and not an amendment to `design/api-docs/`.** This is a new
> feature with its own content, its own procedure and its own failure modes. It
> only happens to be served by a shell somebody else designed. Folding it into
> that area's asset would bury a feature inside a file about a different one, and
> would make every future reader of `design/api-docs/` read past it. **The
> `design/api-docs/` asset is not touched by this story.**

---

## ⚠️ What this design does NOT own

| Element                                              | Owned by                                     | What THIS design does                                                                   |
| ---------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| The docs shell — rail, content column, `toc` aside   | `design/api-docs/` (Story 11.4 · MOTIR-2188) | Mounts into it unchanged. Reproduced in the panels only as the frame this page sits in. |
| `DocBlocks`' `prose` / `code` / `callout` kinds      | `design/api-docs/` (11.4.8 · MOTIR-2189)     | Uses them as-is. Adds a `table` kind beside them (below), changing none.                |
| The marketing top bar and footer                     | `design/project-square/` (Story 6.13)        | Nothing.                                                                                |
| The sandbox image itself                             | Story MOTIR-809 (`packages/cli/sandbox/`)    | Nothing. Every fact drawn here is READ off the shipped artifact.                        |
| The route, the ownership rule, the derivation source | ADR Amendment 8 (MOTIR-2269)                 | Draws to them.                                                                          |
| The `/api-docs` → `/docs` route move                 | MOTIR-2286                                   | Draws the destination, not the migration.                                               |

**The one thing it changes in someone else's surface** is the rail's entry list:
one row, drawn in Panel 3.

---

## ⚠️ The page is a PROCEDURE, and is drawn as one

The structure is the design decision on this page, not a container for it. A
reader here is not learning an API — they are **setting a thing up**, once, and
the difference between doing it right and doing it wrong is an agent running
loose on their laptop versus one that cannot reach it. So the page reads as:

```
  lede
  What it confines — and what it does not     ← why you would want this
  Before you start                            ← preconditions, and the workspace root
  1 · Pick your profile
  2 · Give it a Motir credential
  3 · Run it
  4 · Or run it in VS Code instead            ← 4.1 · 4.2 · 4.3
  → the README, for everything past the first ten minutes
```

Two things this ordering buys, both of which the first drafts got wrong:

- **A step cannot be written before its inputs exist.** The `docker run` needs a
  tag, a credential mount and an agent command — so the profile matrix is
  **step 1**, before the command, not a reference table below it.
- **The VS Code path is a numbered STEP, not a closing paragraph.** As prose at
  the bottom it is a footnote nobody scrolls to; as `4 ·` with its own sub-steps
  it is visibly one of the two ways to run this.

The numbered-`h2` rhythm is the shipped one — the sibling getting-started page
already reads `1 · Mint a token`, `2 · Your first call`, … — so this page is
consistent with its neighbour rather than inventing a form.

### Before you start — three preconditions, and the folder

A two-column `table.spec` (what you need / how to get it). Each row is something
that makes the run fail **later and less legibly** if it is missing:

| Precondition                                         | Why it is on the page                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Docker running**                                   | The images are `linux/amd64` **and** `linux/arm64`, so Apple Silicon is first-class and nothing is emulated. Says "there is no build step — you pull." |
| **A Motir token + server URL**                       | Names where to mint it, then defers HOW to hand it over to step 2 rather than answering the same question twice.                                       |
| **The agent's own sign-in, already on this machine** | The non-obvious one. The credential mount is **read-only**, so the container can USE a sign-in and can never PERFORM one.                              |

Then an `h3` — **"And run everything from your workspace root"** — with a
directory-tree code block. A Motir project spans several repositories and
`motir auto` works across all of them, so what gets mounted is the folder that
_contains_ the checkouts. The tree makes that visible in a way the sentence "not
a checkout inside it" does not.

> **⚠️ The page does NOT explain `.motir.json`, deliberately.** An earlier draft
> named that file five times and then documented its fields, its secret-freeness
> and its upward resolution. **The reader does not have one and does not make
> one — `motir link` writes it.** The only thing they must get right is WHICH
> FOLDER, and the tree says that. Naming the file at all would raise a question
> ("do I need to edit this?") the page then has to answer, on a surface whose
> boundary rule is _the first ten minutes and only facts a test can hold true_.
> The file's shape is CLI reference and belongs in `docs/cli.md`.

The section closes with a `callout` (info) for `motir doctor` — the affordance
that turns all three preconditions into one command, and the same command inside
the container.

---

## ⚠️ Step 1's PROFILE MATRIX — the one genuinely new element

`DocBlocks` branches on `prose` and `code` only; there is no table. The shipped
`table.spec` markup this matrix uses already exists inside
`app/(public)/docs/_components/OperationSection.tsx`, so the choice was never
_"invent a table"_ — it was **which of the two existing homes the second caller
lives in.**

**It is a shared `table` block kind in `_components/DocBlocks.tsx`, not a
page-local component.** That sentence is what the page card implements.
Promoting it gives the whole documentation surface one table treatment; leaving
it page-local guarantees the next page draws a second one slightly differently.
The block declares `{ kind: 'table', caption?, columns, rows }`, renders
`table.spec` at width and the `.pcard` stack below the breakpoint — and this page
alone is its consumer **four times over** (confinement, preconditions, the
matrix, the step-3 substitutions), which is the argument for the shared kind
made by the page itself.

### Wide — FOUR columns, not five

The card framed the matrix as five columns × eight rows. Five is the version that
fails: `binary` folds into column 1 as the spec table's **existing** `.nm` /
`.ty` two-line cell, the same treatment the parameter tables already use.

| Column                    | Content                                                    |
| ------------------------- | ---------------------------------------------------------- |
| **Profile · binary**      | `.nm` = the profile id · `.ty` = the binary it installs as |
| **Tier**                  | `pill--tier1` / `pill--tier2`                              |
| **Installed from**        | prose + `code` for the package name                        |
| **Credential mount (ro)** | one `.mount` chip per path, stacked                        |

- **`pill--tier1` = `--el-tint-mint`, `pill--tier2` = `--el-tint-yellow`** — two
  tint SLOTS, not two shades of one hue, so the distinction survives a palette
  swap and reads without a legend. Both carry `--el-text-strong` on the tint for
  AA, and the tier is in the TEXT, never colour alone.
- **A mount is a PATH, so each is its own `.mount` chip** (`--el-code-bg` /
  `--el-code-text`, `--radius-kbd`), stacked when a profile has several —
  `opencode` has two, and wrapping them as one line would read as one path.
- **The empty case is `.mount--none`** — an em dash plus the reason (`— OS
keyring`), in `--el-text-faint`, non-mono. A blank cell reads as "we forgot".
- **Eight rows.** `AGENT_PROFILES`, `sandbox/smoke/profiles.json` and the
  README's own prose all say eight; `base` is the agent-less image TAG, drawn in
  a `callout` **beside** the table. Putting it in as a ninth row is exactly the
  confusion that callout prevents.

### Narrow — one CARD per profile (`.pcard`)

Panel 2, at 390 px. A `.pcard-head` (profile id + tier pill) over a two-column
`<dl>` with a 78 px label column: BINARY / INSTALLED / MOUNTS. Not a horizontally
scrolling table and **not hidden columns** — every fact a reader is choosing on
stays visible, and someone deciding whether to trust a container with their
credentials is exactly the person reading this on a phone first.

---

## Step 3 — the command is a SHAPE, then an example

**⚠️ This is the fix for the sharpest defect in the drafts.** An earlier pass drew
a single `docker run` under the heading _"The one command"_, and that command was
`claude`'s in **three** separate places: the image tag, the credential mount, and
the `--agent` invocation. Seven of the eight profiles would have copied something
wrong three times over, from a heading promising it was universal.

Drawn instead as **shape → what changes → filled-in example**:

1. A **non-copyable** `codeblock` (caption `sh · the shape`) with
   `<profile>` / `<credential mount>` / `<your agent's command>` in place.
2. A three-row `table.spec` — the part / where it comes from / the `claude`
   value — cross-referencing step 1's columns by name.
3. The `claude` version **with** the `Copy` affordance and a caption that says to
   swap the three parts.

**The copy affordance is on the filled-in block only.** A copyable template is a
command that fails in the terminal; that asymmetry is the design, not a detail.
Two notes carry what the placeholders flatten: a profile with two mounts takes two
`-v` lines, one with none takes none.

**`<your agent's command>` is the one part this page cannot source from itself.**
The vendor non-interactive + auto-approve flags drift between releases, so under
Amendment 8 Q2's second limb — _a fact belongs here only if a test can hold it
true_ — they stay in the README, and the table points there **by name**. That is
the honest form of a fact the page must not own.

---

## Step 4 — VS Code, and the file NOT to copy

Three sub-steps (`4.1` install the extension · `4.2` add
`.devcontainer/devcontainer.json` · `4.3` Reopen in Container), opening with a
`callout` (info) restating that every precondition still applies, because it is
the same image and the dev container adds exactly one thing to the list.

**⚠️ Checked against the shipped artifact, and it changed what the page says.**
Every `devcontainer.json` under `packages/cli/sandbox/devcontainer/` carries a
**`build` block** — `"dockerfile": "../Dockerfile"` with the repository root as
`"context"` — so those files build from a **checkout**. They are motir-core's own
dev containers. Pointing a reader at them would contradict this page's entire
premise in the one section they are most likely to copy-paste from, and the wrong
file is the one they would find first.

So the page draws the form the README's own _"to use one for your own workspace"_
paragraph prescribes: **drop `build`, pin the published image**, keep every other
key verbatim — `workspaceFolder`, `workspaceMount`, `mounts`, `remoteUser`,
`overrideCommand`, `remoteEnv` (which forwards `MOTIR_TOKEN` / `MOTIR_SERVER`, so
a machine that never ran a host login still resolves a credential) — with
`postAttachCommand` as **`motir doctor`** rather than `motir --version`, so the
preconditions check runs on the way in. A `callout` (warning) names the committed
files explicitly.

---

## Panel 3 — the rail's fourth entry, the ACCESS PATH

The page's **only** entrance; nothing else in the product routes to it. Drawn in
place: a plain label row like the other three, `aria-current="page"` on the
active one, and the check this panel exists to make — at four rows the group
still reads as a list of documents and needs **no treatment it did not need at
three**.

---

## GIVES / TAKES

| `MOTIR-` key                         | GIVES / TAKES | What                                                                                                                        |
| ------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-2270** (this card)           | GIVES         | this area's three files: the procedure, the matrix presentation, `.pcard` / `.mount` / `pill--tier*`, the rail's fourth row |
| **MOTIR-2271** (the page)            | TAKES         | builds the page, the shared `table` block kind, and the rail entry                                                          |
| **MOTIR-2286** (the route migration) | TAKES         | moves `/api-docs*` → `/docs*`; this asset draws the destination                                                             |
| **MOTIR-2269** (the decision)        | GIVES         | ADR Amendment 8 — route, ownership rule, derivation source. Drawn to, not re-decided                                        |
| **MOTIR-2188** (11.4.7, `done`)      | —             | owns the shell, the rail component and `table.spec`. Mounted into, unchanged except the rail's entry LIST                   |
| **MOTIR-2189** (11.4.8, `done`)      | —             | owns `DocBlocks`' three kinds. The `table` kind is ADDED beside them, changing none                                         |

**No criterion on a `done` card changes, and `design/api-docs/` is not edited.**

---

## Light and dark

Every colour resolves to an `--el-*` token, so dark mode is the token layer's
job. The token block and shell classes are copied 1:1 from
`design/api-docs/api-docs.mock.html` (which took them from `app/globals.css`), so
this page cannot drift from the surface it mounts in. The mock's toggle flips
`data-theme` on `<html>`; review both. Worth checking on the flip: the two tier
tints stay mutually distinguishable, and `.mount` chips read as raised against
`--el-page-bg` rather than as holes.

**No invented colour.** The only non-token values are the review-page chrome —
the panel labels and the toggle — which are not part of the design.

---

## Accessibility

- Tier is carried in **text** (`Tier 1` / `Tier 2`); the tint is redundant
  reinforcement, and every tint chip pairs its hue with `--el-text-strong` for AA.
- The rail is a `<nav aria-label="API reference">` (11.4's, unchanged); the
  current page carries `aria-current="page"`.
- Code blocks are `<pre>` inside a labelled container, so a screen reader
  announces the caption — including the two that distinguish the template from
  the copyable command.
- The narrow profile cards are `<dl>` pairs, so each fact keeps its label when
  the columns collapse.
- Wide code blocks scroll inside their own container; the page never scrolls
  sideways at any viewport.

---

## What the code cards build from this

| Card           | Builds                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **MOTIR-2286** | the `/api-docs` → `/docs` route migration this page's route depends on                                  |
| **MOTIR-2271** | the page, the shared `table` block kind in `DocBlocks`, and the rail's fourth entry                     |
| **MOTIR-2272** | the vitest gate: the derivation seam, the boundary invariants, the coverage floor                       |
| **MOTIR-2273** | the E2E: a reader with no session finds the guide from the rail and leaves with a runnable `docker run` |
