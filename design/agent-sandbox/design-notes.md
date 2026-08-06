# `design/agent-sandbox` — the agent sandbox guide

**Story MOTIR-2268 · Subtask MOTIR-2270.** The published guide for adopting the
confined container an unattended `motir auto` run executes in. Route:
**`/docs/sandbox`**. One area, one three-file asset:

| File                      | What it is                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `design-notes.md`         | this spec — structure, primitives, tokens, ownership           |
| `agent-sandbox.mock.html` | the SOURCE, built from the real design system (three panels)   |
| `agent-sandbox.png`       | the full-page export a reviewer skims without opening the HTML |

Built against ADR **Amendment 9** (`docs/decisions/public-api-conventions.md`,
Subtask MOTIR-2269), which pins the route (Q1), the boundary between this page
and `packages/cli/sandbox/README.md` (Q2), and `AGENT_PROFILES` as the profile
table's single derivation source (Q3). This asset draws to those answers; it does
not re-decide them.

> **⚠️ WHAT THIS PAGE IS.** It **sets the container up**, and it ends when the
> reader has a working one. It does **not** teach the work loop that runs inside
> it — `motir auto` / `motir next` / `motir run <key>` are CLI concerns, they
> behave identically on the host, and none of them is about the container. The
> page names them once, in a closing _What next_, and hands off. Drawing the
> setup and the usage as one thing is what produced two earlier defects: a
> `docker run` that ended in an unattended work loop, and a reader who reasonably
> concluded `motir auto` was the thing that starts the sandbox.

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
| The route, the ownership rule, the derivation source | ADR Amendment 9 (MOTIR-2269)                 | Draws to them.                                                                          |
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
  Before you start                            ← two preconditions, and which folder
  1 · Pick your profile
  2 · Start the container
  3 · Or start it from VS Code instead        ← 3.1 · 3.2 · 3.3, REPLACING step 2
  4 · Sign in                    (motir login)   ┐
  5 · Link the folder to your project (motir link)│ inside the container,
  6 · Check it                   (motir doctor)  ┘ the same either way
  What next                                   ← the hand-off, not a seventh step
```

Two things this ordering buys, both of which the first drafts got wrong:

- **A step cannot be written before its inputs exist.** The `docker run` needs a
  tag, a credential mount and an agent command — so the profile matrix is
  **step 1**, before the command, not a reference table below it.
- **The VS Code path is a numbered STEP, not a closing paragraph.** As prose at
  the bottom it is a footnote nobody scrolls to; as `4 ·` with its own sub-steps
  it is visibly one of the two ways to start this. Its lede says the three
  sub-steps **replace** step 3 rather than following it, so the two are read as
  alternatives.
- **A setup guide ends with a CHECK, and step 5 is it.** `motir doctor`, run
  inside the container, against the same three things _Before you start_ checked
  on the host — asking a different question there: not _"is my machine ready"_
  but _"did the container actually get what I passed it"_. All three green is a
  stated finish line, which is what lets the page stop rather than trail off.

The numbered-`h2` rhythm is the shipped one — the sibling getting-started page
already reads `1 · Mint a token`, `2 · Your first call`, … — so this page is
consistent with its neighbour rather than inventing a form.

### ⚠️ The container comes FIRST, then the sign-in — not the other way round

**The order is: start it → `motir login` → `motir link` → `motir doctor`, and all
three of those run INSIDE the container.** An earlier drawing had the reader mint
a Motir token on the host and pass it in, which made an account chore a
precondition of a page about Docker, and quietly picked the tier meant for CI as
the default for a laptop.

`motir login` is the default because the container is exactly the machine it was
designed for: a device grant prints a code and a URL, the human approves it in a
browser anywhere, and the container polls. Nothing has to exist on the host
first. Two consequences the drawing must carry:

- **The step-2 command mounts no `~/.config/motir`.** A read-only bind over it
  leaves `motir login` nowhere to write — the README says it "cannot persist over
  a `:ro` bind, and says so in one sentence rather than dying on an `EROFS`".
- **⚠️ There is no `--rm`, and the container is named.** _"the login persists for
  the container's life (and dies with `--rm`, like the rest of the ephemeral
  layer)"_ — so a `--rm` run throws the sign-in away on exit, and a setup guide
  whose central step is a sign-in cannot use one. The drawing says
  `--name motir-sandbox` and tells the reader to come back with
  `docker start -ai motir-sandbox`. This is the one place the page departs from
  the README's own `docker run --rm` examples, and it departs deliberately: those
  examples are one-shot runs, and this is a setup.

The two remaining preconditions are **Docker** and **the agent's own sign-in on
the host** — and the page now says explicitly that the Motir CLI is not among
them, because it ships in the image.

### `motir link` is a STEP, and its happy path is empty

`motir link` binds the mounted folder to a project, and it was missing entirely
until review caught it. Drawn as step 5 with its cheap case stated first:
**"if your workspace has exactly one project, that is the whole step."**
Verified, not assumed — `projectLink.ts:72` is
`if (projects.length === 1 && only) return { project: only, sole: true }`, and the
command's own `--project` help reads _"Omit it and the workspace's only project is
used."_ With several, an interactive shell gets a numbered picker and a
non-interactive one is told to pass `--project <key>`; both are named in one
sentence so neither reader is surprised.

**This also moved `.motir.json` out of the preconditions for good.** Linking now
happens inside the container, after the mount, so the host section only has to
say _which folder you are mounting_ — which is what the directory tree was always
actually for.

### Before you start — two preconditions, and the folder

A two-column `table.spec` (what you need / how to get it), down from three rows
to two. Each is something that makes the run fail **later and less legibly** if it
is missing:

| Precondition                                         | Why it is on the page                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Docker running**                                   | The images are `linux/amd64` **and** `linux/arm64`, so Apple Silicon is first-class and nothing is emulated. Says "there is no build step — you pull." |
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

### The `Tier` column must SAY what a tier is — or it is decoration

A reader asked "what is tier?" of the first drawing, which is the whole finding:
the column showed `Tier 1` / `Tier 2` pills and the page never defined them, so
it carried a fact nobody could act on. Step 1's lede now answers it in reader
terms, and the phrasing is deliberate:

> **Tier is how closely we track the vendor, not whether it works.** Every
> profile is published, and every one is built and smoke-tested before a release
> ships. Tier 1 pins the install source AND the credential location and verifies
> them on every change. Tier 2 installs from a vendor endpoint we do not
> control, so day-to-day breakage there is reported rather than blocking.

**Checked, because the two lanes differ and the obvious summary is wrong.**
`smoke/profiles.json` says _"Tier 2 is allow-fail in CI"_, which reads as "tier 2
is less reliable" — but the README's release section says _"**On the release lane
every tier gates**: a release that quietly shipped six of eight images, green, is
worse than one that failed"_, and _"A Tier-2 vendor can block a release, on
purpose."_ So allow-fail is the PULL-REQUEST lane only. Publishing "tier 2 is not
gated" would have been a published untruth about the thing a reader is deciding
on. The drawn sentence separates the two lanes without naming either, because a
reader of a public guide does not have our CI.

### ⚠️ `Tier` means two different things on this page — so step 2 no longer says it

Step 2's three ways to supply a Motir credential are _"the three tiers"_ in the
README and in `serverResolve.ts`'s own comments. Drawn as a column headed **Tier**
directly under the profile matrix's **Tier** column, that is two unrelated
meanings of one word, adjacent, on the surface where a reader is deciding. Step
2's column is **"The way in"** and its lede says "three ways", not "three tiers".
The README keeps its own vocabulary; the page does not inherit a collision from
it.

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

## Step 3 — START the container; the command is a SHAPE, then an example

**⚠️ Two defects were fixed here, and the second one reframed the page.**

**First: the command was `claude`'s.** An earlier pass drew a single `docker run`
under the heading _"The one command"_, claude-specific in the image tag, the
credential mount and the `--agent` invocation. Seven of the eight profiles would
have copied something wrong three times over, from a heading promising it was
universal. Drawn instead as **shape → what changes → filled-in example**:

1. A **non-copyable** `codeblock` (caption `sh · the shape`) with
   `<profile>` / `<credential mount>` in place.
2. A two-row `table.spec` — the part / where it comes from / the `claude` value —
   cross-referencing step 1's columns by name.
3. The `claude` version **with** the `Copy` affordance and a caption that says to
   swap the two parts.

**The copy affordance is on the filled-in block only.** A copyable template is a
command that fails in the terminal; that asymmetry is the design, not a detail.
Two notes carry what the placeholders flatten: a profile with two mounts takes two
`-v` lines, one with none takes none.

**Second: the command ENDED IN A WORK LOOP, and it should not.** It ran
`motir auto --agent "…"`, which is not setup — it is the unattended loop you run
_after_ you are set up. Two things followed from that mistake, and both are
evidence for the scope line at the top of these notes:

- The substitution table needed a third row, `<your agent's command>`, for a fact
  **this page cannot source from itself** — the vendor auto-approve flags drift
  between releases, so under Amendment 9 Q2's second limb they cannot live on a
  page whose rule is _only facts a test can hold true_. A setup guide that does
  not run the agent does not need them, and the row is gone.
- A reader asked _"why is `motir auto` in the docker command? I thought
  `motir auto` runs a task in the sandbox"_ — a reasonable inversion for a page
  that used the name without defining it. Checked: `program.ts` registers `auto`
  as _"Drain the ready set unattended: one item at a time onto a session
  branch"_, the CLI has **no** sandbox or docker command, and nothing under
  `packages/cli/src/` spawns a container. `motir auto` never starts a sandbox; it
  runs inside one.

So the command now **ends at the image name** and drops the reader into a shell in
`/workspace`. Two placeholders, not three. The work loop is named once, in
_What next_, with its flags delegated to the README.

## Step 5 — the finish line, and why it is `motir doctor` again

The same command as _Before you start_, run **inside** the container, against the
same three things — and that repetition is deliberate, not an oversight. On the
host it answers _"is my machine ready"_; in the container it answers _"did the
container actually get what I passed it"_, which is the only question a setup
guide can end on. A three-row `table.spec` says what each check proves in terms of
the steps that produced it: the workspace check proves you mounted the root rather
than a checkout inside it (step 3's commonest error), the credential check names
which of step 2's three ways it used, and the agent check proves step 3's
read-only mount actually landed.

**"All three green is the end of this page"** is stated in those words. A guide
without a declared finish line trails off into whatever the author thought of
last, which is exactly how the work loop got into it.

## What next — a hand-off, not a sixth step

Deliberately **unnumbered**, so it reads as the boundary rather than more
procedure. It names `motir next`, `motir run <key>` and `motir auto` once each,
says they behave identically on the host, and states why they are not here:
_none of them is about the container_. The `motir auto --agent` flags and the
README's deep reference (digests, confinement proof, validation harness, the
tier-3 escape hatch) share the closing callout.

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
| **MOTIR-2269** (the decision)        | GIVES         | ADR Amendment 9 — route, ownership rule, derivation source. Drawn to, not re-decided                                        |
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
