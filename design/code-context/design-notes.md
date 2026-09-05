# Code — the surface, and the rule underneath it

**Story [MOTIR-1754] · design subtask [MOTIR-1764]. Repo `motir-core`.**
Asset set: `design/code-context/design-notes.md` + `code-context.mock.html` + `code-context.png`

- `code-context.dark.png`.

> ## ⚠️ REWORKED 2026-09-05 — the surface COLLAPSES and the tenancy rule changes
>
> This asset's first revision drew the freshness signal across two hosts — `/planning` and
> `/code-health` — with git left where it was, in the rail's bottom section. **That split is
> superseded, not restyled**, on two directions from Yue:
>
> 1. **Code health, the code index and git collapse into ONE left-nav row.** They were in two
>    different rail sections with opposite gating, and the code index had no surface at all.
> 2. **Visibility is per PROJECT; the code graph is shared per ORGANISATION.** A repository
>    connected to one project is not visible in another, and connecting one that another project in
>    the same organisation already uses does **not** index it again. _"The separation is about
>    visibility, not individual index."_
>
> **What SURVIVES from the first revision, unchanged and still drawn:** every freshness state
> (panels A–H), drift stated in COMMITS rather than as an age, `stale` and `indexing` kept apart with
> wait-and-return language belonging to `indexing` alone, the §10.3 aside anatomy inherited for the
> connect case, and the `localStorage` dismissal correction. Those were about _what the states say_;
> the rework is about _where they live and who can see them_.
>
> **What is SUPERSEDED:** the two-host split (panels 0 and E of the first revision), and the
> assumption that the repo set a project renders is the workspace installation's.

Three things were in two places with opposite gating, and one of them had no place at all:

|                 | where it was                                       | who could reach it               |
| --------------- | -------------------------------------------------- | -------------------------------- |
| **Code health** | primary project row → `/code-health`               | gated on `ai:configure` — admins |
| **Git**         | rail BOTTOM section → `/settings/workspace/github` | deliberately **ungated**         |
| **Code index**  | nowhere                                            | —                                |

They collapse into a single primary **Code** row with three sections, in the order a user meets them:
**Repositories → Index → Health**. You connect, it indexes, it is audited.

---

## 1. ⚠️ The rule underneath the surface — the repository belongs to the ORG

Everything below is a consequence of this, so it is stated first, in Yue's own framing.

- **A repository belongs to the ORGANISATION, and the organisation is the billing unit.**
- **So there is no privacy question between projects of one org**, and this design does not draw an
  isolation boundary. An **org admin can pull any of the org's repositories into any project — in the
  same workspace or a different one.**
- **One repository has ONE code graph, built once, shared across the org.** Adding a repository to a
  second project rebuilds nothing.
- **The per-project list is therefore VISIBILITY CONFIGURATION** — which repositories _this_ project
  works on, so its planner reads the right code and its surfaces are not a directory of everything
  the org owns. It is relevance, not secrecy, and **the copy must never imply otherwise.**

**The counterfactual is what settles it, and it is worth writing down because it is the argument
rather than the conclusion:** _if a repository did not belong to the org, the index would have to be
maintained per project_ — the same graph rebuilt N times and billed N times to answer a question
nobody asked. **That is the wrong design.** Not needing it is why the graph is org-keyed.

**Two readings that follow, and both are copy rules:**

- A repository the org already indexed reads **`current` the moment it is added to a project** — not
  `indexing`. There is no fifth verdict; the graph exists. **Copy must never say _"indexing…"_ for a
  repository that is already indexed**, which is a wait for an event that will not happen — the same
  failure panel D exists to prevent, one surface over.
- A repository absent from a project's list is absent because **nobody configured it there**, not
  because it is hidden. Panel S's copy says exactly that.

### 1.1 ⚠️ This is NOT what ships today — the tenancy audit

A tenancy change is a schema audit rather than a policy tweak, so here is the audit. Read on
`origin/main`:

|                               | today                                                                   | what this asset assumes                                                             |
| ----------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the graph's key               | `CodeRepo @@unique([aiProjectId, repoRef])` — **one graph per project** | one graph per `(organisation, repoRef)`                                             |
| the graph's cascade           | `onDelete: Cascade` from `AiProject` — deleting a project drops a graph | cascades from the org; a project leaving cannot drop a graph others use             |
| the planner's repo set        | `resolveCodeContext` → `listByInstallation` — the **workspace's** repos | the **project's** configured set                                                    |
| indexing                      | `codeGraphIndexService` fans out to **every project of the workspace**  | once per repository, per org                                                        |
| a repo in two projects        | **inexpressible** — `ProjectRepo.githubRepoId` is `@unique`             | the ordinary case                                                                   |
| the repo's own tenancy column | `GithubRepo.workspaceId` (MOTIR-1931) — workspace grain                 | the org owns the repository; workspace must not constrain which projects may use it |
| the isolation test            | MOTIR-1765 asserts _project A cannot read project B's row_              | the boundary is the **ORG**; that assertion is about the wrong tenant               |

The `@unique` row is the one that blocks the model outright, and it is a one-line schema fact rather
than a judgement: _"connect a repo to a second project"_ is currently inexpressible.

**None of that is this card's to build.** The tenancy move is its own story; [MOTIR-2029]'s decision
record is where it is argued and now decided. This asset draws the surface that model produces and
says plainly which of its states are unreachable until the model lands.

## 2. THE DOOR — one row, and one row leaves

**`Code`, a primary project row**, where `Code health` was. The rail's bottom section loses **`Git`**.

⚠️ **THE RAIL IS COMPOSED, NOT REDRAWN.** Its design of record is
`design/shell/rail-bottom-section.mock.html` + `design/shell/design-notes.md` § _The rail's bottom
section_, which enumerates the four rows that section carries and states its FLOOR as _Job runs ·
Git_. **After this, that floor is `Job runs` alone** — a real narrowing of a section that asset
measured deliberately, so **removing the row is an amendment to THAT asset, in another area, owned by
its own shell design-amendment card.** It is drawn here only so the door is visible; this asset does
not re-specify the rail.

The row order and glyphs drawn here are `app/(authed)/_components/SidebarNav.tsx`'s own.

### 2.1 ⚠️ The gating clash, and why it needed solving rather than picking a side

`/code-health` asserts `ai:configure`. The `Git` row is ungated, and `SidebarNav.tsx` says so on
purpose: _"Job runs and Git are NOT gated on this and must not be."_ The reason is in
`projectSettingsNav.ts` — connecting your own account is _"the one action nobody can take on
[a member's] behalf."_

So a naive collapse fails in one of two directions, and both are unacceptable:

- **one gated row** ⇒ every member loses the connect action — a CAPABILITY removed, which the
  audience rule forbids outright;
- **one ungated row** ⇒ an admin-only audit is widened to everyone, which `aiConventionService`'s own
  comments record as the thing its `ai:configure` mapping deliberately avoided.

**The resolution: the ROW is browse-reachable and each SECTION keeps its own gate.** This costs
nothing to build, because `/code-health` **already** renders an admin-only empty state rather than
refusing — panel H2 composes that state rather than inventing one. Repositories and Index are
browse-reachable; Health is admin-only _inside the page_.

**The test this has to pass, and panel H2 is drawn to show it passing: nothing a member could do
before is gone.**

---

## 3. REPOSITORIES — and the two different actions behind one old row

**The primary action is `Add or remove repositories`** — a `Button variant="primary"`, not a link.

**It replaces `Manage on GitHub`, and the change is not cosmetic.** The old label named a
_destination_; the new one names the _intent_. That matters because the destination is not one place:

| provider   | where the action goes                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- |
| **GitHub** | GitHub's own installation screen — repository selection is the host's, and Motir cannot perform it |
| **GitLab** | Motir's own project picker — the connection selects projects in-app                                |

**One label, two destinations — which is exactly why labelling by destination was wrong.** A user
looking for _"how do I add a repo?"_ was being asked to know that the answer is spelled _"manage"_ and
lives on another company's website.

**The picker offers every repository the ORG has**, not the workspace's — that is the set an org
admin may configure into any project (§1).

### ⚠️ 3.1 TWO actions lived behind the old `Git` row, and only one of them is this button

This is the capability check the collapse has to pass, and getting it wrong removes something a
member could do before:

| action                                                 | who                                                                                                                                                   | where it goes now                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Configure which repositories this project works on** | **org admin** — it is visibility configuration                                                                                                        | the `Add or remove repositories` button, in this section's header |
| **Connect YOUR OWN account**                           | **any member** — `GithubIdentity` is `userId @unique`, and `projectSettingsNav.ts` calls it _"the one action nobody can take on [a member's] behalf"_ | its own row in this section, visible to everyone                  |

Both reached `/settings/workspace/github`, which is what the `Git` row pointed at. **So removing that
row without carrying BOTH forward removes a capability rather than a concept** — the thing an
audience-preserving move is not allowed to do. Panel R draws the admin view and the member view side
by side precisely so the second one cannot be forgotten.

**A consequence for another surface:** `/settings/project/code-access` uses
`GITHUB_SETTINGS_PATH` as its `connectHref`. That link has to be re-pointed at the Code page, or the
member's door survives in this design and dies in the build.

**Removing a repository here removes it from THIS project.** It does not delete the org's graph,
which another project may still be using — and the copy says so, because "remove" over a shared asset
is exactly the word that invites the wrong assumption.

## 4. INDEX — the freshness section

Everything panels C · D · F · G · H draw, now living in a section instead of scattered across two
hosts. The rules are unchanged from the first revision and are restated here only where the collapse
touches them:

- **Drift is stated in COMMITS, never as an age** (§9 below — unchanged, and still the sharpest point
  in this asset).
- **`stale` and `indexing` are two states and only one is moving** (§10.1 — unchanged).
- **NEW: `already indexed · shared`.** A repository connected here whose graph exists elsewhere in
  the organisation reads `current` at once. See §1.

---

## 5. The panels

| #     | state                                     | what it draws                                                                      |
| ----- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| **0** | **THE DOORS**                             | Both access paths, in situ, with the host dimmed.                                  |
| **A** | no repo, project **has** implemented work | The connect aside — shown, and its dismissed collapse.                             |
| **B** | no repo, **nothing** implemented          | Nothing is drawn. The deliberate quiet state.                                      |
| **C** | connected and current                     | The per-repo code-context list.                                                    |
| **D** | connected, **stale**, **not moving**      | The warning register. D1 = 312 commits, D2 = 1 commit, D3 = the no-action variant. |
| **E** | planning without code context             | The anti-silence state, on `/planning`.                                            |
| **F** | **current again**                         | The moment the warning resolves.                                                   |
| **G** | **indexing**                              | A refresh genuinely in flight — the only moving state.                             |
| **H** | **never indexed**                         | Connected, but no graph has ever been built.                                       |
| **V** | the four verdicts                         | `current · stale · indexing · never indexed`, side by side.                        |

---

## 6. What this asset does NOT cover, so no one draws it twice

| out of scope                                                                                                       | owner                                              | why it is not here                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The **consent gate** — the question a planning session asks before proceeding                                      | [MOTIR-4601]                                       | It is a conversational `ask_user` inside the session, rendered by the **shipped** `ask_user` presentation. A second, visual copy drawn here would be a design of a UI the product does not have. |
| The **auto-plan condition text** under the settings row                                                            | [MOTIR-4603]                                       | A copy line under a shipped settings row, not a new surface.                                                                                                                                     |
| **Any commercial cause** — a credit balance, an allowance, a quota                                                 | [MOTIR-4541]                                       | No panel shows one. The surfaces state the **consequence** and the **remedy**; _why_ indexing paused in cost terms lives in the platform-admin panel.                                            |
| **The tenancy move itself** — org-keyed graph, per-project visibility, dropping `ProjectRepo.githubRepoId @unique` | [MOTIR-2029]'s decision + its implementation story | This asset draws the surface that model produces and names, in §1, exactly which states are unreachable until it lands.                                                                          |
| **The rail's bottom section losing `Git`**                                                                         | a shell design-amendment card                      | `design/shell/rail-bottom-section.mock.html` is that section's design of record (§2).                                                                                                            |
| **Restoring a provider's ability to be indexed**                                                                   | [MOTIR-4609], under epic [MOTIR-4608]              | This asset only makes the resulting state speak truthfully.                                                                                                                                      |
| Granting, webhooks, the fetch/ingest path                                                                          | the shipped GitHub / GitLab integrations           | The Add-or-remove button hands off to them; this asset does not re-draw granting.                                                                                                                |

## 7. The ACCESS PATH — SUPERSEDED by §2

> **⚠️ This section drew TWO doors — the connect aside in situ on `/code-health`, and the
> code-context strip in the `/planning` rail. The collapse replaced both with ONE nav row, so the
> section is superseded rather than edited: §2 is the access path now.**
>
> **What survives it, and is why the deletion is not silent:** the rule it was written to satisfy —
> _a top-level view's access path lives in the SHELL / NAV, verified against the shell design and the
> nav convention, never an affordance drawn inside a feature's own mock_. The first revision honoured
> that rule by drawing the aside inside its host; §2 honours it by composing the rail itself. The
> `/planning` strip is not re-homed by this asset at all — panel E is what `/planning` keeps, and it
> now LINKS to the Code room rather than being a second copy of it.

## 8. The connect aside — INHERITED vs NEW

Source of the pattern: `design/coding-convention/design-notes.md` (its §10.3 block and Panel 6 state
gallery), built in `app/(authed)/code-health/_components/DeepenAuditCard.tsx`.

**Inherited wholesale — do not re-decide any of it:**

| element         | inherited value                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| container       | `--el-surface-soft` fill (**never** the report's white `--el-card`), `--el-border`, `--radius-card`, `--spacing-card-padding` |
| eyebrow         | "Optional · non-blocking", `--el-text-secondary`, 11 px, uppercase, letter-spaced                                             |
| dismiss         | ghost **×** (lucide `x`), `--el-text-muted`, top-right                                                                        |
| lead glyph      | lucide `scan-search`, `--el-accent-on-surface`                                                                                |
| title           | `--font-serif`, 16 px / 600, `--el-text-strong`                                                                               |
| sub             | 14 px, `--el-text-secondary`                                                                                                  |
| best-fit line   | 12 px / 500, `--el-text-secondary` — names the trigger                                                                        |
| dismissed state | collapses to a quiet one-line `--el-link` re-open row                                                                         |

**New here, and only this:**

1. **The subject.** The §10.3 aside connects a _scanner_; this one connects a _repository_.
2. **Two losses, not one.** The sub names **both**: plans are generated _without reading the
   codebase_, **and** _work items will not move themselves_ — pull-request → status sync rides the
   same connection. The second is often the more motivating half, so it is not a footnote.
3. **One action, not a tool choice.** The §10.3 aside offers two tool rows; this one offers a single
   **Connect a repository** primary button deep-linking to Settings → Workspace → GitHub / GitLab.
   There is nothing to choose between here — the provider choice belongs to the shipped grant flow.
4. **The trigger sentence.** The best-fit line reads _"N work items in this project have been
   reported implemented."_ — the honest state MOTIR-1767 settles.

### ⚠️ 8.1 Dismissal PERSISTS per project, per browser — CORRECTED 2026-09-05

**[MOTIR-1764]'s own body asserted, as a rung-2 finding, that dismissal is EPHEMERAL —
_"`DeepenAuditCard` holds it in `useState` and offers a re-open link"_. That reading is FALSE, and
the correction is recorded here rather than quietly designed around.**

The shipped precedent persists the flag in **`localStorage`, keyed per project**:

- `app/(authed)/code-health/_components/CodeHealthClient.tsx` defines
  `dismissKey(projectId) => 'motir:code-health:deepen-dismissed:' + projectId`, reads it through
  `useSyncExternalStore`, and writes `'1'` / removes it on dismiss and re-open.
- `DeepenAuditCard.tsx` holds `useState` only for `copied` and `expanded`. The **dismissal is the
  parent's**, which is why a read of the child alone concludes the opposite.
- `design/coding-convention/design-notes.md` Panel 6 State D already says so in words: _"the
  dismissal is per-project so it doesn't nag on every visit"_. The card's claim contradicted both the
  code and the note it cited as its pattern source.

**The half that WAS right stays right:** there is **no per-user dismissal store in the schema** —
`prisma/schema.prisma` carries `NotificationPreference` and `UserAppearancePreference`, neither of
which is a hint store. The conclusion drawn from that fact was the wrong one: the precedent does not
persist server-side, it persists **client-side**.

**So the drawn contract is:**

- Dismissing hides the aside for **that project in that browser, durably** — it survives a reload.
- A quiet one-line link re-opens it, and re-opening **clears** the stored flag.
- **No persisted "never show again" is drawn**, and no code card may invent a preference table for
  it. The behaviour is `localStorage` + `useSyncExternalStore`, a second use of a shipped pattern.
- `localStorage` is per browser. The same project on another device shows the aside again. That is
  the precedent's behaviour and the copy never over-promises otherwise.

This supersedes [MOTIR-1754]'s acceptance criterion _"Dismissal is session-scoped … nothing is
persisted"_, which was written from the same misreading. Both cards are amended on the record.

---

## 9. Drift is stated in COMMITS — and why an age is a _wrong_ verdict, not a weaker one

**State D leads with the drift: "312 commits behind".** No panel expresses the verdict as an age.

The reason is not tone. **Age and drift disagree about the answer:**

- A graph built three weeks ago on a repository nobody has pushed to is **current**. Motir is
  planning against exactly the code that is there.
- A graph built two hours ago on a repository that took 300 commits since is **badly stale**. Motir
  is planning against code that no longer exists.

An age-led verdict gets both of those backwards. So _"indexed 3 days ago"_ may appear as **secondary
detail beside the drift** — it never leads, and the verdict is never derived from it.

**The drift count is the code card's input, not the design's invention.** The surface needs a
`commitsBehind: number | null` beside the verdict:

- a **number** → _"N commits behind"_ in the headline, and _"N behind"_ on the chip;
- **`null`** → _"Behind by an unknown number of commits"_ in the headline, and **"Behind"** on the
  chip (panel D3). A chip reading **"Stale"** is the age framing in miniature and is not drawn.

**⚠️ This is an obligation this design places on [MOTIR-1767].** That card's verdict function, as
authored, distinguishes `stale` from `current` by comparing `indexedCommitSha` with the stored
`GithubRepo.lastPushSha` — a sha _inequality_, which yields a boolean and not a count. A count needs
a source, and the constraint it inherits from [MOTIR-1766] is that **no provider round-trip may
happen on a page render**. Which mechanism supplies it is 1767's decision; that it must be supplied,
and that `null` is a legal answer this surface renders, is settled here. 1767 is amended on the
record accordingly.

---

## 10. Registers — where the inherited §10.3 grammar STOPS

Three rungs, and the split is the whole reason state D is not another aside:

| rung           | used by                                               | fill / edge                                                                                                                       | reading                                                                    |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **invitation** | panel A (connect aside), panel B (nothing)            | `--el-surface-soft`, `--el-border`                                                                                                | _optional; the thing you are reading is already complete_                  |
| **warning**    | panel D (stale, not moving), panel E (planning blind) | `--el-warning-surface` fill + a `--el-warning` **edge**, ink `--el-warning-text`, glyph lucide `triangle-alert` in `--el-warning` | _a fact that degrades the product's output; you should not skim past this_ |
| **error**      | —                                                     | not used                                                                                                                          | nothing in this story is an error                                          |

**Where the inherited register stops:** the §10.3 anatomy is an **invitation** — it exists to deepen
an already-complete report and must never gate it. State D is **not that**. It reports that plans are
being produced against code that is not the code, which is a defect in the output rather than an
optional improvement to it. Stretching one aside grammar over both would make the warning read as
optional, so the asset does not: D takes the token layer's own warning family, one rung up, and keeps
the aside grammar for A alone.

**Still not alarming.** No red, no destructive family, no modal, no blocking. The weight comes from
the peach warning surface plus a coloured **edge** — the one thing panel A does not have — and from
the copy naming a consequence in words.

**State D's colour is not invented.** It is the existing warning family in
`packages/design-system/theme.css`: `--el-warning-surface` (`--color-tint-peach`), `--el-warning`
(`--color-warning`) and `--el-warning-text` (`--color-charcoal`). Both flip with the theme, verified
in `code-context.dark.png`.

### 10.1 ⚠️ `stale` and `indexing` are TWO states, and only ONE of them is moving

The earlier direction — _stale "must read as catching up, not broken"_ — is **superseded, and the
"catching up" half is actively wrong.** A refresh can be paused, failing, or impossible for the
provider entirely. **A stale repository may sit stale for ever.**

**The copy rule, in words:**

- **Panel D (`stale`) promises nothing.** No _"catching up"_, no _"shortly"_, no _"check back"_, no
  _"this will resolve"_. It states the drift, states the consequence, says **"This index is not
  updating."**, and offers the action that exists — or, in D3, says plainly that none can be started.
- **Panel G (`indexing`) is the only panel allowed wait-and-return language.** It is the only state in
  which something is actually happening.
- **A run that cannot prove a refresh is in flight renders D, never G.** The default is the one that
  promises nothing.

They are separated at a glance by three things at once: **surface** (peach warning vs sky info),
**glyph** (static `triangle-alert` vs spinning `loader-circle`) and **copy**. Never by colour alone.

### 6.2 The action on state D

D1/D2 offer a secondary **"Rebuild now"** (lucide `refresh-cw`), composing the shipped
**"Re-audit now"** grammar from `DeepenAuditCard.tsx`. It **reuses the refresh enqueue [MOTIR-4604]
already fires at session start** — it is not a new mechanism, and [MOTIR-1768] wires it.

**D3 has no button at all.** Where nothing can be enqueued the honest rendering offers no action and
says so: _"No rebuild is offered, because none can be started."_ An action that cannot succeed is
worse than none.

---

## 11. Per-element token + primitive map, and who specifies each behaviour

The code card composes these; it does not choose new ones.

| element                                    | primitive                                                  | colour tokens                                                        | shape tokens                              | behaviour specified by                                                           |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| connect aside container                    | `components/ui/Card.tsx` grammar, **soft** variant         | `--el-surface-soft`, `--el-border`                                   | `--radius-card`, `--spacing-card-padding` | §10.3, `design/coding-convention/design-notes.md`                                |
| aside eyebrow                              | `components/ui/SectionLabel.tsx`                           | `--el-text-secondary`                                                | —                                         | §10.3                                                                            |
| aside lead glyph                           | lucide `scan-search`                                       | `--el-accent-on-surface`                                             | —                                         | §10.3                                                                            |
| aside title                                | serif heading                                              | `--el-text-strong`                                                   | `--font-serif`                            | §10.3                                                                            |
| dismiss ×                                  | ghost icon button                                          | `--el-text-muted`                                                    | `--radius-control`                        | §8.1 (this file)                                                                 |
| re-open link                               | text link                                                  | `--el-link`                                                          | —                                         | §8.1 (this file)                                                                 |
| **Connect a repository**                   | `components/ui/Button.tsx` `variant="primary" size="sm"`   | `--el-accent` / `--el-accent-text`                                   | `--radius-btn`, `--height-btn-sm`         | the shipped grant flow                                                           |
| **Rebuild now**                            | `components/ui/Button.tsx` `variant="secondary" size="sm"` | `--el-text`, `--el-button-border`                                    | `--radius-btn`, `--height-btn-sm`         | [MOTIR-4604] (the enqueue), [MOTIR-1768] (the wiring)                            |
| repo row                                   | list row on a card                                         | `--el-card`, `--el-border`, `--el-text-strong`                       | `--radius-card`                           | [MOTIR-1767] (the DTO)                                                           |
| commit sha                                 | mono inline                                                | `--el-text-secondary`                                                | `--font-mono`                             | [MOTIR-1765] (`commitSha`)                                                       |
| verdict `current`                          | `components/ui/Pill.tsx`                                   | `--el-success-surface` + `--el-text-strong`, glyph `circle-check`    | `--radius-badge`                          | [MOTIR-1767]                                                                     |
| verdict `stale`                            | `components/ui/Pill.tsx`                                   | `--el-warning-surface` + `--el-warning-text`, glyph `triangle-alert` | `--radius-badge`                          | [MOTIR-1767]                                                                     |
| verdict `indexing`                         | `components/ui/Pill.tsx`                                   | `--el-notice-info-bg` + `--el-text-strong`, glyph `loader-circle`    | `--radius-badge`                          | [MOTIR-1767]                                                                     |
| verdict `never indexed`                    | `components/ui/Pill.tsx`                                   | `--el-muted` + `--el-text-secondary`, glyph `circle-dashed`          | `--radius-badge`                          | [MOTIR-1765] (`indexed: false` + null fields)                                    |
| stale warning block                        | callout                                                    | `--el-warning-surface`, `--el-warning` edge, `--el-warning-text`     | `--radius-card`                           | §5, §6 (this file)                                                               |
| indexing block                             | callout                                                    | `--el-notice-info-bg`, `--el-info` glyph                             | `--radius-card`                           | [MOTIR-1767] (`indexing`)                                                        |
| settled line (F)                           | inline banner                                              | `--el-success-surface`, `--el-success` glyph                         | `--radius-card`                           | §8 (this file)                                                                   |
| planning-blind block (E)                   | callout                                                    | `--el-warning-surface`, `--el-warning` edge                          | `--radius-card`                           | `lib/ai/codeContext.ts` (`resolveCodeContext` returning `undefined`)             |
| the head sha staleness is compared against | —                                                          | —                                                                    | —                                         | [MOTIR-1766] (`GithubRepo` head columns, `lib/services/githubWebhookService.ts`) |

**Two shape rules the code card must not break.** State is never signalled with a hardcoded **dashed
or dotted border** — it clashes with `data-style`; use a token-driven tint plus a label and a glyph.
And no raw utility (`rounded-md`, `p-2`, `h-9`) or Tier-0 `--color-*` — element tokens and the
element-semantic shape tokens only.

---

## 12. State F — the warning must be seen to clear

Without F the honest warning this story adds never visibly resolves, which teaches people to ignore
it. A refresh lands while the surface is open:

- the warning block is **replaced in place** by a settled line — _"Code graph rebuilt — now current at
  `9c14e02`."_, `--el-success-surface`, lucide `check` in `--el-success`;
- the repo row underneath returns to its panel C reading;
- **quiet, once, and self-erasing** — it is gone on the next read.

**Not a toast queue** (it belongs in the slot the warning occupied, so nothing moves and nothing has
to be dismissed) and **not a persistent badge** (a badge that stays re-creates the nagging the §10.3
register exists to avoid).

---

## 13. State B — what a project with nothing shipped yet sees

**Nothing.** Both hosts render exactly what they render today.

The trigger for the aside is **implemented work**, not **absent repository**: a project that has not
shipped anything does not need to be asked for a repository that does not exist yet. Asking at
onboarding time would be wrong for the same reason. [MOTIR-1767] settles the predicate — any work
item with a non-null `implementationSource`, which is exactly _"someone reported implementing work"_
— and it is deliberately not _"any done item"_ (a migrated project is full of those) and not _"any
pull-request link"_ (that presumes the very connection the aside is asking for).

The dimmed outline in panel B marks the space the aside would occupy. It exists so a reader can see
the absence is a **decision**, and is not itself a drawn element.

---

## 14. Accessibility and theme

- Every state is carried by **tint family + glyph + copy**, never by colour alone (WCAG 1.4.1).
- Ink is `--el-text-strong` / `--el-warning-text` on tinted surfaces; the warning family's
  charcoal-on-peach pairing is the one `theme.css` already holds to its AA bar.
- Both themes are exported. `code-context.dark.png` is the same board with `data-theme="dark"` on the
  root; every ink flips because `color` is declared on the scoped containers rather than inherited
  from `body` alone.

---

## 15. How this asset was produced

The mock is **generated, not hand-typed**, so it cannot drift from the shipped layer:

1. **Tokens.** A throwaway script strips comments from `packages/design-system/theme.css`, then
   brace-counts three blocks out of the comment-stripped source: the Tier-0 `@theme` block (re-emitted
   as `:root`), the Tier-3 `:root, [data-appearance-scope]` block, and the `[data-theme='dark']` flip.
   Nested at-rule groups are dropped and each block's declarations are emitted **unlayered** into a
   leading `<style>`, with the Tier-3 block emitted a second time under a bare `[data-theme]`
   selector so a theme flip recomputes against its own Tier-0. 109 Tier-0 + 207 Tier-3 + 28 dark
   declarations. **No hex is retyped.**
2. **Icons.** Every `<symbol>` is the `__iconNode` array of the installed `lucide-react` icon file,
   following alias re-exports while keeping the requested id. The GitHub mark is taken verbatim from
   `components/icons/GithubMark.tsx`, because lucide ships no brand icons.
3. **Layout CSS** is hand-authored in the same semantic-class style as
   `design/coding-convention/design-notes.md`'s mock, and the button rules mirror
   `packages/design-system/src/components/ui/Button.tsx` variant for variant.
4. **Export.** `node scripts/render-design-mock.mjs design/code-context/code-context.mock.html --width 1200`
   (the width is passed explicitly — the script's viewport search keeps the first candidate matching
   on width and can lock in a half-width 2× render). The dark export is the same page with
   `data-theme="dark"` set on the root before a full-page screenshot.
5. **Verification** was by measurement, not by looking: a headless probe read back
   `--el-page-bg`, `--el-warning-surface`, `--el-warning`, `--el-surface-soft`,
   `--el-success-surface`, `--el-notice-info-bg`, `--radius-card`, `--spacing-card-padding` and
   `--shadow-card` as resolved values, confirmed every `<use href>` resolves to a defined symbol, and
   re-read the same properties with `data-theme="dark"` to confirm no ink collapses onto its own
   surface.

The generator scripts were deleted before the commit, so this section reproduces them rather than
citing a path that would not exist on `main`.

---

## 16. Amendments this design makes to sibling cards

Recorded here because a design that answers a card's open questions routinely changes that card, and
the change belongs on the record rather than in a build.

**From the first revision, unchanged:**

1. **[MOTIR-1764] (this card) and [MOTIR-1754] — dismissal persistence.** _"Session-scoped; nothing
   is persisted"_ is falsified by `CodeHealthClient.tsx`. See §8.1.
2. **[MOTIR-1767] — the drift count.** The verdict function needs to yield `commitsBehind`, with
   `null` a legal answer this surface renders. See §9.
3. **[MOTIR-1768] — the rebuild action.** Wiring **Rebuild now** to [MOTIR-4604]'s enqueue, and
   suppressing it where nothing can be started. See §10.2.

**Added by the 2026-09-05 rework, and these are larger:**

4. **[MOTIR-1768] is re-scoped and re-sized.** It was _"the code-context UI — connect affordance +
   freshness indicator on `/planning` and `/code-health`"_. It is now **one `Code` page with three
   sections, a new primary nav row, and the `Add or remove repositories` action** — and it must read
   the PROJECT's connected set rather than the workspace's. That is a bigger card than the one that
   was sized, and a **GIVES is a claim about SIZE**: it is re-estimated on the record in the same
   pass, and split if the re-estimate crosses the gate.
5. **[MOTIR-1767] reads the PROJECT's set.** Its service currently resolves repositories from the
   workspace installation, which is the leak §1 names. Corrected on the record.
6. **[MOTIR-2029]'s decision is MADE, not proposed.** That record asked whether a repository should
   be indexed into every project of its workspace and left four options. Yue has answered: neither —
   **one graph per repository per organisation, with per-project visibility**, which was that
   record's option 4. The ADR is updated to record the decision and its consequences.
7. **A shell design amendment is owed** for `design/shell/rail-bottom-section.mock.html`, which is
   the design of record for the row this collapse removes. Named in §2; owned by its own card.
8. **The tenancy move is its own story** — org-keyed `CodeRepo`, per-project visibility, and dropping
   `ProjectRepo.githubRepoId @unique`, which currently makes _"connect a repo to a second project"_
   inexpressible. Named in §1 with the four-row audit; not this card's to build.

[MOTIR-1754]: https://app.motir.co/items/MOTIR-1754
[MOTIR-1764]: https://app.motir.co/items/MOTIR-1764
[MOTIR-1765]: https://app.motir.co/items/MOTIR-1765
[MOTIR-1766]: https://app.motir.co/items/MOTIR-1766
[MOTIR-1767]: https://app.motir.co/items/MOTIR-1767
[MOTIR-1768]: https://app.motir.co/items/MOTIR-1768
[MOTIR-4541]: https://app.motir.co/items/MOTIR-4541
[MOTIR-4590]: https://app.motir.co/items/MOTIR-4590
[MOTIR-4601]: https://app.motir.co/items/MOTIR-4601
[MOTIR-4603]: https://app.motir.co/items/MOTIR-4603
[MOTIR-4604]: https://app.motir.co/items/MOTIR-4604
[MOTIR-4608]: https://app.motir.co/items/MOTIR-4608
[MOTIR-4609]: https://app.motir.co/items/MOTIR-4609
