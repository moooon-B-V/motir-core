# `design/monitoring/` — design notes

**One surface: the project-settings `Monitoring` room** — where a workspace connects the error
monitor its services already report to, binds one or more of that monitor's projects to this Motir
project, sees the connection's health, and disconnects one.

| Surface                                               | Asset                                                                                                       | Card                                                                                 | Sections |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| **The `Monitoring` room** and its settings-rail entry | [`monitoring-room.mock.html`](./monitoring-room.mock.html) + [`monitoring-room.png`](./monitoring-room.png) | MOTIR-5256 (design) · **MOTIR-5288** (revision) → **MOTIR-5262** (surface + locales) | §1–§11   |

**Story MOTIR-4926 · subtask MOTIR-5256 (design gate, Principle #13).** This is the layout source
of truth for **MOTIR-5262**, which builds the room, the rail entry and both locales, and the surface
**MOTIR-5264**'s E2E walks.

---

## §1 · What this asset COMPOSES, and what it decides

**It composes two shipped surfaces and re-specifies neither.**

| Composed                                                                                             | What it owns, and this asset does not                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`design/projects/settings-area.mock.html`](../projects/settings-area.mock.html)                     | The project-settings AREA chrome: the 15rem rail, its group headings, the pane, and the eyebrow → serif-title → description head.                                                                                              |
| [`design/repository-set/repositories-room.mock.html`](../repository-set/repositories-room.mock.html) | The nearest ROOM precedent — a connection inventory with per-row lifecycle state and a destructive action. Its token, chrome and primitive layers are reused verbatim here, so the two assets of this tier cannot drift apart. |

**What this asset DECIDES** is the room's own content, and there are four decisions in it:

1. **The room is a ROW LIST with an empty state, never a single field.** A Motir project may hold
   more than one monitor connection, and MOTIR-5258 already made that a join table rather than a
   column on `project`. The degenerate case of one is a row count.
2. **The GRANT is drawn ABOVE the rows, and the HEALTH belongs to the grant.** A provider authorises
   at the organisation tier, so one authorisation covers every project in it — which is why the
   credential lives on the grant in the schema. A badge per row would imply three independently
   broken things where there is one.
3. **`degraded` is drawn three ways at once** — a filled warning chip, a banner quoting the
   provider's own sentence, and the two affordances that fix it. See §4.
4. **The rail entry sits in `General`, not `Automation`.** See §6.

---

## §2 · The panels

| Panel  | State                          | What it draws                                                                                                                  |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **1**  | `(none)`                       | The empty state: the muted mark, the serif title, ONE line saying what connecting does, one primary affordance.                |
| **2**  | `connected`                    | One monitored project — the degenerate case of the set, with the grant header above it.                                        |
| **1b** | `connected`, nothing monitored | _(revision)_ The screen after returning from Sentry: the grant, and one line saying nothing arrives until a project is chosen. |
| **3**  | `connected`                    | Three rows at real-product scale. _(revision: a fourth `connecting` row was removed — see §11.)_                               |
| **4**  | `degraded`                     | The provider's own reason, verbatim, with `Re-check` and `Reconnect`.                                                          |
| **5**  | the ACCESS PATH                | The rail entry that opens the room, drawn rather than described, plus the per-value state table.                               |
| **6**  | the PICKER                     | _(revision)_ Choosing projects: one already monitored (locked), several chosen, and a partial result.                          |
| **7**  | the picker, `degraded`         | _(revision)_ The picker cannot list on a revoked credential, and says why in Sentry's words.                                   |
| **8**  | DISCONNECT                     | _(revision)_ The confirmation in its two cases — one of several, and the last (which removes the credential).                  |
| **9**  | loading · error                | _(revision)_ The page's own renders, inside the room; never a route-level skeleton.                                            |
| **10** | coming back from Sentry        | _(revision)_ The return-status banner, three of eight drawn; §11 carries all eight.                                            |

---

## §3 · The state set is the checklist

The connection carries a lifecycle, and the room renders something different per value. All four are
drawn; none is left to the implementer.

| value                          | what the row shows                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connected`, nothing monitored | _(revision)_ The grant reads Connected; the section says nothing arrives until a project is chosen, with **Choose Sentry projects** as the primary action (panel 1b). |
| `connected`                    | The organisation and the bound projects, with when the credential was last checked. A filled success chip on the GRANT, not per row.                                  |
| `degraded`                     | The provider's OWN reason, verbatim, in a filled warning banner, with `Re-check` and `Reconnect`.                                                                     |
| `(none)`                       | The empty state carrying the connect affordance and one line saying what connecting does.                                                                             |

---

## §4 · Why `degraded` is drawn the way it is

**MOTIR-4918 measured a signal that stopped reaching anyone while every component reported
success.** A credential that has quietly expired reproduces exactly that shape one level up: the poll
runs, finds nothing, and the board stays empty in a way indistinguishable from a quiet week.

So:

- **A FILLED chip, never a border style.** `--el-warning-surface` + `--el-warning-text`. A dashed or
  coloured edge is a decoration a reader has to be taught, and a state has to read at a glance.
- **The banner quotes the PROVIDER**, prefixed `Sentry says:`. _"The connection failed"_ tells a
  person nothing about whether to re-authorise, restore a deleted integration, or wait. MOTIR-5261
  stores the provider's string verbatim for this reason; the room's job is not to summarise it.
- **The banner says what the state COSTS** — _"nothing new will reach the board in the meantime"_ —
  because the consequence is the thing a reader is actually deciding about.
- **The rows stay visible and stay accurate.** They are what is bound; the grant is what is broken.
  Hiding them would lose the only record of what the connection was for.

---

## §5 · Which behaviour came from which card

The design-content dependency rule: an asset that depicts an INTERACTION is grounded in the cards
that DEFINE it, and cites which came from which. Both are linked `relates_to` rather than
`blocked_by` — they are themselves behind this design, so an edge would deadlock the pair.

| Drawn behaviour                                                            | Comes from                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Connect Sentry` starts at Motir, not at the provider                      | **MOTIR-5260** — the start route sets the state cookie, so the flow must begin with a request to this server.                                                 |
| Binding is a SECOND act, after the authorisation returns                   | **MOTIR-5260** — the callback persists the grant and binds nothing; the person has not seen the list yet.                                                     |
| _(revision)_ A connected grant with NO rows is a state of its own          | **MOTIR-5260** — the callback persists the grant and binds nothing, so every connect lands here first.                                                        |
| _(revision)_ The picker lists the org's projects, each flagged `bound`     | **MOTIR-5260** — the available-projects read; the one read here that calls the provider, so it fails on a degraded grant (panel 7).                           |
| _(revision)_ Binding several is several writes, so a partial result exists | **MOTIR-5260** — one bind per project; an already-bound refusal means the wanted state holds, so it reads as success.                                         |
| _(revision)_ The confirmation differs when the last row goes               | **MOTIR-5260** — `disconnect` reports `removedGrant`; the room knows beforehand whether the row is the only one.                                              |
| _(revision)_ The eight return-status banners (panel 10)                    | **MOTIR-5260** — the start and callback routes' named outcomes.                                                                                               |
| Disconnect is per ROW, and removes the credential when it was the last one | **MOTIR-5260** — `disconnect` reports `removedGrant`, because "your connection is gone" and "that project is no longer bound" are different things to render. |
| `degraded` carries the provider's own reason                               | **MOTIR-5261** — the stored `healthReason`, written verbatim.                                                                                                 |
| `Re-check` exists at all, and what it does                                 | **MOTIR-5261** — the on-demand probe, which is the only door into a health check (there is no schedule here).                                                 |
| "checked N minutes ago"                                                    | **MOTIR-5261** — the stored `healthCheckedAt`, which is what the room reads between probes.                                                                   |

**Nothing about the room's content was invented.** Where a behaviour is not in either card, it is
not drawn — which is why there is no issue list, no filed-bug preview and no per-connection filter
anywhere on this board (§7).

---

## §6 · The ACCESS PATH — and why `General`

**The entry:** `Monitoring`, in the **General** group, **third — directly under `Repositories`**,
with the lucide `Activity` mark. It is drawn in panel 5 rather than described, because naming a route
in prose is not drawing the door.

**Grounded in `lib/settings/projectSettingsNav.ts`'s own convention**, not invented here: the rail
groups are `general` → `access` → `work` → `automation`, order within a group is rail order, and each
entry carries a permission that decides whether the row is rendered at all.

**Why `General` and not `Automation`** — the one judgement in this section:

- This room holds a **third party's CREDENTIAL** plus an inventory of what it is bound to, and a
  destructive action on each binding. That is the shape of `Repositories`, which is this asset's own
  named precedent and which sits in `general`.
- The `automation` group holds rooms that configure **Motir's OWN behaviour** — the planner's cadence
  (`AI planning`), the rule engine (`Rules`). A stored credential for somebody else's service is not
  that.
- The ingestion story's per-connection FILTER may well belong in `automation`, and that is
  **MOTIR-4929's own call**, not this asset's.

**The permission is `integration:manage`**, added by MOTIR-5260 — so a member who cannot manage the
credential does not see the door, which is how every other row in this rail behaves.

**⚠️ THE ROUTE IS DELIBERATELY NOT NAMED ANYWHERE IN THIS ASSET, and that is worth stating because
the omission looks like one.** The room's page does not exist yet — `MOTIR-5262` creates it — and
`tests/design-asset-addresses.test.ts` sweeps `design/**` for addresses that resolve to nothing. A
forward-looking asset may park such an address in that guard's `KNOWN` table with a reason; this one
does not need to, because it specifies the ROOM and its RAIL ENTRY and lets the card that builds the
page own its address. So there is no exemption to retire later, and the design lane is green on this
asset with no entry of its own. If a later revision does name the path, it owes that `KNOWN` row.

---

## §7 · Scope boundary — what this asset must NOT be read as specifying

**Explicitly not drawn, and the reason is the same for all three:** an asset that draws a surface
nobody owns hands the next card a spec with no work item behind it.

- **No issue list, no filed-bug preview, no per-connection filter UI.** Those surfaces belong to
  MOTIR-4929 (the poll and what it writes) and MOTIR-4932.
- **No bug-container picker.** Which container a project's monitor bugs land in is MOTIR-4927's.
- **No schedule, and nothing that implies one.** The room's health is READ from the stored verdict
  and re-established on demand; every schedule in this story is MOTIR-4929's.

---

## §8 · Tokens, primitives and icons

- **Colour** flows through `--el-*` element tokens; **shape** through the element-semantic shape
  tokens (`--radius-card`, `--radius-control`, `--radius-badge`, `--spacing-card-padding`,
  `--spacing-control-*`). No Tier-0 `--color-*` and no raw `rounded-md` / `p-2` / `h-9` appears in
  any product element on the board.
- **Two tokens this asset deliberately does NOT use** are named in the mock where they would have
  gone: **`--el-warning-border`** and **`--el-success-text`** do not exist in
  `packages/design-system/theme.css`. The success chip inks its LABEL with `--el-text-strong` and
  colours only the glyph with `--el-success`, which is what the shipped state chip does; the degraded
  card keeps its ordinary border and lets the chip and banner carry the state. Inventing either token
  is the failure the never-invent-a-colour rule forbids.
- **Primitives**, reused rather than restyled: `Button` (`btn btn-primary` / `btn-secondary` /
  `btn-ghost` / `btn-sm`), `Card`, `SectionLabel` (`.seclabel`), `EmptyState`, the icon button, and
  the settings-area rail row. Each class mirrors the cva recipe in
  `packages/design-system/src/components/ui/`.
- **Icons**: every `<symbol>` in the sheet is EXTRACTED from the installed `lucide-react` and carries
  its provenance comment, so `scripts/audit-mock-sprites.mjs` can rule on it — `21 symbols · 21
checked · 0 undeclared · 0 DRIFTED`. The room's own glyphs are `activity` (the room and its rail
  entry), `bug` (a monitored project row), `circle-check-big` / `triangle-alert` / `loader-circle`
  (the three health values), `refresh-cw` (re-check), `trash-2` (disconnect) and `plus` (connect and
  add).

---

## §9 · Copy

| Element                 | Copy                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room title              | **Monitoring**                                                                                                                                                                          |
| Room description        | Connect the error monitor your services already report to, and Motir turns its issues into work items on this project's board.                                                          |
| Empty-state title       | **No error monitor connected**                                                                                                                                                          |
| Empty-state body        | Connect Sentry and the issues it records for the projects you choose arrive here as bug work items — in the container this project picks, with the issue's own culprit and a link back. |
| Empty-state action      | **Connect Sentry**                                                                                                                                                                      |
| Section label           | **Monitored projects**                                                                                                                                                                  |
| Section hint            | Issues from these Sentry projects become bug work items on this board.                                                                                                                  |
| Section hint (degraded) | Nothing new arrives from these while the connection is degraded.                                                                                                                        |
| Grant meta              | `<org-slug>` · checked N minutes ago                                                                                                                                                    |
| Health values           | **Connected** · **Degraded**                                                                                                                                                            |
| Degraded banner         | **Sentry says:** `<the provider's own reason>` Motir cannot read this organisation's issues until somebody reconnects it — nothing new will reach the board in the meantime.            |
| Grant actions           | **Re-check** · **Reconnect**                                                                                                                                                            |
| Row actions             | (icon) disconnect — _(revision: **Open in Sentry** removed, §11)_                                                                                                                       |
| Add affordance          | **Add a monitored project**                                                                                                                                                             |
| Row sub-line            | Bound `<when>` — _(revision: the issue count and the connecting line removed, §11)_                                                                                                     |

**Both locales are MOTIR-5262's**, which owns the `messages/en.json` + `messages/zh.json` pair for
every string above.

---

## §10 · The GIVES / TAKES sweep

Every work-item key this asset names, swept for what the asset GIVES that card and what it TAKES
from it. A TAKES is amended onto that card in the same pass; there are none.

| Key            | GIVES / TAKES                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-5262** | **GIVES** the whole room: five panels, the state table, the copy table, the rail entry's group/position/icon, and the `integration:manage` gate on it. Its criteria already ask for the rail entry, the connection list, connect and disconnect, the degraded row and both locales — every one of them is drawn. **No TAKES.** |
| **MOTIR-5260** | **GIVES** a reading of its flow: the callback binds NOTHING and binding is a second, explicit act. That is what the service shipped, and the card carries the deviation on its own record. **No TAKES.**                                                                                                                       |
| **MOTIR-5261** | **GIVES** the surface its stored verdict is rendered on, including that `healthCheckedAt` is shown as _"checked N minutes ago"_ and that `Re-check` is the probe's only door. **No TAKES.**                                                                                                                                    |
| **MOTIR-5258** | Nothing. The asset relies on its join table being a SET and on the credential living on the grant; both shipped. **No TAKES.**                                                                                                                                                                                                 |
| **MOTIR-4929** | **GIVES** a boundary rather than a spec: the per-connection filter is named as NOT drawn here and as that story's, so it does not inherit a surface nobody planned. **No TAKES.**                                                                                                                                              |
| **MOTIR-4927** | Nothing drawn. The bug container is named only as out of scope. **No TAKES.**                                                                                                                                                                                                                                                  |
| **MOTIR-4918** | Nothing — it is the measurement §4 rests on, not a card this asset changes.                                                                                                                                                                                                                                                    |

---

## §11 · REVISION — MOTIR-5288: the states AFTER connect

**Why this section exists.** The asset above drew the room empty, with one row, with several and
degraded — the four states its own card listed — and stopped one transition short. MOTIR-5260 had
already decided the callback stores the grant and binds nothing, so the state every person lands in
right after connecting (a connected organisation, nothing monitored) was drawn nowhere, and the picker
that gets them out of it was a button that opened nothing. MOTIR-5262's design gate caught it before
any code. This revision draws what was missing, and removes three things the room could never have
rendered.

### What was ADDED

| Panel  | What                                                                                                                                                          | Grounded in                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **1b** | Connected, nothing monitored — the primary **Choose Sentry projects**                                                                                         | MOTIR-5260's grant-then-bind flow                                                                        |
| **6**  | The picker: filter, several chosen, an already-monitored project shown **checked and locked** rather than hidden, and a **partial result** with per-row retry | MOTIR-5260's available-projects read (`bound` per row) and one bind write per project                    |
| **7**  | The picker on a degraded grant: no list, Sentry's reason, **Reconnect**                                                                                       | the available read is the one read here that calls the provider (MOTIR-5260); the reason is MOTIR-5261's |
| **8**  | Disconnect confirmation — **Stop monitoring `<slug>`?** for one of several, **Disconnect Sentry?** for the last                                               | MOTIR-5260's `removedGrant`                                                                              |
| **9**  | Loading and error, inside the room                                                                                                                            | `CLAUDE.md`'s `loading.tsx` rule                                                                         |
| **10** | The return-status banner — three drawn, all eight in the table below                                                                                          | MOTIR-5260's start and callback outcomes                                                                 |

**Two rules the picker follows that are easy to get wrong in code:**

- **An already-bound refusal is SUCCESS.** If somebody else added the same project in the same
  moment, the server refuses the second bind as _already monitored_ — which is exactly the state the
  person wanted. It locks the row like any other success and is never shown as an error.
- **Retry is per row.** A failure keeps that row's box ticked with the reason inline; _Try again_
  retries only the failed ones, and _Done_ closes with the successes kept.

### What was REMOVED, and why each is a decision rather than a cut

| Removed                                                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `connecting` row state** (panel 3's fourth row, the state table, _Connecting_ in the health values) | Under the flow MOTIR-5260 shipped, binding is one database write with no pending phase, and the only in-flight leg — the authorisation — happens on Sentry's page and returns to panel 1b. No field the room receives could ever put a row in this state, so building it would build a state with nothing behind it.                                                                                                                                    |
| **Open in Sentry** on every row                                                                           | Nothing the room receives carries a URL for a monitored project, so a component would have had to assemble a Sentry URL from two slugs — provider knowledge leaking past the seam built to contain it. And the link that matters is not on the binding: every bug the ingestion story files carries **its own issue's permalink** (the seam's normalized issue already has one), which is where a person triaging an error actually needs to jump from. |
| **"N issues seen" / "last issue …"** on every row                                                         | The same class: no count or timestamp of issues exists in anything this story stores. Issue data is the ingestion story's (MOTIR-4929); if a count belongs on this row, that story adds the field and the design adds the line — together.                                                                                                                                                                                                              |

### The return statuses — copy for all eight

The banner sits above the grant, dismissible. **The `error` banner's reason must reach the page from
the SERVER**, never from the address bar: a reason read from a query string lets a crafted link put
any sentence after _"Sentry says:"_ on a Motir page.

| Outcome          | Tone    | Copy                                                                                                                      |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `connected`      | success | **Sentry is connected.** Choose which of `<org>`'s projects send issues to this board.                                    |
| `error`          | danger  | **Couldn't connect Sentry.** Sentry says: `<the provider's own reason>` Nothing was saved — try connecting again.         |
| `denied`         | info    | **Sentry wasn't connected.** The request was declined in Sentry — nothing was saved.                                      |
| `no_state`       | info    | **That install didn't start here.** To connect Sentry to this project, use **Connect Sentry** below — nothing was saved.  |
| `state_error`    | danger  | **Couldn't connect Sentry.** The request couldn't be verified, so nothing was saved. Try connecting again.                |
| `forbidden`      | danger  | **You can't manage integrations on this project.** Ask a project admin to connect Sentry.                                 |
| `no_project`     | danger  | **Couldn't tell which project to connect.** Open Monitoring from the project's settings and try again.                    |
| `not_configured` | info    | **Sentry isn't set up on this Motir deployment yet.** An administrator needs to add the Sentry integration's credentials. |

### New copy

| Element                                         | Copy                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing-monitored title                         | **No Sentry projects monitored yet**                                                                                                                                                                                           |
| Nothing-monitored body                          | Sentry is connected to `<org>`. Choose which of its projects send issues to this board — nothing arrives until you do.                                                                                                         |
| Nothing-monitored action                        | **Choose Sentry projects**                                                                                                                                                                                                     |
| Picker title                                    | **Choose Sentry projects**                                                                                                                                                                                                     |
| Picker subtitle                                 | From `<org>`. Issues from the projects you choose become bug work items on this board.                                                                                                                                         |
| Picker filter placeholder                       | Filter projects                                                                                                                                                                                                                |
| Picker locked tag                               | Already monitored · _(after a bind)_ Now monitored                                                                                                                                                                             |
| Picker primary                                  | **Monitor `<n>` projects** · _(one)_ **Monitor 1 project**                                                                                                                                                                     |
| Picker partial subtitle                         | `<k>` of `<n>` projects added. The other one wasn't. · _(plural)_ The others weren't.                                                                                                                                          |
| Picker row error                                | Couldn't add — try again                                                                                                                                                                                                       |
| Picker partial actions                          | **Done** · **Try again**                                                                                                                                                                                                       |
| Picker degraded banner                          | **Couldn't load `<org>`'s projects.** Sentry says: `<reason>`                                                                                                                                                                  |
| Picker degraded body                            | Motir needs a working connection to list them. Reconnect Sentry, then choose your projects.                                                                                                                                    |
| Confirm, one of several — title / body / action | **Stop monitoring `<slug>`?** / New issues from **`<slug>`** stop arriving on this board. **`<other slugs>`** stays monitored. / **Stop monitoring**                                                                           |
| Confirm, last — title / body / action           | **Disconnect Sentry?** / **`<slug>`** is the last monitored project, so this also removes Motir's stored access to **`<org>`**. To monitor any of its projects again, you'll reconnect through Sentry. / **Disconnect Sentry** |
| Loading                                         | Loading monitoring…                                                                                                                                                                                                            |
| Error title / body / action                     | **Couldn't load monitoring for this project** / Nothing has changed. Try again, and if it keeps happening, reload the page. / **Try again**                                                                                    |

**Both locales remain MOTIR-5262's.**

### GIVES / TAKES — the revision's own sweep

| Key            | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5262** | **GIVES** panels 1b and 6–10 and every string above; **TAKES** a PREMISE — the row's _Open in Sentry_ action and issue count are gone, and nothing it builds renders a `connecting` row. **⚠️ And the GIVES is a claim about SIZE:** a picker with a filter, locked rows, a multi-select and a per-row partial result, two confirmation variants, loading and error, and eight return banners in two locales is well past what a card sized at 5 points / 65 minutes before any of it was drawn can hold. **That is the estimation gate crossing its ceiling, which is a SPLIT, not a bigger number** — proposed as a plan in the same pass, recorded on MOTIR-5262. |
| **MOTIR-5264** | **TAKES** a PREMISE: its walk's _"connect … and back through the real callback route, see the connection listed"_ no longer holds, because returning lands on panel 1b and a row appears only after the picker binds a project. **Amended on that work item in the same pass.**                                                                                                                                                                                                                                                                                                                                                                                      |
| **MOTIR-5260** | Nothing taken. **One defect found while reading its outcomes for panel 10**: the callback puts Sentry's reason in a response HEADER on a redirect, which the browser drops before the page loads — so the room could never have shown _"Sentry says: …"_ for a failed exchange. Fixed on the parent branch, and the banner copy above requires the server-delivered form.                                                                                                                                                                                                                                                                                            |
| **MOTIR-5261** | Nothing taken; the degraded picker (panel 7) reads its stored reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **MOTIR-4929** | **GIVES** a boundary: the issue count and last-issue time are that story's to add, with the design line that shows them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
