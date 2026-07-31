# `design/repository-set/` — design notes

**The area index. It now covers TWO surfaces**, which are the two halves of one promise: where a
project's code comes to live, and what the standing _"it's yours — move it whenever you want"_
actually opens onto.

| Surface                                                          | Asset                                                                                                   | Card                                                         | Sections |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| **The establish step** at plan approval                          | [`repository-set.mock.html`](./repository-set.mock.html) + [`repository-set.png`](./repository-set.png) | MOTIR-1778 (design) → MOTIR-1782 / MOTIR-1900 (code)         | §0–§13   |
| **The take-it-over flow** — move a repository to your own GitHub | [`takeover.mock.html`](./takeover.mock.html) + [`takeover.png`](./takeover.png)                         | MOTIR-1938 (design) → MOTIR-1939 (surface), MOTIR-711 (saga) | **§14**  |

**Story MOTIR-1775 · subtask MOTIR-1778 (design gate, Principle #13).** §0–§13 are the design
reference for the step at plan approval that gives an approved plan somewhere for its code to live —
and then gives the user a way to reach it. It is the layout source of truth for **MOTIR-1782** (the
approval-step UI) and **MOTIR-1900** (collaborator access), and the surface **MOTIR-1785**'s E2E +
acceptance video walk.

- **Asset of record:** [`repository-set.mock.html`](./repository-set.mock.html) — the source of
  truth, built from the real design system. Its `.png` export
  ([`repository-set.png`](./repository-set.png)) is the board/PR-visible face.
- **Definition of done (three files, PER SURFACE):** `design-notes.md` +
  `<surface>.mock.html` + `<surface>.png`. All five files are committed.
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries — those are
  MOTIR-1782's / MOTIR-1900's / MOTIR-1939's.

---

## 0. The answer in one line

**Motir hosts your code — for everyone. Then Motir gets you access to it.** One sentence and one
button to say yes; one prompt afterwards to connect GitHub so you can actually clone what Motir
made you; and a small "I already have code" for the people who have their own.

Everything technical — repository names, roles, the derivation's "why", the full per-row state
machine — lives **behind that small link**, and appears only once a user has said they already have
code, which is how they self-identify as someone the word "repository" means something to.

---

## 0.1 · Revision history — this asset has been re-scoped twice, and both are recorded

| Version                | What it drew                                                                                           | Why it changed                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **v1**                 | One question: "where should your code live?", one choice                                               | The repo count is decided by the architecture, not by the user — a single choice cannot express a set                                |
| **v2**                 | The derived set, as editable rows, as the default surface                                              | Yue at design review: **too technical.** A founder cannot judge whether three repositories is right — `notes.html` #151, second time |
| **v3**                 | "Motir will host your code" as the default; the rows behind "I already have code"                      | Right shape, wrong era — see below                                                                                                   |
| **v4 (this revision)** | Same default, plus the **access step**; the account-creation branch deleted; the main line re-inverted | The ADR's ownership amendment (MOTIR-1893) + the access gap it opened (MOTIR-1900) + drawing a post-Epic-9 audience as today's user  |

### Why v2 was wrong (kept, because it is the load-bearing product rule)

v2 drew the underlying model on screen — a row per repository with a role chip, an editable
`<owner>/<name>`, a seed source, and per-row GitHub failure reasons — and asked the user to curate
it. **That is a developer tool.** Motir is chat-first and explicitly not developers-only; the person
approving a plan is usually a founder who does not know what a repository is, let alone why their
project needs two.

This is the **`notes.html` #151 class, second occurrence**. #151 was the coding convention planned
as `proposed → edit → APPROVE → standard`, and the rule it produced is: _do not plan a human
approval gate — or a bespoke edit surface — for an AI-derived artifact a non-technical user cannot
meaningfully evaluate; derive it, use it automatically, and expose it read-only._ The repo SET is
exactly such an artifact: it is **derived** (ADR §0.1, from the plan's own contents), and a founder
cannot judge whether three repositories is right. **That rule still governs every default-path
screen here.**

### What v4 changed, and why (Yue, 2026-07-30, second review)

**1 · The account-creation branch is DELETED.** The per-row `Segmented` offered **Create for me**
(in the user's own account) vs **Use one of mine**. The ADR's
[2026-07-30 amendment](../../docs/decisions/project-repository-set.md#amendment-2026-07-30-yue--motir-1893)
removed the first: **Motir never creates a repository in the user's own account**, for anyone, so
"create" no longer names a second destination — it means the same Motir-hosted thing the default
path does. A two-way control with one option left is a lie about the choice on offer, so the row now
has a **default** (Motir creates it) and a **single quiet secondary**, **Use one of mine**, which is
an action, not an alternative. `useOneOfMine` survives unchanged because connect-existing is the only
path that ever touches the user's account — it is how a monorepo collapses the set to one row and how
a pre-provisioned repository in a governed org is used.

`ownTitle` / `ownLead` are re-worded for the same reason. They read as an alternative **home** for
new code ("Use your own GitHub instead"); they are now only an alternative **source**
("Use the code you already have").

**2 · The ACCESS step is drawn — new UI this asset had never depicted.** Repositories are created
under Motir's org and are **private**, so the user cannot clone their own code until Motir invites
them as an admin collaborator (**MOTIR-1900**), which needs a GitHub login Motir only has once they
connect. Drawn: the **connect prompt** (panel 3), the **per-row invitation states** (panel 4), and
the **ownership promise on the main line** rather than in a footnote — MOTIR-1785 asserts a reviewer
can SEE it in the acceptance video, so it is a line of its own with the door to MOTIR-711's transfer
beside it.

**3 · The main line is RE-INVERTED.** v3's notes concluded _"Motir-hosted is the default, so the
non-technical journey has no GitHub in it at all"_ and drew that GitHub-free path as the main line.
That end state is right, but **it arrives with the hosted agent**. Before Epic 9 there is no
non-technical workflow at all — the hosted agent is what would build the site a non-technical founder
validates — so until it ships, every user is technical, connects GitHub, and runs their own agent
locally. **The flow that exists today is the main line** (panels 0–4); the GitHub-free path is drawn
as the state it becomes once hosted execution lands (panel 8). Drawing an audience the product cannot
yet serve as the primary case was the v3 mistake, and panel 8 exists so the correction is a recorded
consequence rather than a redesign waiting to happen.

**No GitHub-permission or grant state is drawn anywhere**, deliberately. There is no "your grant is
not upgraded", no re-consent prompt, no org-owner warning: nothing in this flow asks the user for a
permission. The ADR's credential table is what makes that true — the user-facing App is **unchanged**
by this decision (`Administration` is _not_ added to it), the provisioning credential is Motir's own
on Motir's org and never appears in a user flow, and the only new consent the product ever asks for
is Epic 9's opt-in writer App, which is not this surface's business.

### Two of MOTIR-1778's own acceptance criteria are knowingly superseded — flagged, not quietly dropped

Both were written for v3 and are contradicted by the re-scope that produced v4, so they are answered
against the newer instruction rather than the older list. Neither is an omission:

- **"The Motir-hosted main line is drawn … and no GitHub prompt on it."** v4's re-scope says the
  opposite in as many words: _"the pre-Epic-9 main line **always continues into the connect + access
  step**."_ The main line therefore ends in **Connect GitHub** (panel 2 `created` → panel 3). The
  spirit of the original AC survives exactly where it was aimed — **nothing before or during setup
  mentions GitHub**, and no GitHub state gates approval. Panel 8 draws the state in which the
  original wording becomes true again.
- **"The default path is ONE sentence + one action + one small 'I already have code'."** The same
  re-scope requires the ownership promise **on the main line rather than as a footnote**, so panel 1
  carries a fourth element. It is a **statement, not a control** — one line of standing guarantee
  plus one link out — so the count of things the user must decide is unchanged, which is what the
  AC was protecting.

### What did NOT change

The **model** is untouched. The set still holds as many rows as the architecture decides, still
carries roles and per-row state, `targetRepo` still resolves through it (ADR §5), and the row
lifecycle is still §4.1's. Panels 1, 1b, 2, 6 and 7 are v3's, edited — not redrawn.

---

## 1. Where every decision came from (no flow is invented here)

| Behaviour                                                                                       | Source                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The set's cardinality is DERIVED from the plan; the default is one `web` repo on thin signals   | ADR `docs/decisions/project-repository-set.md` §0.1 (MOTIR-1776, accepted)         |
| Presentation of a one-row set is this card's to decide, not the model's                         | ADR §6                                                                             |
| The role enum (`web` · `api` · `mobile` · `shared` · `infra` · `other`)                         | ADR §1.1                                                                           |
| ORDER is meaningful; the first row is the project's **primary** repository                      | ADR §1.3                                                                           |
| Names: `<project-slug>` at one row, `<project-slug>-<role>` at two or more; always editable     | ADR §1.4                                                                           |
| Collisions offer a suffixed name, pre-filled and editable, before the row is created            | ADR §1.5                                                                           |
| Seed source per role — the starter for `web`, an INITIALISED repo for everything else           | ADR §2                                                                             |
| **Every CREATED repo is Motir-owned and claimable — no account branch, for anyone**             | ADR §3 **amendment 2026-07-30** (MOTIR-1893)                                       |
| Connect-existing is untouched and is the only path that reaches the user's own account          | ADR §3 amendment                                                                   |
| The ownership promise the Motir-org default obliges the copy to make                            | ADR §3 amendment, closing paragraph                                                |
| A repo Motir owns is still the user's to REACH — collaborator invite, per created repo          | ADR §3 amendment · **MOTIR-1900**                                                  |
| The connect prompt belongs AFTER approval, framed as "get access to your code", never as a gate | **MOTIR-1900** ("not a gate before approval … but a prompt after it")              |
| Invitation states: invited / accepted / not-invited-no-identity, with re-send                   | **MOTIR-1900** acceptance criteria                                                 |
| An invite failure must NOT fail repo creation                                                   | **MOTIR-1900** ("a side effect after commit, degrading gracefully")                |
| The per-row state machine, row independence, no rollback, resumability, partial completion      | ADR §4.1–§4.4                                                                      |
| **Per-row async with polling — a `201` is not a ready repository**                              | **MOTIR-1777** spike, `docs/github-repo-creation-mechanics.md` §4.2 + finding 5    |
| 2–5 repos is nowhere near any rate limit; serialise anyway                                      | MOTIR-1777 spike §4.1                                                              |
| The single-repo project is the degenerate case of one model, never a second code path           | ADR §6                                                                             |
| The per-row **reason** a proposed row surfaces                                                  | MOTIR-1881 — "a row with no nameable reason should not exist"                      |
| The host surface, the split, the rail, the approve CTA, the decided outcome                     | `app/(authed)/plans/[id]/page.tsx` · `PlanningWorkspace` · `PlanReviewRail`        |
| The GitHub connect/install hand-off, and its two separable grants                               | `app/(authed)/settings/workspace/github/page.tsx` (7.10) — pointed at, not redrawn |
| The transfer this design promises but does not draw                                             | MOTIR-711 (9.3.7)                                                                  |
| Don't gate an AI-derived artifact a non-technical user can't judge                              | `notes.html` #151                                                                  |
| Design against what is SHIPPED — render it, don't read-and-redraw it                            | `notes.html` #73                                                                   |

### The spike has since LANDED — and it answers the question this design asked

v3 was drawn while MOTIR-1777 was still in progress. It is now `done` and
`docs/github-repo-creation-mechanics.md` is on `main`. Three of its findings bear on this asset, and
all three confirm the shape already drawn rather than change it:

- **Latency is still the one UNVERIFIED number** (§4.2 — the available credential had no
  `delete_repo` scope, so it is recorded as unverified rather than estimated). The design is safe
  either way, deliberately: the **default path** shows ONE status line for the whole set
  (_"Setting up your code…"_), which is right at 400 ms or 20 s and never exposes a per-repository
  count the user did not ask for; the **technical path** shows **per-row** progress, required if
  creation is slow and harmless if it is fast.
- **A `201` does not mean the repository is ready** (§4.2). Template seeding is not synchronous, so
  a row is `created` only after a readiness read succeeds. Panel 7's `creating` row says so
  (_"Seeding it from the starter"_) and the notes say it here, because it is the one spike answer
  that changes a UI card: **MOTIR-1782 must model each row as its own async job**
  (`pending → creating → seeding → ready | failed`), never one synchronous "create the set" request
  that returns when the last call returns.
- **Rate limits do not constrain this story's N** (§4.1: 80 content-generating requests/minute), so
  nothing here needs a batching or throttling affordance.

---

## 2. Drawn against SHIPPED reality — what was RENDERED first

The step lands inside a surface that already exists, so it was **rendered before anything was
drawn** (`notes.html` #73 — reading the `.tsx` is not seeing what renders). `pnpm build` +
`next start` on `origin/main` @ `c76e2b7a`, signed in against a tenant seeded through the shipped
services (`tests/e2e/_helpers/plans-review-seed.ts`), full-page screenshots at 1440×,
`deviceScaleFactor: 2`:

- **`/plans/<planned-plan>`** — the pre-approve state: the bordered `--el-canvas` box, the
  proposed-plan canvas, and the rail's **"Approve — add 1 item to your backlog"** / **Decline**
  gate with the hint _"Approve materializes the proposals into your backlog."_
- **`/plans/<approved-plan>`** — the state the step lands back into: the rail's pill flipped to
  **Approved**, the history gaining **"Approved · Plans Owner"**, and `DecidedOutcome` showing a
  `--el-success` Sparkles + **"Added 1 item to your backlog"** + **"View in backlog"**.
- **`/settings/workspace/github`** (nav label **"Git"**) — the two-grant connect flow. Panel 5b
  mirrors it as the hand-off target and redraws none of it.

**Re-verified for this revision:** `git diff c76e2b7a origin/main` over `app/(authed)/plans`,
`components/plans`, `app/globals.css`, `packages/design-system/theme.css` and
`app/(authed)/settings/workspace/github` is **empty** — none of the composed shipped surfaces has
moved since those renders, so they still describe reality and were not re-shot.

The route header, the box, the `grid-cols-[1fr_22rem]` split and every element of the rail are
**mirrored markup**, not stylized stand-ins. **The step is the only new surface.**

---

## 3. Placement and the access path

**The step takes the CANVAS pane of the plan-detail box; the review rail stays.**

1. The card requires the step "in place, inside the plan-approval flow — **not a floating panel**."
   A `Modal` is exactly what that rules out; the canvas pane is the surface's own content region.
2. **Keeping the rail is what makes the step honest.** It already reads **Approved** and **"Added
   24 items to your backlog"**, so the user can see their plan is safe while answering. That is the
   visual form of ADR §4.3.
3. Once the plan has materialized, the canvas of proposals has served its purpose; replacing it is
   the truthful use of the space.

```
/plans/[id] ─[ Approve — add 24 items ]→ the step ─[ Continue ]→ get access ─[ Connect GitHub ]→ live
 (planned)     materializes + derives    "Motir will   Motir sets    "Get access     invite sent    (rail:
               the repo set              host your      it up         to your code"   + accepted    "Your code
                                         code"                                                      is ready")
```

**The rail's outcome gains exactly one plain line — "Your code is ready" — and never a repository
count or name.** If the user leaves access unfinished, that line reads **"Finish setting up
access"** instead.

**Re-entry (the no-dead-end guarantee).** The set is durable (ADR §4.4), so the step is
re-enterable. The door back exists for the three cases that need it: setup didn't finish (panel 2,
`failed`), the invitation is pending or was never sent (panel 4), and the user later decides to use
code they already have. The permanent home for all three is the code-context surface
(**MOTIR-1764** / Story MOTIR-1754) — **not drawn here**. The step earns **no new left-nav entry**:
it is an action inside an existing surface, not a first-class project VIEW (`notes.html` #99).

### Why this is a step and not a gate

- **Can the target user judge it?** The default asks one thing they can answer — _is it fine for
  Motir to host this?_ — and nothing they cannot.
- **Does answering it block their flow?** No, and neither does the access step. Approve materializes
  the plan **first**; the items are in the backlog before either is answered. **Continue** is a
  one-click accept of a default that is already correct, and **Later** on the access prompt leaves
  with the plan intact and the door open.

---

## 4. The default path (panels 1, 1b, 2) — the whole thing for most users

**Panel 1.** Overline, one serif statement, one sentence of body, **the ownership promise**, one
primary, one quiet secondary. Absent by design: repository name, role, account, count, rows, table
chrome, seed source, reorder, per-row menu, "add a repository". The only branch is **I already have
code**, sized like the exception it is.

**The ownership promise is on the main line, not in a footnote.** ADR §3's amendment makes Motir the
default holder of every new project's code, which the ADR itself calls a trust surface "the product
copy must state plainly rather than let the user discover". So it is its own element — a `lock` icon,
_"**It's yours.** Motir keeps it safe and private — move it to your own GitHub whenever you want."_,
and the **door**: a `How moving it works` link into MOTIR-711's transfer. **The promise and its door
are drawn; the transfer flow is not** (9.3.7 owns it). It is styled as a quiet standing guarantee
(`--el-surface-soft`), not a severity tint, because it is a fact about the arrangement rather than a
warning about it.

**Panel 1b — both cardinalities.** The card's central problem, answered by **removing the
question**: the same screen ships whether the plan needs one repository or three. The two renders in
the mock are **identical pixels**; only what Motir does behind them differs. Nothing about
cardinality reaches the user, so a one-row set cannot look like a list of one and a three-row set
cannot look advanced. Where the difference DOES surface is the technical path (panel 6), which is
also the only place the count is spoken (**Set up 2 repositories**).

**Panel 2 — three states, in plain language.** The ADR's six per-row states are the _model_; this
path renders only what the user can act on:

| ADR state                            | Default path                                                                                             | Forward path                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `creating`                           | **"Setting up your code…"** — one `role="status"` line for the whole set                                 | (resolves)                                        |
| `created`                            | **"Your code is ready"** + the ownership promise                                                         | **Connect GitHub** (panel 3) · _Go to my backlog_ |
| `failed`                             | **"Motir couldn't finish setting up your code"** + what it costs (nothing yet)                           | **Try again** · _I already have code_             |
| `proposed` · `connected` · `skipped` | **cannot occur** — nothing is proposed for approval, nothing is adopted, and there is nothing to decline | —                                                 |

**No per-repository progress, no repository name in the error, no GitHub status code** on this path.
The failure copy names the consequence in the user's terms — _"Your plan is safe in your backlog.
Nothing is lost — Motir will tell you if a task needs code that isn't ready yet"_ — which is the
honest hand-off to the code-blind signal MOTIR-1754 renders.

**`created` is the one state that continues**, which is the whole of change 3: the code now exists,
and the next thing the user needs is a way to reach it.

---

## 5. The access step (panels 3–4) — new, and on the main line

**Panel 3 — the connect prompt.** _"Get access to your code."_ Three properties are load-bearing and
each is drawn, not just asserted:

1. **It comes AFTER approval, and after the code exists.** Nothing about GitHub can cost the user
   their plan, because the plan is already in the backlog and the repositories are already made.
2. **It is not a gate.** **Later** is a real answer: it leaves with everything intact, and the rail's
   outcome says what is unfinished (**"Finish setting up access"**). The permanent door is
   MOTIR-1764's code-context surface.
3. **It asks for no permission.** Motir needs exactly one thing — the user's GitHub username — which
   is **grant 1 (identity)** of the shipped connect pane (`GithubIdentity.githubLogin`, which is
   where MOTIR-1900 reads it from). The **repository-access install is grant 2** and is needed only
   for connect-existing (panel 5), because that is the only path that reads a repository the user
   owns. No re-consent, upgrade, or org-owner state is drawn, because none is asked for.

Copy stays plain-language on this panel — _"Your code is private — only you and Motir can see it"_ —
because a user who has not connected has not yet self-identified as technical. **Repository names
appear only after they connect**, which is the same #151 discipline the "I already have code" door
applies, one step later.

### Which account gets access — connected, never typed, and therefore SHOWN

There is deliberately **no "type your GitHub username" field**. The account Motir invites is the one
the user **connects** — `GithubIdentity.githubLogin`, which is where MOTIR-1900 reads it. A typed
handle proves nothing (anyone can type anyone's), a typo would invite a **stranger** to a private
repository, and Motir needs the verified identity anyway for dispatch and attribution.

But that mechanism is only honest if the user can **see** which account got access, which v4's first
pass did not draw — it asserted _"Motir invited @yuezhu"_ in a sentence and offered no way to correct
it. **3b now mirrors the shipped `IdentityHeader`** (`app/(authed)/settings/workspace/_components/gitSettingsPrimitives.tsx`):
the avatar, **@login**, the `Pill severity="success"` **Verified** badge, and a trailing **Use a
different account** which re-runs the connect rather than opening a field. That is `notes.html` #73
applied — when the element already exists as shipped UI, the design SHOWS the real component rather
than redrawing a stand-in — and it is the same component the Git settings pane already puts a
`Disconnect` button on.

### ⚠️ Only the approving user — teammate access is a plan gap, filed as MOTIR-1910

MOTIR-1900 invites **the project owner**, and nothing planned anywhere invites anyone else. Every
repository is private and Motir-owned, so on a six-person workspace the other five cannot clone the
project's code by any path. Verified at rung 2 — `grep -rn "collaborator" lib app` returns nothing,
and a tenant search names no card that invites a non-owner.

It is **not drawn on this surface**, on purpose: a teammate is not standing at plan approval, so
their door belongs on a surface they actually reach (the code-context surface, MOTIR-1764, or project
settings). It also cannot reuse the owner's mechanism as-is — Motir cannot OAuth on a teammate's
behalf — so it resolves against workspace membership rather than a typed handle, and it multiplies
the CI-spend exposure MOTIR-1901 / MOTIR-1907 meter. **MOTIR-1910** carries all of that, and likely
needs a decision card ahead of it.

**Panel 4 — the invitation, per repository.** Access is granted per repository, so the invitation is
a **sub-state OF a created row**, never a row state of its own: the row keeps its
`created` / `failed` / `skipped` tint from §4.1 and the invitation is an extra line inside it. Two
things fall out of that for free:

- A `skipped` row has nothing to be invited to, so a partial set (panel 7) needs no special case.
- An invitation failure **never** fails the row — creation already succeeded, and MOTIR-1900 makes
  the invite a side effect after commit that degrades gracefully.

| Invitation state | How it reads                                                                                                          | Forward paths                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `invited`        | `Mail` in `--el-info` + **"Invitation sent"** · to `@login`, waiting to be accepted on GitHub                         | **Open the invitation** · **Resend invitation** |
| `accepted`       | `BadgeCheck` in `--el-success` + **"You have access"** · `@login` can clone and push                                  | (settled — nothing offered)                     |
| `not invited`    | `UserPlus` in `--el-warning` + **"Not invited yet"** · Motir doesn't know your GitHub account yet, in `role="status"` | **Connect GitHub**                              |

GitHub owns the acceptance, so Motir shows the truth and a way back to it rather than pretending to
know more than it does. Every state carries an icon **and** a word, never colour alone.

---

## 6. The technical path (panels 5–7) — behind "I already have code"

**Panel 5.** One short confirmation — **"Use the code you already have"** — then the **shipped**
connect flow. The re-wording matters: this door is an alternative **SOURCE**, not an alternative
**HOME**. Motir never creates a repository in the user's account, so "use your own GitHub instead"
described a destination that no longer exists; what survives is connect-existing.

**Panel 6.** Once connected, repository vocabulary is theirs to read: one row per part the plan
needs, with a plain-language gloss beside each role chip (`web` · _The app people use_; `api` ·
_The service behind it_), the derivation's **"why"**, and reorder + a `⋯` menu at two or more rows.
One row drops the chip, the suffix, the grip and the menu. **A created row's owner prefix is fixed**
(Motir's org — `motir-projects` in the mock is a stand-in; MOTIR-1779 provisions the real one and
nothing here depends on its name) and the **name** is the editable part, per ADR §1.4.

### The per-row control: why a single secondary replaced the `Segmented`

| Level         | Control                                                          | The question it answers                    |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| **Per row**   | one quiet secondary: **Use one of mine** ⇄ **Let Motir host it** | _where does THIS part live_                |
| **Set level** | **Add a repository**                                             | _the plan needs a part Motir didn't infer_ |

The `Segmented` is gone because it had one option left. It answered "where does this part live" with
**Create for me** vs **Use one of mine**, and the ADR amendment deleted the first: "create" no longer
means "in your account". A two-way control offering one real destination misrepresents the choice, so
the row now has a **default** (Motir creates it) and **one action** to leave it. The action's label
names the mode you would switch TO, so a connect-existing row offers **Let Motir host it** in the
same slot.

The original ambiguity fix still holds and is the reason the levels are drawn apart: "Add a
repository" and "use an existing repository" once sat **side by side on one line**, which made them
read as two ways of doing the same thing. One asks _where_; the other asks _how many_ — so they are
never at the same weight on the same line.

**Panel 7 — the per-row states, on this path only.**

| State       | How it reads                                                                                                                                                                                 | Forward paths                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `creating`  | Per-row `Spinner` + **"Creating…"** + _"Seeding it from the starter"_, in `role="status"`. Siblings keep working.                                                                            | resolves to `created` / `failed` **after a readiness read** (spike §4.2) |
| `created`   | `--el-success-surface` row · `CircleCheckBig` in `--el-success` + **"Created"** · the real `owner/name` as an external link · **plus its invitation sub-state** (panel 4)                    | (settled)                                                                |
| `connected` | `--el-notice-info-bg` row · `Link` in `--el-info` + **"Connected"** · _"nothing was created and nothing was changed in it"_                                                                  | (settled)                                                                |
| `skipped`   | Quiet `--el-surface-soft` row · `SkipForward` in `--el-icon-muted` + **"Skipped"** · what Motir will do about it                                                                             | **Create it after all** · **Use one of mine**                            |
| `failed`    | `--el-danger-surface` row · `TriangleAlert` in `--el-danger` + **"Couldn't create"** · the REAL reason, in `role="alert"` · the name field re-opened with the suffixed suggestion (ADR §1.5) | **Retry** · **Use one of mine** · **Skip this one**                      |

The gallery omits the invitation line from the `created` row only so each state reads on its own.
The two axes are independent by construction: `created` is about the repository existing,
`invited` / `accepted` / `not invited` is about the user being able to reach it, and neither can fail
the other.

**Rules the states obey**

- **Rows are independent** (ADR §4.2) — state lives on the row, so one spinner or failure never
  freezes or reverts a sibling. No set-level blocking overlay, and **no compensating delete**: a
  created repository is a real artifact, and removing it to tidy a report is the worse answer.
- **No state is a dead end** — `failed` and `skipped` keep every recovery, now or on a later visit
  (§4.1, §4.4).
- **State is never colour alone** — always an icon **plus a word** (finding #35), with
  `--el-text-strong` / `--el-danger-surface-text` ink over every tint.
- **No dashed or dotted border signals state.** The planning canvas already owns dashed for
  proposed nodes and red-hatch for cross-story dependencies; a hardcoded border-style also breaks
  the `data-style` shape axis.
- **A state pill is NOT used on a tinted row.** `Pill severity="danger"` is `--el-tint-rose` and
  `--el-danger-surface` is the _same value_, so a danger pill on a failed row is invisible — same
  for mint/`created` and muted/`skipped`. The tint goes on the **row**; the state is named in text
  beside its icon (`.row-state`). Only the role chip stays a `Pill tone="neutral"`, which has its
  own border and reads on every tint.

**The PARTIAL outcome** (end of panel 7) — created + failed + skipped in one set, still completable
(§4.3): a `role="status"` summary counting the truth, the primary becoming **Finish setup**, and
nothing pretending the failed row succeeded. Failure copy is now Motir-org-framed, because that is
where creation happens: a collision is _"Motir already hosts a repository called …"_, and a decline
is reported without blaming the user's account for a limit it never hit.

---

## 7. Panel 8 — what this becomes when the hosted agent ships

Drawn as a **variant**, explicitly not as the main line, so the correction v4 made cannot quietly
reverse itself. Today (8a) every user continues into panel 3, because before Epic 9 there is no
non-technical workflow at all. After Epic 9 (8b) the access step becomes **optional** for the founder
who never touches code — the hosted agent pushes, the preview deploys, and they validate the running
site — and stays **required** for the developer who wants the repository on their machine.

**No drawn surface changes between them**: same step, same copy, same states. Only which action is
primary after `created` changes — which is exactly why the access step is its own step (panel 3)
rather than a fourth branch welded into panel 2's `created` state, and it is the one thing MOTIR-1782
should keep swappable.

---

## 8. Primitives — every element, and what it is

| Element                           | Primitive                                                           | Notes                                                                                          |
| --------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Step statement                    | `h2` `font-serif`                                                   | 28px on the default + access paths, 22px on the technical one                                  |
| "Your project's code" overline    | `SectionLabel`                                                      | mono · 11px · 0.06em · `--el-text-eyebrow`                                                     |
| Primary action                    | `Button variant="primary"`                                          | `Continue` · `Connect GitHub` · `Open the invitation` · `Try again` · `Set up N repositories`  |
| Quiet secondary                   | a text button in `--el-link`                                        | `I already have code` · `Later` · `Go to my backlog` · `Use one of mine` · `Let Motir host it` |
| **Ownership promise**             | a callout `div` (`--el-surface-soft` + `--el-border-soft`) + `Lock` | a standing guarantee, not a severity tint; carries the transfer door                           |
| Default-path state line           | `Spinner` / lucide icon + text                                      | `role="status"` while working, `role="alert"` on failure                                       |
| **Per-row invitation line**       | lucide icon + a word + detail text                                  | `Mail` / `BadgeCheck` / `UserPlus`; inside the row, never its own row                          |
| A row container (≥2 rows)         | `Card` (untinted, `data-surface="card"`)                            | `--radius-card` · `--el-border` · row padding, not `--spacing-card-padding`                    |
| Repository name field             | `Input` (composing `FormField`)                                     | `addonStart` carries the fixed `motir-projects /` prefix; `error` variant on a failed row      |
| Existing-repository picker        | `Combobox`                                                          | over the repos the installation grants; "Grant more on GitHub" hands off to 7.10               |
| Role chip                         | `Pill tone="neutral"`                                               | mono; roles are metadata, not a status — no semantic tint is spent on them                     |
| Reorder / menu trigger            | icon `Button` at `--height-control` + `--radius-control`            | `ChevronUp` / `ChevronDown` / `Ellipsis`                                                       |
| Row `⋯` menu                      | `Popover` + a menu list                                             | `--radius-card` container, `--radius-control` rows, `--el-option-active-bg`                    |
| The "why" panel                   | a callout `div` (`--el-callout-bg`) + `Sparkles`                    | mirrors the shipped AI-proposal callout; not a `Tooltip`                                       |
| Row recoveries                    | `Button variant="secondary" size="sm"` + `ghost sm`                 | Retry / Open the invitation emphasized; the others quiet                                       |
| Rail (status · history · outcome) | **the shipped `PlanReviewRail`**                                    | reused verbatim                                                                                |

**`Segmented` is no longer used by this surface** (v3 used it for the per-row create/connect choice;
see §6). **No new primitive is introduced.** If MOTIR-1782 finds it needs one, that is its own
`design/` subtask, not an improvisation.

---

## 9. Token roles — colour (`--el-*`) and shape

Every value in the mock's `:root` block was **generated** from `packages/design-system/theme.css`
(the Tier-0 `@theme` + Tier-3 `:root,[data-appearance-scope]` blocks), so no hex was retyped and the
asset cannot drift. The only raw values in the file are the mock **board's own** backdrop and the
canvas grid-dot texture — non-semantic decoration, per the colour rule's carve-out. Every icon path
is generated from `lucide-react`'s `__iconNode` (the octocat mark verbatim from
`components/icons/GithubMark.tsx`, which lucide has no equivalent for). **Dark mode needs nothing
extra in the BUILT component:** every colour the step renders is an `--el-*` reference — verified
mechanically, zero `--color-*` and zero hex/`rgb()` in the authored rules and markup — so
`theme.css`'s `[data-theme='dark']` block re-skins it with no per-component work. The **asset
itself is light-only**, which is this repo's convention for `design/*.mock.html` (it embeds the
generated light token block, not the dark one); that is a property of the mock, not a gap in the
design.

| Element                                                           | Token                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Step pane (behind the step)                                       | `--el-canvas`                                                        |
| Row container · rail card                                         | `--el-card` · `--el-surface` / `--el-surface-soft`                   |
| Statement / body / helper ink                                     | `--el-text` · `--el-text-secondary` · `--el-text-helper`             |
| Overline                                                          | `--el-text-eyebrow`                                                  |
| **Ownership promise** · its border · its icon                     | `--el-surface-soft` · `--el-border-soft` · `--el-icon-muted`         |
| Field · combobox                                                  | `--el-page-bg` fill · `--el-input-border` · `--el-text-muted` prefix |
| Primary action                                                    | `--el-accent` / `--el-accent-text`                                   |
| Quiet secondaries and links                                       | `--el-link`                                                          |
| "ready" state icon · `created` row                                | `--el-success` · `--el-success-surface`                              |
| **`invited`** icon · **`accepted`** icon · **`not invited`** icon | `--el-info` · `--el-success` · `--el-warning`                        |
| Invitation state WORD (on a tinted row)                           | `--el-text-strong`                                                   |
| `connected` row · its icon                                        | `--el-notice-info-bg` · `--el-info`                                  |
| failure icon · `failed` row · its ink                             | `--el-danger` · `--el-danger-surface` · `--el-danger-surface-text`   |
| `skipped` row · its icon                                          | `--el-surface-soft` · `--el-icon-muted`                              |
| The "why" callout · its sparkle                                   | `--el-callout-bg` · `--el-accent-on-surface`                         |
| Role chip                                                         | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`          |
| Rail status pill (Approved)                                       | `--el-tint-mint` + `--el-text-strong` (the shipped `STATUS_TINT`)    |

| Surface                                             | Shape token                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Buttons                                             | `--radius-btn` · `--height-btn-md` / `-sm` · `--spacing-btn-x`         |
| Row container · callouts · promise · menu · the box | `--radius-card`                                                        |
| Field · combobox trigger                            | `--radius-input` · `--height-input` · `--spacing-input-x`              |
| Role chip                                           | `--radius-badge` · `--spacing-chip-x` / `-y`                           |
| Icon buttons · menu rows                            | `--radius-control` · `--height-control` · `--spacing-control-x` / `-y` |
| Menu elevation                                      | `--shadow-elevated`                                                    |

**No Tier-0 `--color-*`, no generic `--radius-sm/md/lg`, no raw `rounded-md` / `p-2` / `h-9`, no
invented hue.** The default and access paths are deliberately quiet (ink, accent, one state hue at a
time); the semantic spread — success, info, danger, warning, the lavender AI callout, the neutral
chip — lives where there are states to tell apart, so neither screen is grey-and-purple (finding #54)
and neither is a fruit salad.

---

## 10. Copy — every string, as `en.json` keys

Namespace **`repositorySet`**. MOTIR-1782 / MOTIR-1900 add these to `messages/en.json` **and**
`messages/zh.json` (the i18n-catalog parity test fails otherwise).

### The default path

| Key                  | String                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `overline`           | Your project's code                                                                                                 |
| `title`              | Motir will host your code                                                                                           |
| `lead`               | Your project's code lives with Motir, ready for your agents to start work.                                          |
| `promise`            | **It's yours.** Motir keeps it safe and private — move it to your own GitHub whenever you want.                     |
| `promiseDoor`        | How moving it works _(the link into MOTIR-711's transfer)_                                                          |
| `continueCta`        | Continue                                                                                                            |
| `iHaveCode`          | I already have code                                                                                                 |
| `working`            | Setting up your code…                                                                                               |
| `workingDetail`      | This takes a few seconds. Your plan is already in your backlog — you can leave this page.                           |
| `ready`              | Your code is ready                                                                                                  |
| `goToBacklog`        | Go to my backlog                                                                                                    |
| `setupFailed`        | Motir couldn't finish setting up your code                                                                          |
| `setupFailedDetail`  | Your plan is safe in your backlog. Nothing is lost — Motir will tell you if a task needs code that isn't ready yet. |
| `tryAgain`           | Try again                                                                                                           |
| `outcomeReady`       | Your code is ready _(the line added to the rail's outcome)_                                                         |
| `outcomeNeedsAccess` | Finish setting up access _(the rail's outcome when the user chose Later)_                                           |

### The access step (MOTIR-1900)

| Key                  | String                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessTitle`        | Get access to your code                                                                                                                                             |
| `accessLead`         | Your code is private — only you and Motir can see it. Connect GitHub and Motir will invite you to it, so you can open it, clone it, and point your own agent at it. |
| `connectGithub`      | Connect GitHub                                                                                                                                                      |
| `accessLater`        | Later                                                                                                                                                               |
| `accessWhichAccount` | Motir invites the GitHub account you connect — you'll see which one.                                                                                                |
| `invitedTitle`       | You're invited to your code                                                                                                                                         |
| `identityVerified`   | Verified _(reuses `github.identity.verified` — the shipped `IdentityHeader`'s success pill)_                                                                        |
| `identityCaption`    | This is the account Motir invited                                                                                                                                   |
| `useOtherAccount`    | Use a different account _(re-runs the connect; it does NOT open a username field)_                                                                                  |
| `invitedDetail`      | Accept the invitation on GitHub and your code is yours to clone.                                                                                                    |
| `openInvitation`     | Open the invitation                                                                                                                                                 |
| `stateInvited`       | Invitation sent                                                                                                                                                     |
| `invitedRowDetail`   | to {login}, waiting to be accepted on GitHub                                                                                                                        |
| `resendInvitation`   | Resend invitation                                                                                                                                                   |
| `stateAccepted`      | You have access                                                                                                                                                     |
| `acceptedRowDetail`  | {login} can clone and push to this repository                                                                                                                       |
| `stateNotInvited`    | Not invited yet                                                                                                                                                     |
| `notInvitedDetail`   | Motir doesn't know your GitHub account yet                                                                                                                          |

### The technical path

| Key                   | String                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownTitle`            | Use the code you already have                                                                                                                                   |
| `ownLead`             | Motir will use repositories you already have instead of creating new ones. You pick which ones it may see, on GitHub — Motir never sees the rest.               |
| `letMotirHost`        | Let Motir host it                                                                                                                                               |
| `setTitle`            | Where should each part live?                                                                                                                                    |
| `setLead`             | Connected as {login}. Your plan separates the web app from the API, so Motir needs a home for each.                                                             |
| `roleGlossWeb`        | The app people use                                                                                                                                              |
| `roleGlossApi`        | The service behind it                                                                                                                                           |
| `useOneOfMine`        | Use one of mine                                                                                                                                                 |
| `nameLabelForRole`    | Name of the {role} repository                                                                                                                                   |
| `nameLabelOne`        | Repository name                                                                                                                                                 |
| `pickerLabelForRole`  | Repository to use for the {role}                                                                                                                                |
| `pickerLabelOne`      | Repository to use                                                                                                                                               |
| `pickerHint`          | Only the repositories you granted Motir appear here.                                                                                                            |
| `grantMore`           | Grant more on GitHub                                                                                                                                            |
| `seedStarter`         | Motir creates and hosts it · seeded from the Motir Next.js starter.                                                                                             |
| `seedInitialised`     | Starts with a README, a licence, a `.gitignore` and a CI stub — your first task in it builds the skeleton.                                                      |
| `monorepoHint`        | Everything lives here. Motir won't create anything.                                                                                                             |
| `whyTrigger`          | Why this repository?                                                                                                                                            |
| `whyApi`              | {n} of the {total} items you approved build a backend service, so Motir asked for a separate home for it. Remove this row to keep everything in one repository. |
| `addRow`              | Add a repository                                                                                                                                                |
| `rowActions`          | Repository actions                                                                                                                                              |
| `moveUp` / `moveDown` | Move up / Move down                                                                                                                                             |
| `removeRow`           | Remove                                                                                                                                                          |
| `skipRow`             | Skip this one                                                                                                                                                   |
| `setUpMany`           | Set up {n} repositories                                                                                                                                         |
| `notNow`              | Not now                                                                                                                                                         |
| `setupNote`           | The first row is your project's main repository. Nothing is created until you press Set up.                                                                     |
| `stateCreating`       | Creating…                                                                                                                                                       |
| `stateCreatingDetail` | Seeding it from the starter                                                                                                                                     |
| `stateCreated`        | Created                                                                                                                                                         |
| `createdDetail`       | Hosted by Motir · seeded from the Motir Next.js starter.                                                                                                        |
| `stateConnected`      | Connected                                                                                                                                                       |
| `connectedDetail`     | Your existing repository — nothing was created and nothing was changed in it.                                                                                   |
| `stateSkipped`        | Skipped                                                                                                                                                         |
| `skippedTitle`        | No repository for the {roleLabel}                                                                                                                               |
| `skippedDetail`       | Motir will plan around it, and say so when a task needs code that isn't there.                                                                                  |
| `createAfterAll`      | Create it after all                                                                                                                                             |
| `stateFailed`         | Couldn't create                                                                                                                                                 |
| `failedNameTaken`     | Motir already hosts a repository called {name}. Rename this one, or use one of yours instead.                                                                   |
| `failedDeclined`      | GitHub declined the request and nothing was created for this row. Motir will retry, or you can use one of yours instead.                                        |
| `retryRow`            | Retry                                                                                                                                                           |
| `summaryPartial`      | {created} created · {skipped} skipped · {unresolved} needs a decision                                                                                           |
| `finishSetup`         | Finish setup                                                                                                                                                    |
| `finishHint`          | Your plan is already in the backlog. Motir will tell you which tasks are waiting on a repository.                                                               |
| `finishSetupLink`     | Finish setting up repositories                                                                                                                                  |

**Removed in v4:** `createForMe` ("Create for me") and `whereRoleLives` (the `Segmented`'s group
label) — the control they belonged to no longer exists. `failedLimit` is replaced by
`failedDeclined`, because the repository limit it named was the user's account limit and creation no
longer happens there. `readyDetail` and `seeWhereItLives` fold into `promise` and the access step.

### Accessible names — the superstring audit

A new control's accessible name must not **contain** an existing one, or `getByRole` starts matching
two things (the superstring-label class). Checked programmatically against all 4,367 strings in
`messages/en.json`:

- **`Later`** was chosen over "Not now", which this surface already uses at the technical path's set
  footer — two controls with the same name on one route is exactly the scoping problem the rule
  guards. "Skip for now" was rejected twice over: it contains **"Skip"**
  (`import.preview.actionSkip`) _and_ collides with this surface's own **Skip this one**. `Later`
  contains nothing in the catalog.
- **`Open the invitation`** was chosen over "Open invitation on GitHub", which would have contained
  **"GitHub"** (`shell.nav.github`, `github.title`, `publicProjects.github`) — a name already
  ambiguous across the app.
- **`Use one of mine`** was kept from v3 (chosen over "Connect existing", which would have contained
  the exact existing name **"Connect"**), and **`Let Motir host it`** is reused verbatim at BOTH
  altitudes — the step-level way back (panel 5a) and the row-level mode switch (panel 6). That is one
  name for one action rather than two near-duplicates; **note for MOTIR-1785: scope that locator to
  the row or the step under test**, never the page.
- **`Resend invitation`** contains **"Resend"** (`settings.profile.email.pending.resend`), on the
  account-settings surface only — no route renders both, so no locator can straddle them.
- **`Continue`**, **`Retry`** and **`Remove`** duplicate `auth.continue`,
  `dashboards.states.retry` and `settings.members.remove` **exactly**. Exact duplicates on other
  surfaces are fine and already the norm — only containment breaks a selector.
- **`Connect GitHub`** is the **same** name as the shipped Git-settings button, deliberately: it is
  the same action, and the E2E should be able to reach either by the same name. It now appears at
  three altitudes here (the access prompt, a `not invited` row, and panel 2's `created` state) —
  scope by container.
- **Within this surface**, no name contains another. **`I already have code`** appears on both the
  default step and the failure state, so scope that locator to the state under test rather than the
  page.

---

## 11. a11y

- **Every state carries text**, not colour alone (finding #35); tinted rows hold
  `--el-text-strong` / `--el-danger-surface-text` ink so AA holds in both themes. The three
  invitation states are `Mail` / `BadgeCheck` / `UserPlus` **plus** a word, so `invited` and
  `accepted` are distinguishable without hue.
- **`role="status"`** on the default path's _Setting up your code…_, on each `not invited` row, and
  on the partial summary; **`role="alert"`** on the default path's failure sentence and on each
  failed row's reason — the row that failed announces itself, not the whole step.
- **The reorder affordance is keyboard-operable** — the grip is decorative (`aria-hidden`) and the
  real controls are **Move up** / **Move down**; drag is an enhancement, never the only path.
- **Every field has a real label** — visible at one row (**Repository name**), visually hidden but
  role-specific at ≥2 (**Name of the web repository**), so rows stay distinguishable to a screen
  reader even though the visible label is the role chip.
- **The `⋯` menu is a `Popover`** whose trigger is named **Repository actions** — a menu with a
  door, and never portaled to `document.body` (that breaks it inside Radix).
- **Long names must not blow out the row.** Every flex column carries `min-width: 0` and the full
  `owner/name` truncates — this repo's recurring horizontal-overflow class is a missing `min-w-0`.

---

## 12. Page state after the step's mutations (the enforced contract)

Setting up code — and then granting access — changes three surfaces, and they do **not** all refresh
the same way (`motir-core/CLAUDE.md`):

1. **The step's own state line / row** — the response IS the confirmation. Keep the returned state;
   do **not** `router.refresh()` it (the refresh re-reads and causes a visible revert). This now
   covers the invitation sub-state too: a **Resend invitation** response is the confirmation, not a
   reason to re-read the row.
2. **The rail's outcome card** (server-rendered from the plan review read) — `router.refresh()`
   reaches it, which is how **"Your code is ready"** / **"Finish setting up access"** appears.
3. **Any client island seeded from server props** — the code-context surface and any nav badge own
   their own state; `router.refresh()` cannot reach them, so they need an explicit refetch trigger
   (a provider tick). MOTIR-1782 does the ones that exist and leaves the rest to MOTIR-1764.

**Per-row polling is a fourth mechanism, not one of these three** (spike §4.2): each row's
`creating → created` transition is settled by a readiness read, so the row is an async job with its
own poll, and `router.refresh()` is neither how it starts nor how it finishes.

---

## 13. Explicitly OUT of scope here (so nothing is built twice)

- **The plan-approval surface, the canvas, the review rail** — shipped (MOTIR-847 / 1193 / 1194).
  Composed, not redrawn.
- **The GitHub connect / install screens** — 7.10. Only the hand-off is drawn, and only grant 1 is
  needed by the access step.
- **The collaborator-invite service itself** — MOTIR-1900. Its states are drawn; none of its code,
  credential handling, or failure taxonomy is designed here.
- **The code-context / index-freshness surface, and the code-blind planning signal** — MOTIR-1764
  (Story MOTIR-1754). Pointed at as the durable home of the set and of unfinished access; none of it
  drawn.
- **The claim / transfer flow** — ~~MOTIR-711 (9.3.7). Only the promise and its door are drawn.~~
  **Superseded 2026-07-31: it is now DRAWN, in this same area — [`takeover.mock.html`](./takeover.mock.html), §14
  below (MOTIR-1938 design → MOTIR-1939 surface; MOTIR-711 keeps the backend saga).** This line is
  the reason MOTIR-1938 exists: the promise and its door shipped while the room behind them did
  not, so the shipped `OwnershipPromise` renders the door UNLINKED on purpose. §14 is what lets
  MOTIR-1939 link it.
- **The repo-set table, the derivation service, the creation primitive** — MOTIR-1780 / 1881 / 1781.
  Behaviour is quoted; no schema or service is designed here.
- **The hosted agent, and anything that makes panel 8b real** — Epic 9. Panel 8 records the
  consequence; it does not design the agent, its dispatch, or the CI metering that gates it.
- **The multi-stack scaffold registry** — MOTIR-709 (9.3.5). The notes say honestly that a non-web
  repo starts near-empty until then, rather than implying a scaffold that does not exist.

---

---

# 14. `takeover.mock.html` — the TAKE-IT-OVER flow

**Subtask MOTIR-1938 (design gate, Principle #13).** The design reference for moving a
Motir-hosted repository to the user's own GitHub: the per-row action, the target picker, the costs
stated before the commit, and the asynchronous transfer + App re-install drawn as **durable,
re-promptable states**. Layout source of truth for **MOTIR-1939** (the surface); the saga behind it
is **MOTIR-711**.

- **Asset of record:** [`takeover.mock.html`](./takeover.mock.html); `.png` export
  [`takeover.png`](./takeover.png) (full-page, light theme, `deviceScaleFactor: 2`, width 1200).
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries — MOTIR-1939's.

## 14.1 · The answer in one line

**Every Motir-hosted row carries one secondary action — `Move to my GitHub` — and everything after
it lives on the ROW, not in a dialog.** The decision (which account, and what it costs) is a modal;
the _waiting_ is a durable row state that survives a reload, says what the user must go and do, and
re-prompts every time it is seen.

## 14.2 · The flow was GROUNDED, not invented — every source, and what it decided

Nothing in this asset is a new product decision. Each element traces to a decided source:

| Drawn thing                                                                                                           | Decided by                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The state machine `requested → transfer_pending → awaiting_reinstall → done`, plus `failed`                           | **MOTIR-711** — _"model the states explicitly … so a transfer nobody accepts, or a re-install nobody finishes, is re-promptable rather than a wedged repo"_                                                                                                                  |
| **Per ROW, not per project**; taking over one row of three must not wedge the others (panel 8)                        | **MOTIR-711** — _"Per ROW, not per project. … Taking over one row of three is legitimate and must not wedge the others."_                                                                                                                                                    |
| `transfer_pending` is a real state, **not a spinner**; a personal-account target must accept ON GitHub (panels 4, 7b) | **MOTIR-711** step 2 — _"the call is asynchronous, and for a personal-account target the new owner must accept on GitHub, so `transfer_pending` is a real state resolved by a webhook or a poll, not a spinner"_                                                             |
| `awaiting_reinstall` exists at all, and why dispatch stops (panel 5)                                                  | **MOTIR-711** — _"a GitHub App installation is account-scoped … the flow must re-establish the grant on the new owner, or dispatch and the code-graph index silently stop working"_                                                                                          |
| Reaching `done` needs a real new installation, not just the transfer (panel 6)                                        | **MOTIR-711** step 4 — _"do not mark done on the transfer alone"_                                                                                                                                                                                                            |
| The already-yours row is a clean **no-op with no control** (panel 1)                                                  | **MOTIR-711** (_"a no-op for a row the user already owns"_) + ADR `project-repository-set.md` §3 / the 2026-07-30 amendment (a set mixes ownership only via a deliberate connect-existing row)                                                                               |
| The three cost lines, and the ban on "one click" (panel 3)                                                            | **`ci-minutes-allowance.md` §D** — the takeover option _"states its **real costs**: a GitHub account you own, an **asynchronous transfer you must accept on GitHub**, and a **re-install of the Motir App** on the new owner so dispatch keeps working. Never 'one click.'"_ |
| The billing framing sentence, quoted verbatim (panel 3)                                                               | **§D** — _"GitHub bills you for Actions directly from then on, and Motir stops charging CI credits"_                                                                                                                                                                         |
| "Actions come back on … even while your organization is out of credits" (panels 1, 3)                                 | **§G** — _"the transfer RESUMES Actions on the repository, unconditionally — even while the org is still exhausted"_                                                                                                                                                         |
| Motir stops billing this repo's CI after the move (panel 6)                                                           | **§5.4** — _"Metering STOPS at the transfer, because the owner login changes at the transfer itself"_                                                                                                                                                                        |
| The no-identity state reuses MOTIR-1900's connect prompt rather than drawing a second one (panel 2d)                  | **MOTIR-711** (_"the service returns the typed error the surface renders as MOTIR-1900's connect prompt"_) + this card's own instruction                                                                                                                                     |
| The takeover option is never hidden or gated on a stored identity                                                     | **§D** — _"never hidden, never disabled, and never gated on a stored identity — gating it on one would hide it from every user"_                                                                                                                                             |

**The design adds no state, no ordering and no policy of its own.** Where it had to choose, it chose
presentation (which surface a state lives on, what a line says), never behaviour.

## 14.3 · Drawn against SHIPPED reality — what was RENDERED first

Three of the things this asset composes already exist as running code or as shipped design assets.
Per `notes.html` **#73** — _"'design against shipped reality' means SEE the pixels, not read the
code"_ — all of them were **rendered before anything was drawn**, and the mock mirrors those renders:

1. **`components/planning/repositories/RepositoryRow.tsx` — shipped code (MOTIR-1782, merged in
   `cefe76c9`).** ⚠️ **The card's premise that "the repo-set step ships as a mock" was already stale
   when this ran** — MOTIR-1782 landed the step as real components, so the row was rendered headless
   from its own source + the real compiled `globals.css` (a throwaway happy-dom render → Tailwind v4
   via `@tailwindcss/postcss` → Playwright). What the render corrected, that reading the `.tsx`
   alone would not have:
   - the row is a **flex pair** — a `min-w-0 flex-1` main column plus a `shrink-0` control column —
     not the mock's horizontal action group;
   - its padding is **`--spacing-card-padding` (24px)**, not the 16px `repository-set.mock.html`
     drew, so a takeover row is visibly roomier than the establish-step row it descends from;
   - the state is an **icon + a WORD** in `--el-text-strong`, and the tint sits on the ROW
     (`--el-success-surface` / `--el-notice-info-bg`), never in a `Pill`.
2. **`gitSettingsPrimitives.tsx` — `IdentityHeader` + `GrantRow`, shipped code.** Rendered the same
   way. Panel 5b **reuses** them; it does not redraw a stand-in (the exact MOTIR-1196 failure #73
   records).
3. **The two host design assets** — `repository-set.mock.html` panel 1 (the promise + its door) and
   `design/billing/ci-line.mock.html` panel 2 (the exhausted `Move repositories` option). Rendered
   with Playwright and **composed verbatim, including their copy**. Neither is redrawn.

**The shipped door is deliberately dead, and that is this card's whole reason for existing.**
`RepositorySetStep.tsx` renders the promise but _not_ its link, with the reason in a source comment:
_"a link to a 404 is a worse broken promise than no link, and a surface that draws a door owes a
real entrance."_ §14 is the entrance that lets MOTIR-1939 light it.

## 14.4 · Placement and the access path — three doors, one room

**The room is `/settings/project/repositories`.** Not a modal, not a page invented for the flow, and
not the code-context surface (MOTIR-1764) — that does not exist yet, and designing a room inside an
unbuilt host is the mistake-#130 shape (_"a design DEFERRED a capability to a 'downstream' that does
not provide it"_).

**Why the project-settings area is the shipped answer, verified at rung 2.**
`lib/settings/projectSettingsNav.ts` is a typed REGISTRY that drives three surfaces at once — the
settings rail, the ⌘K deep links, and a **totality test** that pairs every
`settings/project/**/page.tsx` route 1:1 with a registry entry. Its own comment states the
extension mechanism: _"A later admin story mounts its page by ADDING an entry here — no layout
change."_ So the new entry — `id: 'repositories'`, `group: 'general'`, `icon: FolderGit2`,
`access: browse` — is **not an extra surface this design invented**; it is the mount, and a page
without it fails the totality test.

**The three doors (panel 0), each drawn as a real affordance inside its host:**

| #   | Door                                                | Host                                                                          | Where it lands                             |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `How moving it works` link in the ownership promise | the establish step, `/plans/[id]` (shipped mock + shipped `OwnershipPromise`) | `/settings/project/repositories`           |
| 2   | `Move repositories` secondary button                | the exhausted `Motir CI` billing card, `/settings/organization/billing`       | the same room, for this project            |
| 3   | `Repositories` rail row                             | the project-settings area itself                                              | the same room — the **permanent** way back |

**Door 3 is what makes the flow re-enterable**, and it is not optional: a `transfer_pending` that
sits for days must be reachable from somewhere that is always there, not only from an approval step
the user left weeks ago.

**⚠️ The org→project scope gap, drawn rather than papered over.** Door 2 lives on the **org**
billing panel, but a takeover is **per ROW** and rows belong to a **project**. So the room's header
carries the org-wide truth back: the paused banner names the _other_ projects Motir still hosts,
each a link, and says in words that moving this project's repositories does not move theirs. That
keeps ADR §D's _"ONE decision surface, N pointers"_ intact — the billing line remains the decision
surface and the room remains the place the decision is carried out — without letting an org-scoped
button silently act on one project and abandon the rest.

## 14.5 · The panels

| Panel                        | What it draws                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 · The doors**            | All three entrances, haloed, inside repros of their host surfaces, plus where each lands.                                                                                              |
| **1 · The room**             | `/settings/project/repositories` in the shipped settings shell: the paused-org banner, two `created` rows each with `Move to my GitHub`, and the already-yours row with **no action**. |
| **2 · Pick the target**      | 2a orgs loaded (personal first) · 2b the org lookup in flight · 2c the lookup failed, degraded not blocked · 2d **no GitHub identity** → MOTIR-1900's connect prompt, reused.          |
| **3 · The costs**            | The confirm step: the three real costs, each with its consequence, plus §D's verbatim billing sentence and §G's Actions-come-back reassurance.                                         |
| **4 · `transfer_pending`**   | The row as a durable waiting state — what to do, where, and a re-prompt.                                                                                                               |
| **5 · `awaiting_reinstall`** | 5a the row (with the dispatch consequence stated) · 5b the **shipped** install hand-off it points at, not redrawn.                                                                     |
| **6 · `done`**               | The row settles into the same shape a connect-existing row has always had — `Yours` — plus the one thing that really changed: who pays.                                                |
| **7 · `failed` + recovery**  | The single true failure (red), beside the two **non**-failures (peach) — an unaccepted transfer and an unfinished re-install, each re-promptable.                                      |
| **8 · One row of three**     | The set mid-move: three ownerships, three states, all legal at once, with a summary that counts the truth.                                                                             |

### Why the decision is a modal and the state is not

Everything in panels 2–3 is transient — pick a target, read the costs, confirm — so it is a
`Modal`. Everything in panels 4–7 **outlives that dialog**, survives a reload and must be
re-promptable, so it lives on the ROW. That split is precisely what stops `transfer_pending` from
being drawn as a spinner in a dialog nobody kept open, which is the failure MOTIR-711 names.

### Why the org list has three states, and the personal account has none

⚠️ **Rung-2 constraint, read from the shipped schema.** `GithubIdentity` (`prisma/schema.prisma`)
stores exactly one login — the user's **personal** `githubLogin` — plus their encrypted token. There
is **no stored organization list anywhere**, so the orgs are a live `GET /user/orgs`, which can be
slow and can fail. An instantly-populated org list would be a drawing of a system that does not
exist. The **personal account is never behind that call**, which is what lets a failed lookup
degrade to a working picker (2c) instead of a blocked flow.

**And the org target has a real third-party PERMISSION price, stated once.** Transferring into an
organization needs permission to create repositories there; GitHub refuses it otherwise. That is
said once under the list — not repeated on every org row, and not used to hide the option. This is
`notes.html` **#180**'s lesson applied one surface over: the failure mode it records is deciding
whose account a repository goes to _without pricing the third-party permission that answer commits
you to_. Panel 7a draws the refusal honestly rather than pretending it cannot happen.

> **Open question for MOTIR-711, recorded rather than assumed.** MOTIR-711 specifies the acceptance
> step for a **personal-account** target. Whether an ORG target also requires an acceptance/approval
> hop is a GitHub API semantic this design did not verify and does not decide. **The drawn states
> are correct under either answer** — `transfer_pending` is a durable, re-promptable state for any
> target, and `done` is gated on a real installation — so MOTIR-1939 needs no design change
> whichever way MOTIR-711 resolves it. Flagged here so it is a checked assumption, not a silent one.

## 14.6 · Primitives — every element, and what it is

| Element                                                                      | Primitive                                     | Notes                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each repository row                                                          | **the shipped `RepositoryRow` shape**         | `flex gap-3 rounded-(--radius-card) border p-(--spacing-card-padding)`; `min-w-0 flex-1` main column + `shrink-0` aside. Mirrored from a real render.                       |
| Role chip (`web` / `api` / `shared`)                                         | `Pill` `tone="neutral"`, `font-mono`          | The only pill on a row — it has its own border and reads on every tint.                                                                                                     |
| State (`Created` / `Yours` / waiting / `Couldn't move it`)                   | icon + word, `--el-text-strong`               | **Never** a `Pill` on a tinted row: `Pill severity="danger"` and `--el-danger-surface` are the same token value, so it would be invisible (finding #35, inherited from §9). |
| `Move to my GitHub`, `Accept it on GitHub`, `Install on GitHub`, `Try again` | `Button variant="secondary" size="sm"`        | Lives in the row's shipped `RowActions` strip — the same slot `Let Motir host it` already occupies. **No new row affordance is introduced.**                                |
| `Check again`, `Pick a different account`                                    | `Button variant="ghost" size="sm"`            | The quieter half of a recovery pair.                                                                                                                                        |
| `Move this repository`, `Continue`, `Connect GitHub`                         | `Button variant="primary"`                    | One primary per modal step, never two.                                                                                                                                      |
| `Cancel`, `Back`, `Later`                                                    | `Button variant="ghost"`                      |                                                                                                                                                                             |
| The decision dialog                                                          | `Modal`                                       | `--radius-modal` + `--shadow-modal`.                                                                                                                                        |
| The target picker                                                            | `Combobox`-family listbox                     | Grouped: **Your account** then **Your organizations**; the selected option carries a check, not colour alone.                                                               |
| The costs block                                                              | `Card`-family callout on `--el-surface-soft`  | Not a `Pill` list and not fine print — it is the step's substance.                                                                                                          |
| The billing consequence                                                      | notice on `--el-notice-info-bg`               | Informational, not a warning: it states a fact, not a risk.                                                                                                                 |
| The paused-org banner                                                        | notice on `--el-warning-surface`              | Mirrors the shipped billing card's own paused register.                                                                                                                     |
| Section eyebrows                                                             | `SectionLabel`                                |                                                                                                                                                                             |
| The re-install hand-off                                                      | **the shipped `IdentityHeader` + `GrantRow`** | From `gitSettingsPrimitives.tsx`, rendered and reused — 7.10 owns that pane; this flow links into it and adds nothing to it.                                                |
| The org-lookup spinner                                                       | `Spinner`                                     | One row inside the listbox, `role="status"`.                                                                                                                                |
| Settings rail + pane                                                         | the shipped settings AREA shell               | `SidebarNav` groups (General / Access / Work / Automation) from `PROJECT_SETTINGS_NAV`.                                                                                     |

## 14.7 · Token roles — colour (`--el-*`) and shape

**Three ownership/attention registers, each a palette token, each paired with an icon + a word.
No state is ever carried by colour alone, and no colour is invented** (the `--el-*`-only rule; the
`:root` block in the mock is GENERATED from `@motir/design-system/theme.css`, so nothing is retyped).

| Register              | Fill                   | Ink                        | Means                                                                                                                                                                                                |
| --------------------- | ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Motir-hosted, settled | `--el-success-surface` | `--el-text-strong`         | Created and running, Motir pays the CI. Same token the shipped `created` row uses.                                                                                                                   |
| **Yours**             | `--el-notice-info-bg`  | `--el-text-strong`         | The user owns it. **Deliberately the same fill the shipped `connected` row uses** — a repo that was taken over and a repo that was brought in are the same thing, which is the point of the promise. |
| **Waiting on you**    | `--el-warning-surface` | `--el-warning-text`        | `transfer_pending` / `awaiting_reinstall`. A third register on purpose: not settled, not broken — _the next move is yours, on GitHub_.                                                               |
| Failed                | `--el-danger-surface`  | `--el-danger-surface-text` | **Only** a request GitHub refused. An unaccepted transfer is NOT tinted as an error.                                                                                                                 |

| Element                        | Colour role                                                                                              | Shape role                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Row container                  | fill per the table above; `border-(--el-border-soft)` on a tint, `--el-border` untinted                  | `--radius-card` · `--spacing-card-padding`                                                              |
| State icon                     | `--el-success` / `--el-info` / `--el-warning` / `--el-danger`                                            | —                                                                                                       |
| Repo reference                 | `--el-link` (→ `--el-link-pressed`), mono; `--el-text` when there is nothing to link to yet              | —                                                                                                       |
| External-link + octocat glyphs | `--el-icon-muted`                                                                                        | —                                                                                                       |
| Helper / consequence copy      | `--el-text-helper`, escalating to `--el-text` for the load-bearing clause                                | —                                                                                                       |
| Role chip                      | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                              | `--radius-badge` · `--spacing-chip-x/y`                                                                 |
| Buttons                        | `--el-accent` / `--el-accent-text`; secondary `--el-button-border`                                       | `--radius-btn` · `--height-btn-sm\|md` · `--spacing-btn-x(-sm)`                                         |
| Modal                          | `--el-card` + `--el-border`                                                                              | `--radius-modal` · `--shadow-modal` · `--spacing-card-padding`                                          |
| Listbox + its options          | `--el-card`, active `--el-option-active-bg`, check `--el-accent-on-surface`                              | `--radius-card` (container) · `--radius-control` + `--spacing-control-x/y` (rows) · `--shadow-elevated` |
| Costs block                    | `--el-surface-soft` + `--el-border-soft`                                                                 | `--radius-card`                                                                                         |
| Billing-consequence notice     | `--el-notice-info-bg`, glyph `--el-info`                                                                 | `--radius-card`                                                                                         |
| Paused-org banner              | `--el-warning-surface` / `--el-warning-text`, glyph `--el-warning`                                       | `--radius-card`                                                                                         |
| Identity avatar                | `--el-avatar-fallback` + `--el-text-inverted`                                                            | circular (not style-dependent)                                                                          |
| `Verified` badge               | `--el-tint-mint` + `--el-text-strong`                                                                    | `--radius-badge`                                                                                        |
| Grant-row icon tile            | `--el-card-icon-bg` + `--el-card-icon-fg`                                                                | `--radius-control`                                                                                      |
| Settings rail                  | `--el-sidebar-bg` / `--el-sidebar-border`; active row `--el-sidebar-item-bg-active` + `--el-icon-active` | `--radius-control` · `--spacing-control-x/y`                                                            |
| Row menu button                | `--el-text-secondary`                                                                                    | `--radius-control` · `--height-control`                                                                 |

**AA holds by construction:** every tint carries `--el-text-strong` / `--el-warning-text` /
`--el-danger-surface-text` (all charcoal-family), never a mid-grey, and no page-level surface is
tinted.

## 14.8 · Copy — every string, as `en.json` keys

Namespace **`repositoryTakeover`**, except the two keys that belong to surfaces it extends.
⚠️ **Every key below needs a matching `zh.json` key or the i18n-catalog parity gate fails the PR**
(the same rule §10 carries).

### The keys that belong to surfaces this extends

| Key                         | English               |
| --------------------------- | --------------------- |
| `repositorySet.promiseDoor` | `How moving it works` |
| `settings.nav.repositories` | `Repositories`        |

_(`repositorySet.promise` is already shipped and unchanged. `promiseDoor` is the **one** string this
flow adds to the establish step — the link the shipped `OwnershipPromise` currently withholds.)_

### The room

| Key                   | English                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`               | `Repositories`                                                                                                                               |
| `lead`                | `Where {projectName}'s code lives. Motir hosts the repositories it created for you — move any of them to your own GitHub whenever you want.` |
| `summary`             | `{moving} moving · {hosted} hosted by Motir · {yours} yours`                                                                                 |
| `pausedTitle`         | `CI is paused — this organization is out of credits.`                                                                                        |
| `pausedBody`          | `Moving a repository to your own GitHub turns its Actions back on and GitHub bills you for them from then on.`                               |
| `pausedOtherProjects` | `Motir also hosts repositories for {projects} — moving this project's does not move theirs.`                                                 |
| `addCreditsInstead`   | `Add credits instead`                                                                                                                        |

### The row

| Key                    | English                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moveAction`           | `Move to my GitHub`                                                                                                                                                                        |
| `stateYours`           | `Yours`                                                                                                                                                                                    |
| `yoursDetail`          | `You already own this one — nothing to move, and Motir never bills its CI.`                                                                                                                |
| `statePending`         | `Waiting for you to accept on GitHub`                                                                                                                                                      |
| `statePendingStale`    | `Still waiting for you to accept on GitHub`                                                                                                                                                |
| `pendingDetail`        | `GitHub sent the transfer to {login}. It stays here until you accept it there — nothing expires on Motir's side, and the repository keeps working in the meantime.`                        |
| `pendingDetailStale`   | `Sent to {login} on {date} and not accepted yet. Nothing is wrong and nothing was lost — the repository is still here and still working. Accept it on GitHub to finish, or just leave it.` |
| `acceptOnGithub`       | `Accept it on GitHub`                                                                                                                                                                      |
| `checkAgain`           | `Check again`                                                                                                                                                                              |
| `stateReinstall`       | `Install Motir on {login}`                                                                                                                                                                 |
| `stateReinstallStale`  | `Install Motir on {login} to finish`                                                                                                                                                       |
| `reinstallDetail`      | `The repository is yours — the transfer went through. Install the Motir app on {login} and tick {repo} when GitHub asks which repositories it may see.`                                    |
| `reinstallDetailStale` | `It's yours and it stays yours. Motir just can't reach it to dispatch work until the app is installed on {login} with this repository selected.`                                           |
| `reinstallConsequence` | `Until you do, Motir can't dispatch work to this repository — your plan and your history are untouched.`                                                                                   |
| `installOnGithub`      | `Install on GitHub`                                                                                                                                                                        |
| `doneDetail`           | `Moved to {login} on {date}. GitHub bills you for Actions on it from now on, and Motir no longer charges CI credits for it. Dispatch is working.`                                          |
| `stateFailed`          | `Couldn't move it`                                                                                                                                                                         |
| `failedOrgPermission`  | `GitHub declined the transfer to {owner} — you need permission to create repositories in that organization. The repository is still here and still works; nothing was changed.`            |
| `tryAgain`             | `Try again`                                                                                                                                                                                |
| `pickDifferentAccount` | `Pick a different account`                                                                                                                                                                 |

### The decision (modal)

| Key                        | English                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modalEyebrow`             | `Move a repository`                                                                                                                                                                   |
| `modalEyebrowStep2`        | `Move a repository · step 2 of 2`                                                                                                                                                     |
| `modalTitle`               | `Move {repo} to your GitHub`                                                                                                                                                          |
| `modalTitleTarget`         | `Move {repo} to {login}`                                                                                                                                                              |
| `modalLead`                | `Motir transfers this repository out of its organization and into yours. Your work items, history and dispatch stay exactly where they are.`                                          |
| `targetLabel`              | `Where should it go?`                                                                                                                                                                 |
| `targetGroupPersonal`      | `Your account`                                                                                                                                                                        |
| `targetGroupOrgs`          | `Your organizations`                                                                                                                                                                  |
| `targetPersonalCaption`    | `Your personal GitHub account`                                                                                                                                                        |
| `orgsLoading`              | `Looking up your organizations…`                                                                                                                                                      |
| `orgsLoadingHint`          | `You can go ahead with your personal account — the lookup only adds organizations.`                                                                                                   |
| `orgsFailed`               | `Motir couldn't reach your GitHub organizations just now, so only your personal account is listed.`                                                                                   |
| `orgsRetry`                | `Try again`                                                                                                                                                                           |
| `orgPermissionNote`        | `Moving into an organization needs permission to create repositories there — GitHub refuses the transfer otherwise, and Motir says so rather than silently hiding the option.`        |
| `costsHeading`             | `What this takes`                                                                                                                                                                     |
| `costAccount`              | `A GitHub account you own.`                                                                                                                                                           |
| `costAccountDetail`        | `It goes to {login}, the account you connected.`                                                                                                                                      |
| `costTransfer`             | `A transfer you accept on GitHub. It isn't instant.`                                                                                                                                  |
| `costTransferDetail`       | `GitHub asks {login} to accept it. Nothing moves until you do, and nothing expires on Motir's side while you take your time.`                                                         |
| `costReinstall`            | `Re-installing the Motir app on the new owner.`                                                                                                                                       |
| `costReinstallDetail`      | `An app installation belongs to an account, so it does not travel with the repository. Until you re-install, Motir can't dispatch work to it.`                                        |
| `billingConsequence`       | `GitHub bills you for Actions directly from then on, and Motir stops charging CI credits.`                                                                                            |
| `billingConsequenceDetail` | `The code is yours either way — this changes who pays for the compute. Actions come back on for this repository as part of the move, even while your organization is out of credits.` |
| `confirmCta`               | `Move this repository`                                                                                                                                                                |
| `back`                     | `Back`                                                                                                                                                                                |
| `cancel`                   | `Cancel`                                                                                                                                                                              |
| `connectTitle`             | `Connect GitHub first`                                                                                                                                                                |
| `connectWhy`               | `Motir needs one thing to move a repository to you: the GitHub account it belongs to. It is the same account it invites you to your code with — you'll see which one.`                |

_(`connectTitle`'s body copy and its `Connect GitHub` / `Later` actions are **MOTIR-1900's**
existing strings, reused verbatim. This flow adds no second connect prompt.)_

**The copy rule that governs all of it, quoted from `ci-minutes-allowance.md` §D: never "one
click."** No string above says "instantly", "in one click", "just", or "simply". `costTransfer`
says the opposite in the affirmative — _"It isn't instant"_ — because the ADR's honesty requirement
is the point of the whole panel, not a caveat under it.

## 14.9 · a11y

- **Every state is icon + word**, never colour alone; the words are distinct
  (`Created` / `Yours` / `Waiting for you to accept on GitHub` / `Install Motir on {login}` /
  `Couldn't move it`), so a screen-reader user gets the same state a sighted one does.
- **The waiting states are `role="status"`**; the transfer failure is `role="alert"` — a refusal
  interrupts, a wait does not.
- **The org-lookup spinner row is `role="status"`** with a real label
  (`Looking up your organizations…`), never a bare animated element.
- **Accessible names carry the repository**, because a room lists several rows and
  `Move to my GitHub` × 3 is ambiguous: each row's action takes an `aria-label` of the form
  `Move {repo} to my GitHub`. Same for `Check again` / `Install on GitHub`.
- **No superstring collisions** with the establish step's names: `Move to my GitHub` is not a
  superstring of any shipped `repositorySet` label, and `Yours` is a new state word rather than a
  reuse of `Connected` (which stays the establish step's).
- **The listbox rows carry no action buttons** — a `role="option"` cannot hold one
  (the `listbox-row-actions` a11y rule); the permission note is a helper under the list, not a
  control inside it.
- **The picker is operable without the org lookup**: the personal option is present and selectable
  from first paint, so a failed or slow network never traps keyboard focus in an empty listbox.

## 14.10 · Page state after the takeover's mutations

The room is a settings page, so route each surface by HOW it renders (the enforced contract):

1. **The row that was acted on** — the mutation returns the row's new state; keep the optimistic
   value. Do **not** `router.refresh()` the row's own cell.
2. **The header summary** (`{moving} moving · {hosted} hosted by Motir · {yours} yours`) and the
   paused banner — server-rendered from the set read, so `router.refresh()` updates them.
3. **`transfer_pending` / `awaiting_reinstall` resolve OUT OF BAND** — by MOTIR-711's `repository`
   `transferred` webhook or an installation landing, neither of which is a click on this page. So
   `Check again` is a real re-read, and the row is a **polled async job** (the same fourth mechanism
   §12 records for `creating → created`), not something `router.refresh()` can be relied on to
   settle.

## 14.11 · Explicitly OUT of scope here

- **The saga itself** — MOTIR-711: the Actions re-enable ordering (§G), the transfer call, the
  `repository` `transferred` webhook handler, idempotency, the row lock. Its states are drawn; none
  of its code, credentials or failure taxonomy is designed here.
- **The GitHub connect / install screens** — 7.10. Only the hand-off is drawn, and it is the shipped
  components, reused.
- **The connect prompt** — MOTIR-1900. Reused, not redesigned.
- **The billing panel's exhausted state** — MOTIR-1902 / MOTIR-1903. Its `Move repositories` option
  is composed as a door; nothing about that card is changed here.
- **The establish step** — MOTIR-1778 / MOTIR-1782 (§0–§13 above). The only thing this asset adds to
  it is the one `promiseDoor` string.
- **Bulk / org-wide takeover** — not drawn, because MOTIR-711 is explicitly **per row**. The room
  names the other projects Motir hosts and links to them; it does not offer to move them.
- **Cancelling a pending transfer** — not drawn: MOTIR-711 models no cancel, and a control the saga
  cannot honour would be a worse promise than none.
- **The code-context surface** — MOTIR-1764. When it lands it can mount this same room as a
  component; the route chosen here exists today, which is why it was chosen.
