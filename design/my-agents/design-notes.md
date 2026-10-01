# `design/my-agents/` — My agents

**Story MOTIR-6860 · design MOTIR-6868.** Gates **MOTIR-6874** (the page, its dialog, its row actions
and its rail row). One surface: `my-agents.mock.html`.

One of **my agents** is one developer's long-lived agent machine on one project: booted from a sandbox
image, with the project's repositories cloned into a persistent home, signed in to its agent with the
developer's own account, charged per running minute and hibernated when idle.

**Everything this area can say is decided by `docs/decisions/agent-instances.md` (MOTIR-6866)** — the
states and their transitions (§4), the charge and the credit pre-flight (§5), the three caps (§6), the
permission (§8) and the offered profiles (§9). This asset draws those and invents none of them; the
section references below are to that record.

---

## Revision 3 — no organization limit (AMENDMENT 2)

`docs/decisions/agent-instances.md` AMENDMENT 2 removed the per-organization running cap, gave agents
their own pool, and charges a machine while it runs. On this page that means three things:

- **The _Organization limit_ refusal is gone** (panel 5). Credits decide how many agents an organization
  runs; _Your limit_ (10 agents per person) still bounds the storage every agent keeps.
- **_Motir is busy_ is the agent pool's own safety valve** — no longer CI's ceiling.
- **A hibernated row says why when Motir stopped it** — out of credits, idle, or 12 hours running
  (panel 4).

---

## The name — **My agents** (revision 2)

The first revision called this page **Instances**. Changes were requested on it (2026-09-29): _"We
don't call it instances, 'instances' is not a clear name. Is there a better name? What about 'my
agents'?"_ This revision adopts **My agents**:

- **It says whose and what.** The page lists only the reader's own machines (§8 — no key opens someone
  else's), and each is an agent they run. "Instance" is infrastructure vocabulary a developer does not
  use for their own agent.
- **It collides with nothing.** No page, rail row or route in the app is called "agents" today.
- **One word, one meaning per row.** A row is an **agent** (it has a name, a machine, a state). The
  Claude Code / Codex / … choice inside it is its **coding agent** — the dialog's field, the list's
  column and the "not offered" refusal all say _coding agent_, so "agent" never means two things on
  one row.

| Surface                | Revision 1                     | Revision 2                                  |
| ---------------------- | ------------------------------ | ------------------------------------------- |
| Rail row, page title   | Instances                      | **My agents**                               |
| Address                | `/instances`                   | **`/my-agents`**                            |
| Actions                | New / Create / Delete instance | **New agent / Create agent / Delete agent** |
| Empty state            | No instances yet               | **No agents yet**                           |
| Profile field / column | Agent                          | **Coding agent**                            |
| Permission label       | Use your own agent instances   | **Use your own agents**                     |

The permission's description becomes _"Create, wake, hibernate and delete your own agents on this
project — machines charged per running minute. It never opens anyone else's."_

**What does not change** — none of it is read by a user: the permission KEY `instance:use`, the
`AgentInstance` model and its tables, the service, the job ids and the `/api/projects/{key}/instances`
routes keep their names. The decision record (`agent-instances.md`) keeps its vocabulary as the
engineering name for the same thing.

---

## ⚠️ What this area does NOT draw

- **The right-half panel, the terminal and the agent sign-in** — opening an agent beside the list is
  the terminal story's (MOTIR-6861), whose design composes
  this page's list rather than redrawing it. **This page leaves the right half empty**, and a row click
  is inert until that story wires it.
- **The chat view** (MOTIR-6863), **Run in my agent** (MOTIR-6864) and **moving an agent to a
  newer image** (MOTIR-6862).
- **Any run section change.** Nothing on `/runs` moves.

---

## The surfaces — panel by panel

| Panel | What it settles                                                                    |
| ----- | ---------------------------------------------------------------------------------- |
| 0     | the rail row that reaches the page — position, label, glyph, registration          |
| 1     | the empty state                                                                    |
| 2     | the create dialog: name, the fixed project, the six-profile picker, the price line |
| 3     | the list, its columns, its pagination and the row menu                             |
| 4     | every lifecycle state, one row each                                                |
| 5     | every refusal, in words                                                            |
| 6     | the delete confirmation                                                            |
| 7     | the wait and the failure to load                                                   |
| 8     | the narrow width                                                                   |

### Panel 0 — THE ACCESS PATH: a primary rail entry, directly after Runs

Rendered against the shipped rail before drawing (`/runs` on this run's worktree): **Workbench · Work
Items · Ready · Runs · Boards · Roadmap · Plans · Backlog · Dashboard · Requested features · Reports ·
Approval records · Codebase**. The rule is `app/(authed)/_components/SidebarNav.tsx`'s own, stated in
`design/runs/design-notes.md` § _THE ACCESS PATH_: **every top-level project view is a primary entry**.

- **Position: directly after Runs.** Runs is where an agent works on a card; My agents is where your own
  agents live. The two are neighbours in the reader's head, and the terminal story will make them
  neighbours in behaviour (a card can be sent to one of your agents).
- **Label: `My agents`** (`nav.myAgents`). **Glyph: `SquareTerminal`** — a terminal in a frame, which
  is what one of these agents is to its owner; unused anywhere in the app. Not `Bot` (the run area's agent mark),
  not `Server` (infrastructure, not _your agent_).
- **⚠️ Registered as well as rendered.** `lib/settings/projectNavAccess.ts` gets a `/my-agents` row
  whose requirement is **`instance:use`** (§8). `canOfferNavDestination` answers false for an href it
  does not carry and for a key the reader lacks, so a `viewer` sees the rail **without** the row.
- **A reader without the key who types `/my-agents`** gets the page's `notFound()` — the way every room
  refuses a reader it does not admit. No refusal copy is drawn for it, because none is shown.

### Panel 1 — NO AGENTS YET

The shipped Runs empty-state card: muted glyph (`SquareTerminal`, `--el-text-secondary`), serif title
**"No agents yet"**, one paragraph, and the one action.

> Each is your own coding agent — Claude Code, Codex and others — on its own machine in Motir's cloud,
> with this project's code and signed in with your own account. Motir charges only its machine time, and it
> sleeps when you stop using it.

**It must not read as an error.** The **New agent** button is also in the page header, top right,
beside the title — the header's action slot, where `/runs` puts its Mine / Project control.

Page header copy: title **My agents**, subline **"Your own agents, on your own sign-in, in Motir's
cloud — {project name}"**.

### Panel 2 — THE CREATE DIALOG

A `Modal` with three fields and a price line; footer **Cancel** / **Create agent**.

| Field        | Control                         | Copy                                                                        |
| ------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Name         | `Input`                         | hint: _"Only you see it. Letters, numbers and dashes."_                     |
| Project      | `Input`, read-only (fixed)      | hint: _"Its connected repositories are cloned into the agent's home."_ (§1) |
| Coding agent | radio list, one row per profile | each row: the coding agent's name + one line on the sign-in it will ask for |

**The coding-agent list is exactly the six `offered` profiles of §9, in this order:**

| Profile     | Row line                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| Claude Code | _Asks you to sign in with your Claude account, or an Anthropic API key, in its own terminal._ |
| Codex       | _Asks you to sign in with your ChatGPT account, or an OpenAI API key._                        |
| OpenCode    | _Uses your own model provider key. For Claude models, your Anthropic API key._                |
| Kimi Code   | _Asks you to sign in with your Kimi account._                                                 |
| Aider       | _Uses your own model provider key. For Claude models, your Anthropic API key._                |
| Goose       | _Uses your own model provider key. For Claude models, your Anthropic API key._                |

- **Antigravity and Cursor are NOT listed at all** (§9: forbidden / terms silent). A disabled row would
  invite the question the decision already answered; the list is the offered set, nothing more.
- The three open-source CLIs say a Claude model means the user's **own Anthropic API key** — §9's note
  that Anthropic does not permit a third-party application to offer Claude.ai subscription login.
- Under the picker: _"The coding agent's model usage is billed to you by its vendor, not by Motir. Motir never
  sees your sign-in."_ (§9's four conditions, in one sentence a user can read.)
- **The price line** (`--el-tint-sky`, info glyph): **"1 credit per minute** while it runs. It
  hibernates after 30 minutes without use and costs nothing while hibernated." (§2, §5).
- **Create's pending state** is the button's own (`Button` loading); a refusal lands **in the dialog,
  above its footer**, as a panel-5 refusal box, and the dialog stays open with the input kept.

### Panel 3 — THE LIST

The shipped `TableShell` grammar (the Runs index's): a rounded bordered wrapper, secondary ink in the
head, body ink in the cells. **Only the viewer's own live agents** (§4, §8 — no key opens someone
else's), newest first, **paginated with a total** (_"3 agents · Page 1 of 1"_). A developer may hold
several agents on one project.

| Column                  | Content                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Name                    | the agent's name, bold; under it, the state's line of words (panel 4) when it has one   |
| Coding agent            | the profile's display name                                                              |
| Project                 | the project name                                                                        |
| State                   | the state pill (panel 4)                                                                |
| Machine time this month | the sum of the running intervals overlapping the current calendar month (UTC), `1h 12m` |
| Credits                 | the credits of those intervals                                                          |
| (actions)               | the row menu (`…`), `aria-label` _"Actions for {name}"_                                 |

**Machine time this month**: an open interval counts up to now; a hibernated agent's figure stops
rising, which is what the story's verification step 4 checks.

**The row menu** — a `DropdownMenu` offering exactly the moves §4 allows from the row's state:

| Item          | Enabled from                      | Glyph                                           |
| ------------- | --------------------------------- | ----------------------------------------------- |
| **Wake**      | `hibernated`, `failed`            | `Power`                                         |
| **Hibernate** | `running`                         | `Moon`                                          |
| **Delete…**   | `running`, `hibernated`, `failed` | `Trash2`, danger ink (`--el-danger-on-surface`) |

A move the state does not allow is **disabled, not hidden**, so the menu keeps one shape. In
`starting`, `hibernating`, `waking` and `deleting` every item is disabled.

### Panel 4 — EVERY STATE

All seven states of §4, each a row. **The tones reuse `design/runs/design-notes.md`'s tone vocabulary**
(tinted background, `--el-text-strong` label, the hue in a 7px dot) — no new hue:

| State         | Pill label  | Background       | Dot                       | Line under the name                                                        |
| ------------- | ----------- | ---------------- | ------------------------- | -------------------------------------------------------------------------- |
| `starting`    | Starting    | `--el-tint-sky`  | `--el-status-in-progress` | _Booting — cloning {n} repositories into the home_                         |
| `running`     | Running     | `--el-tint-mint` | `--el-status-done`        | —                                                                          |
| `hibernating` | Hibernating | `--el-muted`     | `--el-status-todo`        | _Stopping the machine — your home stays_                                   |
| `hibernated`  | Hibernated  | `--el-muted`     | `--el-status-cancelled`   | —                                                                          |
| `waking`      | Waking      | `--el-tint-sky`  | `--el-status-in-progress` | _Starting a fresh machine on your home_                                    |
| `failed`      | Failed      | `--el-tint-rose` | `--el-danger`             | the failure reason in words, then the way out, in `--el-danger-on-surface` |
| `deleting`    | Deleting    | `--el-muted`     | `--el-status-todo`        | _Destroying the machine and its home_                                      |

- **Progress is never a spinner-only row**: every state in motion carries its line of words.
- **A hibernation the person did not ask for says why** (revision 3). Motir stops a running agent for
  three reasons of its own; the `hibernated` row then carries the most recent interval's end reason as
  its secondary line (`--el-text-secondary`). A hibernate the person pressed carries no line.

  | End reason | Line under the name                                                         |
  | ---------- | --------------------------------------------------------------------------- |
  | `credits`  | _Stopped: your organization ran out of credits. Add credits, then wake it._ |
  | `idle`     | _Hibernated after 30 minutes without use_                                   |
  | `backstop` | _Stopped after 12 hours running. Wake it to carry on._                      |

  _Ran out of credits_ can happen mid-session now: AMENDMENT 2 charges a running machine every
  30-minute pass and hibernates it when the organization's balance reaches zero.

- **Failed** carries the record's `failureReason` and _"Wake to try again, or delete it."_ — the two
  moves §4 allows from `failed`.
- **Every wake is a cold boot** (§1, §2): the waking line says _a fresh machine on your home_, because
  anything installed outside the home is reset.
- The page keeps a row in motion fresh until it settles — a polling refetch while any row is in
  `starting`, `hibernating`, `waking` or `deleting` — per the page-state-after-mutation contract; a
  reader never reloads by hand.

### Panel 5 — EVERY REFUSAL

A refusal box: `--el-tint-rose`, alert glyph, `--el-text-strong` ink, `role="alert"`. On **create** it
sits in the dialog above the footer; on **Wake** it sits above the list. Create and wake are refused
**before any machine boots** (§5, §6), and each names the rule:

| Refusal                  | Copy                                                                                                                                                | Decided by                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Not enough credits       | _Your organization's credits can't start a machine right now. **Add credits** to create or wake an agent._ (links to the organization's usage page) | §5                                          |
| Your limit               | _You already have 10 agents. Delete one to create another._                                                                                         | §6                                          |
| Motir is busy            | _Motir is running as many machines as it can right now. Try again in a few minutes._ — **warning ground** (`--el-tint-peach`): a wait, not a fault  | AMENDMENT 2 (the agent pool's safety valve) |
| Coding agent not offered | _{Agent} isn't offered: its terms don't yet allow a platform to host it. Choose another coding agent._                                              | §9                                          |
| Name taken               | _You already have an agent called {name} on this project._                                                                                          | §4 (live-name uniqueness)                   |

The count is the cap's configured value, rendered from the refusal, never hard-coded in copy. **There is no
organization limit** (revision 3, AMENDMENT 2): credits decide how many agents an organization runs.
**No permission is not a message**: no rail row, no create control, and the route refuses (panel 0).

### Panel 6 — DELETE

An `AlertDialog`: title **"Delete {name}?"**.

> This destroys the agent's machine **and its home**. You lose:
>
> - its coding agent's sign-in — you would sign in again on a new agent;
> - every file in the home, including the cloned repositories;
> - any work you have not committed and pushed.
>
> This can't be undone. Machine time already used is still charged.

Footer: **Keep it** (the default, focused) and **Delete agent** (danger `Button`: `--el-danger` fill,
`--el-danger-text` ink, `Trash2`). §1 and §4: the machine and the volume go, the interval closes and is
charged.

### Panel 7 — THE WAIT, and THE FAILURE TO LOAD

The Runs index's two faces: skeleton rows in an **in-page `<Suspense>` after the page's own gate —
never a `loading.tsx`** (`design/shell/design-notes.md` § _the navigation-pending grammar_); and a
failure box, _"We couldn't load your agents. Refresh to try again — nothing about them has
changed."_, which never borrows the empty state's words.

### Panel 8 — THE NARROW WIDTH

Below the table's width each agent is a card: **name + menu**, **coding agent · project + state pill**,
**machine time this month + credits**, then the state's line of words. The header stacks; **New
agent** stays the first control.

---

## Primitives and tokens

| Primitive                           | Used for                                         |
| ----------------------------------- | ------------------------------------------------ |
| the shipped `Sidebar` row           | the rail entry                                   |
| the Runs page header                | title, subline, the action slot                  |
| `Button` (primary / ghost / danger) | New agent, Create agent, Cancel, Keep it, Delete |
| `TableShell` / `Th` / `Td`          | the list                                         |
| `Pill` with the runs tone set       | every state chip                                 |
| `DropdownMenu`                      | the row menu                                     |
| `Modal` · `AlertDialog`             | the create dialog · the delete confirmation      |
| `Input` · `FormField`               | name, the fixed project                          |
| `RadioGroup`                        | the coding-agent picker                          |
| the Runs empty-state card           | panel 1                                          |

| Element                                                     | Shape tokens                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| dialog panel                                                | `--radius-modal` · `--shadow-modal` · `--spacing-card-padding` |
| inputs                                                      | `--radius-input` · `--height-input` · `--spacing-input-x/y`    |
| table cells, radio rows, menu rows, refusal and price boxes | `--spacing-control-x/y` · `--radius-control` / `--radius-card` |
| state pills                                                 | `--radius-badge` · `--spacing-chip-x/y`                        |
| menu                                                        | `--radius-card` · `--shadow-elevated`                          |
| buttons                                                     | `--radius-btn` · `--height-btn-sm` · `--spacing-btn-x-sm`      |

**Ink**: body `--el-text`; every secondary line `--el-text-secondary` (AA on every surface in both
themes); danger text on a surface `--el-danger-on-surface`, never `--el-danger-text` off a danger fill.
`--el-text-muted` and `--el-text-faint` are used nowhere. The selected radio row is `--el-tint-lavender`
with `--el-text` ink; the price line `--el-tint-sky` with `--el-text-strong`.

---

## GIVES / TAKES

- **GIVES MOTIR-6874** (the page): the rail row and its registration, the page header, the empty state,
  the create dialog and its six-profile picker, the list columns and pagination, the row menu and its
  per-state enablement, the seven state rows and their lines, the six refusals and where each lands, the
  delete confirmation, the wait and failure faces, the narrow cards, and every string above (with `zh`
  twins in `messages/`).
- **TAKES from MOTIR-6866** (the decision): §4's states and transitions, §5's credit pre-flight and
  per-interval charge, §6's caps, §8's `instance:use`, §9's offered set and its sign-in notes.
- **TAKES from MOTIR-6872** (the service): the typed refusals the panel-5 copy renders, and the list
  read with each agent's machine time and credits this month.

---

## The agent panel — an agent opened beside the list (delta, MOTIR-6937)

**Story MOTIR-6861 · design MOTIR-6937.** Gates **MOTIR-6941** (the panel). Mock:
**`design/my-agents/my-agents--panel.mock.html`**, a DELTA.

**What it amends.** This section amends § _What this area does NOT draw_ (its first bullet: _"This
page leaves the right half empty, and a row click is inert until that story wires it"_) and § _Panel
3 — THE LIST_ above, drawn in `design/my-agents/my-agents.mock.html` — **MOTIR-6868's published
result (revision 3, commit `f953bda2b`), the list this panel composes**. That mock is not edited; it
stays the record of the list page. The delta draws only what opening an agent adds.

**Where every state comes from.** The seven lifecycle values are `docs/decisions/agent-instances.md`
§4. Every terminal state, refusal, reconnect rule and sign-in state is **`docs/decisions/agent-terminal.md`
(MOTIR-6936)**: Q3 (the ticket and its refusals `not_owner` / `not_running` / `no_terminal_server`,
the relay close codes 4401 / 4403 / 4409 / 4410 / 4502), Q4 (the control frames, including the
`session_limit` and `taken_over` errors), Q5 (the same shell on reconnect, the 256 KiB replay, four
sessions), Q6 (opening a hibernated agent wakes it with no second click), Q7 (the three sign-in states,
and none before the terminal connects) and Q8 (the image-too-old state). This design adds no state the
decision does not produce; the copy is this card's.

**Composed, not redrawn.** The mock's four `<style>` blocks are `my-agents.mock.html`'s own, verbatim
(themselves `design/runs/runs-index.mock.html`'s). The table rows, the narrow cards (base panel 8),
the state pills (`RunTonePill` through `AGENT_STATE_TONE`), the refusal box (base panel 5) and the
delete confirmation (base panel 6) are that asset's markup, copied, and were checked against the
shipped `app/(authed)/my-agents/_components/` (`MyAgentsRoom.tsx`, `AgentRowMenu.tsx`,
`agentRefusal.tsx`, `DeleteAgentDialog.tsx`). One correction to the base notes, from what ships: the
list is **not paginated** (`MY_AGENTS_LIST_LIMIT` reads all of a person's agents), so the delta draws
no pager.

| Panel | What it settles                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------- |
| 1     | the access path: the row as the door, the two-column mode, the address, closing and the list after |
| 2     | the header: name, state pill, coding agent · project, Hibernate, Delete and its confirmation       |
| 3     | sign-in status: three states, the command per coding agent, the turn without a reload              |
| 4     | the seven lifecycle values as the panel shows them                                                 |
| 5     | the terminal tab: connecting, live, reconnecting, lost, exited; size, scroll and resize            |
| 6     | the refusals, in words                                                                             |
| 7     | the narrow width                                                                                   |

### Panel 1 — THE ACCESS PATH

- **The door is the row.** The whole list row (`tr` in the table; the card in the narrow form) is the
  click target, and **Enter** on a focused row opens it. The row menu (`…`) keeps its own click and
  never opens the panel. The base asset already marks each row `is-link`; this story wires it.
- **The address** becomes `/my-agents?agent=<id>` by a `replace` (no new history entry), so a reload,
  a bookmark or a shared tab reopens the same agent, and Back leaves the page rather than walking back
  through every agent opened.
- **Two columns.** The page header (title, subline, **New agent**) stays across the top. Under it, a
  **340px list column** and the **panel**, which takes the rest. The list column is below the table's
  width, so its rows take the page's own **narrow card form** (base panel 8, unchanged). A
  **container query on the list column**, not the viewport breakpoint the page uses today, is what
  switches it. The list stays usable: its menus work, and clicking another card switches the panel and
  the address to that agent.
- **The selected row** carries `aria-current="true"`, the `--el-tint-lavender` ground and an
  `--el-accent` border, with `--el-text` / `--el-text-secondary` ink on it (the create dialog's
  selected radio row, the area's "this one" mark).
- **Closing.** The header's **×**, or **Esc** from inside the panel (but not while the terminal has
  focus, since Esc belongs to the shell there), drops `?agent=` and returns the list to its table.
  Focus returns to the row that was open. **Closing ends nothing.** The shell keeps running and
  re-attaches if the agent is reopened in the same tab. The agent hibernates on the ordinary idle rule
  once the terminal stops counting as activity (Q6).

### Panel 2 — THE HEADER

| Element          | Content                                                                              | Tokens                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| name             | the agent's name                                                                     | serif 1.125rem, `--el-text`                                                                                  |
| state pill       | the list's pill for the same state                                                   | `RunTonePill` + `AGENT_STATE_TONE` (base panel 4)                                                            |
| meta line        | _{coding agent} · {project}_                                                         | 0.8125rem, `--el-text-secondary`                                                                             |
| **Hibernate**    | shown **only when `running`** (`Moon`)                                               | `Button` secondary, `--height-btn-sm`, `--radius-btn`                                                        |
| **Delete…**      | always shown; disabled in `starting`, `hibernating`, `waking`, `deleting` (`Trash2`) | `Button` secondary, `--el-danger-on-surface` ink; disabled: `--el-surface` ground, `--el-text-secondary` ink |
| close            | **×**, `aria-label` _"Close {name}"_                                                 | icon button, `--el-text-secondary`                                                                           |
| sign-in status   | panel 3                                                                              |                                                                                                              |
| the sign-in line | panel 3                                                                              |                                                                                                              |

- Machine time and credits stay on the list, where they are compared across agents.
- **Delete…** opens the page's own `DeleteAgentDialog` (base panel 6), unchanged. On success the panel
  closes (panel 4, _deleting_).
- The header sits on `--el-card` with `--spacing-card-padding`, and a `--el-border-soft` rule under it.

### Panel 3 — SIGN-IN STATUS

One line under the meta line. It only shows what the terminal server pushed (`signin` frame, Q7).
**Before the terminal connects (starting, waking, connecting) there is no line at all**, so there is no
guess.

| State                    | Glyph (aria-hidden)                 | Copy                                                                                                                                              |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| signed in                | `CircleCheck`, `--el-success`       | _Signed in to {coding agent}_                                                                                                                     |
| not signed in (claude)   | `CircleAlert`, `--el-warning`       | _Not signed in — run `claude`, then `/login`, in the terminal to sign in_                                                                         |
| not signed in (codex)    | `CircleAlert`, `--el-warning`       | _Not signed in — run `codex login --device-auth` in the terminal to sign in_                                                                      |
| not signed in (opencode) | `CircleAlert`, `--el-warning`       | _Not signed in — run `opencode auth login` in the terminal to sign in_                                                                            |
| can't be checked (kimi)  | `CircleHelp`, `--el-text-secondary` | _Sign-in status can't be checked for Kimi Code_ + _To sign in, run `kimi` in the terminal and follow its sign-in._                                |
| can't be checked (aider) | `CircleHelp`, `--el-text-secondary` | _Sign-in status can't be checked for Aider_ + _Aider uses your model provider's key: add `ANTHROPIC_API_KEY=…` (or your provider's) to `~/.env`._ |
| can't be checked (goose) | `CircleHelp`, `--el-text-secondary` | _Sign-in status can't be checked for Goose_ + _To add your model provider's key, run `goose configure` in the terminal._                          |

- **Never a tick for _can't be checked_.** The neutral question glyph is the whole point of the third
  state.
- Commands render as inline code: `--el-code-bg` / `--el-code-text`, `--radius-badge`, mono 0.75rem.
- **The sentence about the sign-in (§9), once, under the status in every state:** _"Your sign-in
  belongs to {coding agent} and stays in this agent's home. Motir never sees it."_ It uses a `Lock`
  glyph and 0.75rem `--el-text-secondary`. It stays even when there is no status line yet.
- **The turn without a reload.** The vendor's own flow runs in the terminal (Q9: Motir pre-fills
  nothing, and the URL opens in the reader's own browser). The server re-checks every 5 seconds while
  attached and pushes `signin` on the change. The line then swaps to _Signed in_ and lands once on
  `--el-tint-mint` with `--el-text-strong` ink, then settles to the plain line after a moment. The
  swap is announced politely (`aria-live="polite"` on the status line).

### Panel 4 — EVERY LIFECYCLE VALUE

The pill is always the list's. The terminal area says what is happening in words, reusing the list's
own `myAgents.progress.*` strings so the row and the panel never disagree. While the agent is in
motion the panel re-reads it (the list's 2-second poll).

| State         | Header                 | Terminal area                                                                                                                                |
| ------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`    | Delete disabled        | _Booting — cloning the project's repositories into the home_ · _The terminal opens here as soon as the agent is up._                         |
| `running`     | Hibernate · Delete     | the terminal (panel 5)                                                                                                                       |
| `hibernating` | Delete disabled        | _Stopping the machine — your home stays_ · _The terminal closes with it. Your files and your sign-in are kept._                              |
| `hibernated`  | Delete                 | _{name} is hibernated_ · the list's `stop.*` line when Motir stopped it, then _Your files and your sign-in are kept._ · **Wake**             |
| `waking`      | Delete disabled        | _Starting a fresh machine on your home_ · _The terminal connects by itself when it's up — nothing to click._                                 |
| `failed`      | Delete                 | the `failureReason` in `--el-danger-on-surface` · _Wake to try again, or delete it._ · **Wake**                                              |
| `deleting`    | Delete disabled; faded | _Destroying the machine and its home_. The panel then **closes**, `?agent=` drops, and the list keeps the row in _Deleting_ until it is gone |

- **Opening a `hibernated` agent wakes it** (Q6): the panel calls the existing Wake route, shows
  `waking`, and on `running` asks for the ticket and connects, with **no second click**. Every wake is a
  cold boot, so the shell is fresh, in `~/workspace`, and the home and sign-in are kept. The
  `hibernated` resting face appears only when the agent stops **while the panel is open**.
- **Wake** in the panel is the primary `Button` (`--el-accent` fill, `--el-accent-text`, `Power`).

### Panel 5 — THE TERMINAL TAB

- **The tab strip** is the shipped `WorkbenchTabs` track: `--el-tabnav-track` inside an `--el-border`
  rule, `--radius-btn`, and one active tab, **Terminal** (`SquareTerminal` glyph in
  `--el-tabnav-active`, label `--el-text-strong` on `--el-page-bg`, `--shadow-subtle`). It holds one tab
  today, so the chat story (MOTIR-6863) adds **Chat** beside it, and nothing marks the empty place.
- **The connection word** sits at the strip's right end: 0.75rem `--el-text-secondary` with a 7px dot.

| State        | Word            | Dot                       | Strip above the terminal                                                                                                                  | Terminal                               |
| ------------ | --------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| connecting   | _Connecting…_   | `--el-status-in-progress` | —                                                                                                                                         | _Connecting to {name}'s terminal…_     |
| live         | _Live_          | `--el-status-done`        | —                                                                                                                                         | the shell, prompt in `~/workspace`     |
| reconnecting | _Reconnecting…_ | `--el-status-in-progress` | `--el-tint-sky`: _Connection dropped — reconnecting to the same shell. Your build keeps running._                                         | the last screen, dimmed; typing paused |
| lost         | _Disconnected_  | `--el-danger`             | `--el-tint-rose`, `role="alert"`: _Couldn't reconnect. Your shell is still running on the agent — reconnect to pick it up._ **Reconnect** | the last screen, dimmed                |
| exited       | _Ended_         | `--el-status-cancelled`   | `--el-muted`: _The shell exited. Your files are all still in the home._ **Start a new shell**                                             | the final lines (`exit` / `logout`)    |

- **Reconnecting is the same shell** (Q5). The tab keeps its session in `sessionStorage`. A drop or a
  reload re-attaches, and the agent replays up to 256 KiB so the screen redraws before live output.
- **The reconnect window** is the panel's retry budget, **about a minute** of backing off. The exact
  number is MOTIR-6941's to set. After it, the state is _lost_. **Reconnect** mints a new ticket. If
  the agent hibernated in the meantime, Reconnect wakes it (panel 4) and opens a fresh shell.
- **Size.** The terminal fills the panel below the tab strip, down to the bottom of the viewport, so
  the page never scrolls to reach the terminal's last line. It is monospace 12px on `--el-code-bg`
  with `--el-code-text`, so it follows the theme.
- **Scroll.** It scrolls inside itself, with its own scrollback. It stays pinned to the latest line
  unless the reader scrolls up. New output then does not yank them down, and **Jump to latest**
  appears bottom-right.
- **Resize.** A window or panel size change refits the terminal to whole cells, sends `resize`
  (Q4), and shows _cols × rows_ for a moment (a `--radius-badge` tag on `--el-card`).

### Panel 6 — THE REFUSALS

| Case                                                            | Face                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wake refused: credits                                           | header _Hibernated_. In the terminal area: base panel 5's credits box and copy, unchanged, then **Wake**                                                                                                                                                                                                                                                                      |
| Wake refused: Motir is busy (the pool's valve)                  | same place, the peach _wait_ box and copy, unchanged, then **Wake**                                                                                                                                                                                                                                                                                                           |
| Not your agent, or not found (`not_owner` 403, 404, close 4403) | a panel titled **This agent isn't available**: _It may have been deleted, or it isn't one of yours. Only the person who created an agent can open it._ **← Back to My agents**. No name, coding agent, state or terminal. The list stays the reader's own, with nothing selected                                                                                              |
| The image has no terminal (`no_terminal_server`, close 4410)    | header unchanged (the agent is running and usable). Terminal area: **This agent can't open a terminal yet** · _It was made from an older image, from before the terminal existed. Moving an agent to the newer image — keeping its home and sign-in — is on its way. Until then, a new agent has the terminal._ No date and no button: MOTIR-6862's update does not exist yet |
| Another tab took the shell (`taken_over`)                       | `--el-muted` strip: _This shell is open in another tab now. One shell answers one tab at a time._ **Use it here**                                                                                                                                                                                                                                                             |
| Four sessions attached (`session_limit`)                        | _{name} already has 4 terminals open in other tabs. Close one there, then try again._ **Try again**                                                                                                                                                                                                                                                                           |
| The machine did not answer (4502)                               | after the reconnect loop, the _lost_ face with _The agent's machine isn't answering. Your files are safe in its home._ **Reconnect**                                                                                                                                                                                                                                          |
| Stale ticket (4401)                                             | **no words**: mint a new ticket and retry once, silently; a second failure is _lost_                                                                                                                                                                                                                                                                                          |
| Not running (`not_running` 409, close 4409)                     | **no words**: the panel's cue to wake the agent (panel 4)                                                                                                                                                                                                                                                                                                                     |

- The not-yours face is one answer for 403 and 404 **on purpose**, so it never confirms that another
  person's agent exists.

### Panel 7 — THE NARROW WIDTH

- **Below 1024px of content** there is no room for two columns, so the open agent takes the whole
  view. The address is the same.
- **← My agents** (the shipped crumb, `--el-link`) sits above the name. It and the header's **×** both
  return to the list, whose cards are base panel 8.
- The actions wrap under the name, and the sign-in line wraps.
- The terminal refits to the width (about 44 columns on a 390px phone) and behaves the same.

### Tokens and primitives this delta adds

| Element            | Tokens                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| panel              | `--el-card`, `--el-border`, `--radius-card`, `--spacing-card-padding`                                   |
| selected list card | `--el-tint-lavender`, `--el-accent` border                                                              |
| terminal           | `--el-code-bg`, `--el-code-text`, `--font-mono`; scroll thumb `--el-border-strong`, `--radius-badge`    |
| strips             | `--el-tint-sky` (reconnecting) · `--el-tint-rose` (lost) · `--el-muted` (ended), `--el-text-strong` ink |
| buttons            | the base asset's `Button` shape (`--height-btn-sm`, `--radius-btn`, `--spacing-btn-x-sm`)               |

**Ink:** body `--el-text`, secondary lines `--el-text-secondary`. `--el-text-muted` and
`--el-text-faint` are used nowhere, including the disabled Delete, which is secondary ink on
`--el-surface`.

### Vocabulary

On-screen copy says **agent** and **coding agent** and never "instance" (revision 2). The routes and
the decision record keep their engineering names.

### GIVES / TAKES

- **GIVES MOTIR-6941** (the panel): the row-as-door and `?agent=` address, the two-column mode and its
  container switch, the selected mark, close and focus return, the header and its per-state actions,
  the three sign-in states with every coding agent's command and the §9 sentence, the seven lifecycle
  faces, the tab strip, the five terminal states with scroll and resize, every refusal's words, the
  narrow full view, and every string above (with `zh` twins in `messages/`).
- **TAKES from MOTIR-6936** (the decision): every state above. **TAKES from MOTIR-6868** (this area's
  list): the rows, cards, pills, refusal box and delete confirmation, unchanged.
- **Leaves to others:** the Chat tab (MOTIR-6863), _Run in my agent_ (MOTIR-6864), and the image update
  and its _Update available_ marker (MOTIR-6862).

## The agent's live run — the panel while a work item runs in the agent (delta, MOTIR-7022)

**Story MOTIR-6864 · design MOTIR-7022.** Gates **MOTIR-7029**. Mock:
**`design/my-agents/my-agents--run.mock.html`**, a DELTA.

**What it amends.** § _The agent panel — an agent opened beside the list (delta, MOTIR-6937)_ above,
drawn in **`design/my-agents/my-agents--panel.mock.html`** — MOTIR-6937's published result (evidence
`cmun5qu1f005qhwoiq14livtw`, commit `5bf46803`), whose _GIVES / TAKES_ leaves _"Run in my agent
(MOTIR-6864)"_ to this card. That mock is not edited. The delta copies its five `<style>` blocks
verbatim and adds one; every lifecycle, sign-in and terminal state stays that section's.

**The behaviour** is `docs/decisions/agent-instance-run.md` §1 (the run session: at most one, listed
to every connection on attach, watch-only, never reaped), §5 (the run read by agent) and §6
(Hibernate and Delete refused during a run; every end). The work item side — the control, the
picker, the refusals, the run section and modal — and the full allocation and flagged gaps are
**`design/runs/design-notes.md` § _Run in my agent_**, drawn in `design/runs/run-section--agent.mock.html`.

| Panel | What it settles                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------- |
| 1     | the run line in the header; the run's session offered beside the developer's shell; watching it |
| 2     | Hibernate and Delete off during the run, and the refusal if pressed from elsewhere              |
| 3     | the run just ended — the header after, and the watched session's end                            |
| 4     | the narrow width                                                                                |

### Panel 1 — THE LIVE RUN

- **The run line**, one line under the meta line (`--el-tint-sky`, `--radius-control`,
  `--spacing-control-x/y`, `--el-text-strong` ink, `aria-live="polite"`): the running pill reading
  **Running a work item** · the work item's key (mono, linked) and title · **Open run** at the right
  (`/runs?run=<id>`). Read from the run record by agent and refreshed with the panel's poll — nothing
  comes through the terminal.
- **The session switch** at the head of the Terminal tab (a `sessBar` row under the tab strip,
  `--el-border-soft` rule): the shipped `Segmented` — track `--el-tabnav-track` in an `--el-border`
  rule, `--radius-btn`, segments `--height-control`, active on `--el-page-bg` with `--el-text-strong`
  and `--shadow-subtle`, inactive `--el-text-secondary`. **Your shell** (`SquareTerminal`) | **Run
  {key}** (a 7px `--el-status-in-progress` dot and an `Eye` glyph). At the right, _The run's session is
  watch-only_ (0.75rem `--el-text-secondary`). The tab strip stays the strip of VIEWS (Terminal, and
  Chat with MOTIR-6863); both sessions are terminals, so the choice sits inside the Terminal view.
- **Opening the panel lands on Your shell.** The switch appears as soon as the terminal is live
  (the server lists the run session on attach) and needs no second connection.
- **Watching:** the run's screen and replay, **no caret**, input dropped by the server, resize applied.
  A sky strip (`termStrip`, unchanged): _Watching the run of {key} — read-only, so typing goes nowhere.
  To stop it, use Cancel run on **the work item**._ Cancel is not offered in the panel: the Run section
  is the one place that cancels.

### Panel 2 — HIBERNATE AND DELETE DURING A RUN

- Both show their disabled face (`.btnGhost.isOff`: `--el-surface`, `--el-text-secondary`,
  `aria-disabled`) with one line under the run line: _Hibernate and Delete are off while a run is
  working in this agent — cancel the run first._ (0.75rem `--el-text-secondary`).
- Pressed from somewhere that did not know (the list's row menu, a stale tab), the server's
  `agent_instance_run_active` is shown in the page's refusal box (the rose box, unchanged): _{name} is
  running **{key}**. Cancel that run on the work item first, then hibernate it._ / _… then delete it._

### Panel 3 — THE RUN JUST ENDED

- The run line turns `--el-muted` and reads the LAST run: the end pill (tone table), **Last run**, the
  key and title, and on a failure the recorded reason in mono instead of the title, then **Open run**.
  It stays until the agent's next run replaces it. Hibernate and Delete come back.
- The run's session exits with the run, so its segment leaves the switch — and with one session left
  the switch goes, as before this story.
- If it was being watched: its last screen stays, dimmed (`.term.isPaused`), under the ended strip
  (`termStrip isEnded`): _The run's session has ended — the run succeeded, and its pull request is on
  the work item._ / _— the run failed. Its work so far is on the run's branch._ · **Back to your shell**.

### Panel 4 — THE NARROW WIDTH

The base panel 7 full view: the run line wraps (**Open run** on its own line), the disabled actions
and their reason wrap under the name, the switch fills the width (the `Segmented` `fill` variant) and
drops its hint — the sky strip says it.

### Strings — `myAgents.panel.run.*` (MOTIR-7029; `zh` twins with the build)

| Key                                                                         | String                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live` · `last` · `open`                                                    | Running a work item · Last run · Open run                                                                                                                                          |
| `offWhy`                                                                    | Hibernate and Delete are off while a run is working in this agent — cancel the run first.                                                                                          |
| `refusedHibernate` · `refusedDelete`                                        | {name} is running <link>{key}</link>. Cancel that run on the work item first, then hibernate it. · … then delete it.                                                               |
| `sessions.label` · `sessions.shell` · `sessions.run` · `sessions.watchOnly` | Terminal sessions · Your shell · Run {key} · The run's session is watch-only                                                                                                       |
| `strip.watching`                                                            | Watching the run of {key} — read-only, so typing goes nowhere. To stop it, use Cancel run on <link>the work item</link>.                                                           |
| `strip.endedSucceeded` · `strip.endedFailed`                                | The run's session has ended — the run succeeded, and its pull request is on the work item. · The run's session has ended — the run failed. Its work so far is on the run's branch. |
| `backToShell`                                                               | Back to your shell                                                                                                                                                                 |

End pills reuse `runs.runStatus.*`; the recorded reason is the record's string, verbatim.

### GIVES / TAKES

- **GIVES MOTIR-7029:** the run line (live and last), the session switch and the watch-only face, the
  watch strip, the disabled Hibernate / Delete with their reason and the refusal box, the ended
  session face, the narrow view, and the strings above.
- **TAKES from MOTIR-7025:** the run session listed on attach, tagged with its run id (the panel matches
  it to the run line's run). **From MOTIR-7027:** the Hibernate / Delete refusal carrying the run's id and
  key. **From MOTIR-7023 / MOTIR-7026:** the agent's running run (and, for _Last run_, its latest run —
  flagged in the runs notes: no sibling builds that read yet).

**Revision 2 (MOTIR-7022, after review).** On the work item the door is now **Send to my agent**,
beside **Run** (Motir works it with the model you pick), and a busy agent's picker row names the work
item it is working on — `design/runs/design-notes.md` § _Revision 2_. This panel's delta
(`my-agents--run.mock.html`) is unchanged: its run line already says _Running a work item_ and names
the key, and it says "hosted" nowhere.

## Updating an agent to a newer image (delta, MOTIR-6951)

**Design system — read before drawing.** `package.json` depends on `@motir/design-system`
(`workspace:*`) and `app/globals.css` line 13 imports `@motir/design-system/theme.css`, so the
project is **on Motir Design** (branch (a)). This delta reuses the area's own markup and tokens, at
the axes the panel mock was drawn at. No part was missing from the package.

**What it amends.** `my-agents--update.mock.html` is a delta on `my-agents--panel.mock.html`
(MOTIR-6937, approved version `cmun5qu1f005qhwoiq14livtw`), which is itself a delta on
`my-agents.mock.html` (MOTIR-6868). Neither is edited.

- **Composed, not redrawn:**
  - the panel mock's five style blocks and icon symbols, verbatim;
  - the list table and narrow cards;
  - the agent panel: its header, tab row, terminal, the refusal box (rose for a stop, peach for a
    wait), the `.reason` line, and the dialog shape of the Delete confirmation;
  - the narrow-width layout (MOTIR-6937 panel 7);
  - the image-too-old face (panel 6).
- **Its own:** one small style block, with the version line, the update marker, and the header
  wrap that lets three actions fit the half-width panel. Plus two icons (`i-arrow-up-circle`,
  `i-refresh`). Only `--el-*` and shape tokens are used, and no colour is invented.

**Every state is decided in `docs/decisions/agent-image-update.md` (MOTIR-6948).** The update
operation that produces each state is [MOTIR-6952](motir:cmun6el6a00g4hwoibmcyr4uv).

| #   | state                                                                                                       | where         | decision                    | mock panel |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- | ---------- |
| 1   | Up to date: version only, no marker, no Update                                                              | row, header   | Q1                          | 1A, 1C     |
| 2   | Update available → version: marker, Update enabled                                                          | row, header   | Q1                          | 1A, 1B     |
| 3   | Could not check for updates: a grey chip, never "up to date"                                                | row, header   | Q1                          | 1A, 1D     |
| 4   | Confirm: both versions, what is kept, restart vs next wake                                                  | dialog        | Q2, Q5                      | 3          |
| 5   | Updating: busy tone, terminal Reconnecting…, all actions disabled                                           | row, header   | Q6                          | 2, 4       |
| 6   | Updated, hibernated: "version on next wake"                                                                 | row, header   | Q5                          | 2, 5       |
| 7   | Refused: run active (names and links the run), already newest, transitional state, could not check (a wait) | panel         | Q8                          | 6          |
| 8   | Failed and rolled back: previous version, the reason in words, Update still offered                         | row, header   | Q4                          | 2, 7       |
| 9   | Image too old: the call to action becomes Update to version                                                 | terminal area | Q3 (`agent-terminal.md` Q8) | 8          |
| 10  | Narrow width: the marker under the meta line, Update first among the wrapped actions                        | panel, cards  | —                           | 9          |

**The access path.**

- **On the row:** the version sits in the **Coding agent** cell (mono, `--el-text-secondary`), with
  the marker beside it. The whole row is still the door to the panel (MOTIR-6937 panel 1).
- **In the panel header:** **Update** is the FIRST action, before Hibernate and Delete. It shows
  only while an update is available, and it opens the confirmation.
- **The marker** is `--el-tint-sky` with `--el-text-strong` text (AA on the tint). The
  next-wake marker is `--el-tint-lavender`. The could-not-check chip is `--el-surface-soft` with
  `--el-text-secondary`.
- **Updating** uses the busy tone Waking already uses (`t-running`).

**Copy — en and zh.** `{name}` is the agent's name, `{from}` and `{to}` the two versions, `{key}`
the run's work item.

| key (proposed `myAgents.update.*`) | en                                                                                                                                       | zh                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `available`                        | Update available → {to}                                                                                                                  | 可更新 → {to}                                                                        |
| `unknown`                          | Could not check for updates                                                                                                              | 无法检查更新                                                                         |
| `nextWake`                         | {to} on next wake                                                                                                                        | 下次唤醒时更新到 {to}                                                                |
| `state.updating`                   | Updating                                                                                                                                 | 更新中                                                                               |
| `action`                           | Update                                                                                                                                   | 更新                                                                                 |
| `actionTo`                         | Update to {to}                                                                                                                           | 更新到 {to}                                                                          |
| `confirm.title`                    | Update {name} to {to}?                                                                                                                   | 将 {name} 更新到 {to}？                                                              |
| `confirm.introRunning`             | {from} → {to}. The agent restarts on the new version, which takes about a minute. It keeps:                                              | {from} → {to}。智能体将以新版本重启，大约需要一分钟。以下内容会保留：                |
| `confirm.introHibernated`          | {from} → {to}. It stays asleep and takes the new version the next time it wakes. It keeps:                                               | {from} → {to}。它会保持休眠，下次唤醒时使用新版本。以下内容会保留：                  |
| `confirm.keep1`                    | its home and every file in it, including the cloned repositories;                                                                        | 主目录及其中的所有文件，包括克隆的仓库；                                             |
| `confirm.keep2`                    | its coding agent’s sign-in;                                                                                                              | 编码智能体的登录状态；                                                               |
| `confirm.keep3`                    | its chat sessions.                                                                                                                       | 聊天会话。                                                                           |
| `confirm.rollback`                 | If the new version doesn’t start, the agent goes back to {from} and tells you why.                                                       | 如果新版本无法启动，智能体会回到 {from} 并告诉你原因。                               |
| `confirm.rollbackWake`             | If the new version doesn’t start at that wake, the agent goes back to {from} and tells you why.                                          | 如果新版本在那次唤醒时无法启动，智能体会回到 {from} 并告诉你原因。                   |
| `confirm.notNow`                   | Not now                                                                                                                                  | 暂不                                                                                 |
| `confirm.running`                  | Update and restart                                                                                                                       | 更新并重启                                                                           |
| `confirm.hibernated`               | Update on next wake                                                                                                                      | 下次唤醒时更新                                                                       |
| `updating.title`                   | Updating to {to}                                                                                                                         | 正在更新到 {to}                                                                      |
| `updating.body`                    | The agent is restarting on the new version. Your home and sign-in stay where they are.                                                   | 智能体正在以新版本重启。你的主目录和登录状态保持不变。                               |
| `hibernated.body`                  | This agent is asleep. It moves to {to} when it wakes.                                                                                    | 该智能体正在休眠，唤醒时会更新到 {to}。                                              |
| `refused.runActive`                | {name} is running <link>{key}</link>. Cancel that run on the work item first, then update it.                                            | {name} 正在运行 <link>{key}</link>。请先在工作项上取消该运行，然后再更新它。         |
| `refused.upToDate`                 | This agent already runs the newest version ({to}).                                                                                       | 该智能体已经是最新版本（{to}）。                                                     |
| `refused.state`                    | This agent is {state}, so it can’t be updated right now.                                                                                 | 该智能体当前{state}，暂时无法更新。                                                  |
| `refused.unknown`                  | Motir couldn’t check for a newer version just now. Try again in a few minutes.                                                           | Motir 暂时无法检查新版本。请几分钟后重试。                                           |
| `rolledBack`                       | The update to {to} didn’t work: {reason}. Your agent is back on {from}.                                                                  | 更新到 {to} 未成功：{reason}。你的智能体已回到 {from}。                              |
| `imageTooOld.body`                 | It was made from an older image, from before the terminal existed. Update it to {to} to get the terminal. Its home and sign-in are kept. | 它基于终端出现之前的旧镜像创建。更新到 {to} 即可使用终端，主目录和登录状态都会保留。 |

**Wording notes.**

- The run-active refusal reuses the panel's existing run-refusal sentence shape
  (`myAgents.panel.run.refusedHibernate`, MOTIR-7022), so Hibernate, Delete and Update say it the
  same way.
- The could-not-check refusal follows MOTIR-6916's register for a wait ("Try again in a few
  minutes").
- `{reason}` is the server's words (`updateFailureReason`), shown as sent.
- If the rollback itself fails, the agent is `Failed` with that reason and Wake: MOTIR-6937 panel
  4's failed face, unchanged.

**Does NOT draw:**

- the page outside the agent row and the panel header;
- the terminal's own states, which stay MOTIR-6937 panel 5's;
- any surface for choosing a version other than the newest (decision Q1: none is offered).
