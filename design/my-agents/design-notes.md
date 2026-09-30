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
