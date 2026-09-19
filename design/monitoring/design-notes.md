# `design/monitoring/` — design notes

**One surface: the project-settings `Monitoring` room** — where a workspace connects the error
monitor its services already report to, binds one or more of that monitor's projects to this Motir
project, sees the connection's health, and disconnects one.

| Surface                                               | Asset                                                                                                       | Card                                                                                 | Sections |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| **The `Monitoring` room** and its settings-rail entry | [`monitoring-room.mock.html`](./monitoring-room.mock.html) + [`monitoring-room.png`](./monitoring-room.png) | MOTIR-5256 (design) · **MOTIR-5288** (revision) → **MOTIR-5262** (surface + locales) | §1–§11   |
| **Ingestion on each connection row**                  | [`monitoring-room--ingestion.mock.html`](./monitoring-room--ingestion.mock.html)                            | **MOTIR-5575** (delta) → **MOTIR-5582** (surface + locales)                          | §12      |
| **Sync on each connection row**                       | [`monitoring-room--sync.mock.html`](./monitoring-room--sync.mock.html)                                      | **MOTIR-5700** (delta) → **MOTIR-5707** (surface + locales)                          | §13      |

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

---

## §12 · REVISION — ingestion

_Amends `design/monitoring/monitoring-room.mock.html` (panels 2–4: the rows and the degraded banner) through the delta `design/monitoring/monitoring-room--ingestion.mock.html`, drawn by MOTIR-5575._

### Shipped reality and placement

The existing `MonitoringRoom` was rendered from the **real component**, with the real
`packages/design-system/theme.css`, `app/globals.css`, fonts and lucide icons, before this delta was
drawn. At a 1100px viewport its content remains the shipped 46rem pane: a grant card, then
`Monitored projects`, then 64px-high connection rows with the slug and `Bound …` line on the left,
the destructive icon action on the right. The delta keeps that hierarchy, measure and primitive
grammar. It adds content **inside each existing connection row** rather than creating a second
ingestion panel or moving the setting into Automation.

The minimum level is a property of **one binding**, so its `Select`/`Combobox` trigger sits on that
binding's row, immediately before Disconnect. The settings-rail entrance is unchanged:
`Monitoring` remains in **General**, directly below `Repositories`, under `integration:manage`.

### The level control

The closed trigger is labelled **Minimum level** and renders the stored value. Its values, in menu
order, are:

1. **Every level** — stored as `null`, the shipped default.
2. `debug`
3. `info`
4. `warning`
5. `error`
6. `fatal`

The open menu carries the helper: **“Choosing a lower level also checks earlier issues since this
project was first monitored.”** This makes the rewind behavior from MOTIR-5579 visible at the action
that causes it; lowering is not presented as merely prospective.

While the write is in flight, the trigger is disabled and reads **Saving…** with the shipped spinner;
the row's Disconnect action is disabled for the same interval. A refused write keeps the prior value
and shows an inline filled warning beneath the control: **“Couldn't change level. Nothing changed —
try again.”** The error is local to the row and does not turn the whole grant `degraded`.

### Poll-outcome copy and state table

The poll line sits below `Bound …`, because both are timestamps about the same binding. It is a quiet
secondary line for healthy/initial states and a filled `--el-warning-surface` line for overdue or
failed states. The exact state set is the implementation checklist:

| Stored outcome                                | Row copy and treatment                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never polled, bound less than an hour ago     | **Waiting for the first check** — quiet secondary text.                                                                                                                                                                                 |
| Never polled, bound an hour or more ago       | **No check since `<bound time>`. Two scheduled checks were missed.** — the overdue line below, measured from the binding's `createdAt`. A scheduler that never reached a new binding must not read as _waiting_.                        |
| `ok`, recent, no new bugs                     | **Checked for new errors N min ago** — quiet secondary text.                                                                                                                                                                            |
| `ok`, recent, bugs filed                      | **Checked for new errors N min ago · N bugs filed** — the count is strong within the same quiet line.                                                                                                                                   |
| `ok`, older than two missed half-hourly ticks | **No check since `<time>`. Two scheduled checks were missed.** — filled warning line with `TriangleAlert`.                                                                                                                              |
| `failed`                                      | **Couldn't check for new errors: `<stored reason>`. Last successful check `<time>`.** — filled warning line; the stored reason is rendered verbatim. When the binding has never had a successful check, the second sentence is omitted. |
| Grant `degraded`                              | The existing grant chip/banner stays the loudest state, and every connection row renders the `failed` line beneath it. Grant health and poll health answer different questions, so neither hides the other.                             |

The overdue threshold comes from MOTIR-5581's half-hourly cadence: two missed ticks, exported there as `MONITOR_ISSUE_RECONCILE_OVERDUE_MS` (one hour). It is measured from `lastPolledAt`, or from the binding's `createdAt` when there is none. Overdue is checked BEFORE the stored status, so an `ok` or a `failed` row that has stopped being polled reads overdue.

**The last-success time needs a stored field the store did not have.** `lastPolledAt` moves on every poll, failed ones included, so it cannot say when the binding last succeeded. This delta therefore TAKES a nullable `lastPollSucceededAt` on `monitor_connection` (written by the `ok` arm of `recordPollOutcome`) and on `MonitorConnectionDto` — see the sweep below. Relative recent
times and the last-success line are formatted from stored values; the error reason is never invented
or summarized by the component.

### Tokens, primitives and icon provenance

- **Existing primitives reused:** the shipped room's `Card`, `SectionLabel`, `Button`, icon button,
  grant health `Pill`, and connection-row grammar; the level control uses the design-system
  `Select`/`Combobox` trigger and menu rather than a hand-rolled dropdown.
- **Colour:** product elements consume only `--el-*`. Healthy text uses `--el-text-secondary`;
  warning fills use `--el-warning-surface` + `--el-warning-text`, with the glyph on
  `--el-warning`. No state is encoded by a dashed border.
- **Shape:** cards, controls, inputs, chips, padding and heights use `--radius-*`,
  `--spacing-*`, and `--height-*` element-semantic tokens.
- **Icons:** `activity`, `bug`, `circle-check-big`, `triangle-alert`, `refresh-cw`, `trash-2`,
  `chevron-down`, `check`, and `loader-circle` are extracted from the installed
  `lucide-react@1.16.0`; every symbol in the delta carries its provenance comment.

### Copy table

| Element                  | English copy                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Control label            | **Minimum level**                                                                                                                 |
| Null/default value       | **Every level**                                                                                                                   |
| Lowering helper          | Choosing a lower level also checks earlier issues since this project was first monitored.                                         |
| Saving                   | **Saving…**                                                                                                                       |
| Refused write            | **Couldn't change level. Nothing changed — try again.**                                                                           |
| Never polled             | Waiting for the first check                                                                                                       |
| Recent success           | Checked for new errors N min ago                                                                                                  |
| Recent success with work | Checked for new errors N min ago · **N bugs filed**                                                                               |
| Overdue                  | **No check since `<time>`.** Two scheduled checks were missed. (`<time>` is the last poll, or the binding time when never polled) |
| Failed                   | **Couldn't check for new errors:** `<stored reason>`. Last successful check `<time>`.                                             |

MOTIR-5582 owns every `en` string above and its locked-register `zh` twin.

### Scope boundary

- **No issue or bug list, and no Bugs-room link.** This row reports only what the last poll did.
  The provenance surface remains MOTIR-4932's, and its stricter access gate means a link here would
  lead some `integration:manage` readers to a refusal.
- **No poll action.** Re-check remains the grant-health probe. The scheduled reconciler owns polling;
  this room observes its stored outcome.
- **No schedule control or bug-container picker.** Those belong to their existing stories.
- **No change to the rail entrance, route, grant card, picker, disconnect flow, loading state, or
  return banners.** `monitoring-room.mock.html` remains their design of record.

### Workflow grounding

| Behavior drawn                                                                                                                           | Defining card  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Stored watermark, minimum level, last-poll outcome/reason/filed count and binder fields, plus the `lastPollSucceededAt` this delta takes | **MOTIR-5576** |
| Lowering a level rewinds the watermark so skipped issues are reconsidered                                                                | **MOTIR-5579** |
| Per-connection poll result, verbatim failure reason and last-success state                                                               | **MOTIR-5580** |
| Half-hourly cadence and overdue after two missed ticks (`MONITOR_ISSUE_RECONCILE_OVERDUE_MS`)                                            | **MOTIR-5581** |

These are `relates_to` workflow specifications, not build prerequisites for a design artifact; wiring
`blocked_by` from this design to them would invert the intended design-first chain. MOTIR-5582 is the
consumer and is already `blocked_by` MOTIR-5575. MOTIR-4932 is named only to enforce the explicit
scope boundary above.

### GIVES / TAKES sweep

| Key            | GIVES / TAKES                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-5582** | **GIVES** the complete build specification for the row control, every poll outcome, saving/refused states, degraded pairing, exact English copy, and token/primitive choices. **No TAKES:** its criteria already assign this whole surface and both locales to that card.                              |
| **MOTIR-5576** | **GIVES** a visible consumer for the connection fields it stores. **TAKES** one column: `lastPollSucceededAt DateTime?` on `monitor_connection`, set by `recordPollOutcome` on `ok` and left untouched on `failed`, so the failed line can say when the binding last succeeded. Amended onto the card. |
| **MOTIR-5579** | **GIVES** the room placement and visible contract for its write, including the rewind helper and refused state. **TAKES** a sixth DTO field, `lastPollSucceededAt` (ISO or `null`), mapped beside the five it already adds. Amended onto the card.                                                     |
| **MOTIR-5580** | **GIVES** the per-value rendering of its stored outcome and verbatim reason. **No TAKES:** polling and issue creation remain service work.                                                                                                                                                             |
| **MOTIR-5581** | **GIVES** the overdue treatment derived from its half-hourly cadence. **No TAKES:** no schedule control is drawn.                                                                                                                                                                                      |
| **MOTIR-4932** | Nothing drawn. **No TAKES:** the issue provenance panel is explicitly excluded.                                                                                                                                                                                                                        |
| **MOTIR-5575** | This is the producing design card, not a consumer allocation. No self-edge is introduced.                                                                                                                                                                                                              |

---

## §13 · REVISION — sync: two direction switches, and a failed resolve-back on the row

_Amends the connection row of `design/monitoring/monitoring-room--ingestion.mock.html` (§12) through
the delta `design/monitoring/monitoring-room--sync.mock.html`, drawn by MOTIR-5700 for Story
MOTIR-4931. Built by **MOTIR-5707** (surface + both locales), which is `blocked_by` this card._

### What it composes, and redraws none of

| Composed                                   | Design card                            | `sourcePath`                                             | What it still owns                                                                                                                                      |
| ------------------------------------------ | -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The room, grant card, rows, degraded state | **MOTIR-5256**, revised **MOTIR-5288** | `design/monitoring/monitoring-room.mock.html`            | The rail entry (General, below Repositories), the pane head, the grant card and its `degraded` banner, the picker, disconnect, loading, return banners. |
| The row's ingestion strip                  | **MOTIR-5575**                         | `design/monitoring/monitoring-room--ingestion.mock.html` | The **Minimum level** control, its saving/refused states, and the poll-outcome line with its state table.                                               |

Neither file changes in this diff. **The access path is unchanged and is DRAWN, not re-decided:**
panel 1 shows the settings rail's `General` group with **Monitoring** active, and the switches on the
row in the room it opens — the whole path from the rail to the control in one panel.

**Shipped reality.** The row here mirrors the SHIPPED `ConnectionRow` in
`app/(authed)/settings/project/monitoring/_components/MonitoringRoom.tsx` (as of `origin/main`
`3c80c945a`), class for class — not the ingestion mock's stylisation of it. The two differ in one
visible way: the shipped row writes **Minimum level** as a quiet inline label to the LEFT of the
`Combobox` trigger, where the §12 mock stacked an uppercase label above it. This delta draws what
ships. The switch is the design system's `Switch` (`packages/design-system/src/components/ui/Switch.tsx`,
re-exported as `@/components/ui/Switch`): a 36×20 track on `--el-switch-on` / `--el-muted`, a 14px
knob on `--el-switch-knob`, `role="switch"`, named by its visible label through `aria-labelledby`.
No new control is drawn.

### Decision 1 · The grouping — a SYNC band under the row's top line, not beside Minimum level

The two switches sit in their **own band inside the same row card**, beneath the top line and
separated from it by an `--el-border-soft` hairline. The top line keeps exactly what it has shipped
since §12: the slug, `Bound …`, the poll line, **Minimum level**, and Disconnect.

**Why, in order of weight:**

1. **Direction.** Minimum level governs what comes **IN** — which of the monitor's issues become bugs.
   The switches govern what goes **OUT** to the monitor and what Motir **takes back** from it after a
   bug exists. Putting all three in one control cluster would read as three filters on ingestion;
   splitting them by a hairline says there are two questions on this row.
2. **Room.** The top line is already at capacity at the 46rem pane: a two-line identity column, a
   `9rem` trigger and an icon button. Two switches, each with a label and a one-line hint, cannot
   join it without wrapping the row into a form.
3. **Ownership.** Both switches are per CONNECTION (`monitor_connection.resolve_on_done`,
   `.sync_assignee` — MOTIR-5701), exactly the scope the row already is, so they stay ON the row. A
   room-level "sync settings" section would claim they apply to every binding at once, which is false.

The band opens with a quiet label, **Sync with Sentry**, in the row's secondary text treatment
(`text-xs`, `--el-text-secondary`) — the same register as `Minimum level`, so neither shouts.

### Decision 2 · Labels name the OUTCOME, and each hint says what OFF means

| Switch          | Label                                      | Hint (always shown, under the label)                                  | Stored as       |
| --------------- | ------------------------------------------ | --------------------------------------------------------------------- | --------------- |
| Motir → monitor | **Resolve in Sentry when the bug is done** | Turn off to leave Sentry issues as they are when their bugs are done. | `resolveOnDone` |
| monitor → Motir | **Take the assignee from Sentry**          | Turn off to ignore assignments made in Sentry.                        | `syncAssignee`  |

**Both default ON** — the story's shipped default (MOTIR-4931: "the shipped default resolves"), and
the store's `DEFAULT true` on both columns (MOTIR-5701). Panel 1 draws the default; panel 2 draws
each switch off, one per row. A switch that is off keeps its hint unchanged: the hint describes the
switch, not the current value, so it never flips wording under a person's cursor.

### Decision 3 · A failed resolve-back, per value of the sync outcome

The state set is the checklist. The row reads the connection's `lastSyncError` /
`lastSyncErrorAt` / `lastSyncErrorWorkItemIdentifier` (MOTIR-5706's DTO), and nothing else:

| Sync outcome                          | What the row shows                                                                                                                                                                                                                                                                                                                                                                   | Defined by             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| **none yet** (nothing resolved)       | No line.                                                                                                                                                                                                                                                                                                                                                                             | MOTIR-5701             |
| **last resolve succeeded**            | No line. A success is not news on this surface — and a success CLEARS the connection's failure (`clearSyncFailure`), so a line that was showing goes away on its own.                                                                                                                                                                                                                | MOTIR-5703             |
| **last resolve failed**               | A filled warning line **inside the sync band, directly under the `Resolve in Sentry…` switch it belongs to**: `TriangleAlert` on `--el-warning`, fill `--el-warning-surface`, ink `--el-warning-text`. It reads **Couldn't resolve Sentry's issue for `<KEY-n>`:** `<the provider's reason, verbatim>` then **Tried `<relative time>`.** The key is a link to the bug (`--el-link`). | MOTIR-5703, MOTIR-5706 |
| **the issue is gone at the provider** | **Not drawn on the room.** It is said once, on the bug itself, by the comment the resolve-back posts as the connection's binder; the link is recorded `gone` and never retried, so there is nothing to fix here and no room state for it.                                                                                                                                            | MOTIR-5703             |

The line sits under the resolve switch rather than beside the poll line because it is about the
OUTBOUND direction: the poll line reports what the last check for NEW errors did (§12), and a person
reading "Couldn't check…" and "Couldn't resolve…" side by side should be able to tell which way each
one failed from where it sits. It is the connection's LAST failure only — a per-issue sync log is out
of scope (below).

**The assignee direction draws no line on the room.** Its no-ops (`team_assignee`,
`no_matching_member`) are recorded per link on `monitor_issue.assignee_sync_note` (MOTIR-5705) and
are facts about one bug, so they belong on that bug's provenance panel (MOTIR-4932). A missing binder
on the assignee path writes the same connection failure the resolve path writes (MOTIR-5705), and
then it renders in this same line.

### Decision 4 · On a `degraded` grant the switches stay OPERABLE

Panel 4 draws the degraded grant of the base mock's panel 4, and the switches on its row are enabled.
**A switch is a Motir-side preference; toggling it makes no call to Sentry** (MOTIR-5706 writes two
columns and nothing else). Disabling it would only take away the one useful act available while the
credential is broken: a team that would rather NOT be written to can turn resolve-back off BEFORE it
reconnects, so the first sweep after reconnecting resolves nothing. The failure line may appear on a
degraded row too — a resolve attempted while the credential was revoked records Sentry's refusal —
and the two states stack in the order of §12: the grant banner stays loudest, the row lines beneath it.

### Decision 5 · Saving: write on toggle, pending → saved → failed, like Minimum level

- **On toggle** the switch moves at once and the request goes out carrying only the key that changed
  (MOTIR-5706's PATCH is sparse). **While it is in flight** the switch is disabled and a
  `LoaderCircle` spinner with **Saving…** sits after its label; the row's Disconnect is disabled for the
  same interval, exactly as §12 does for the level. The OTHER switch stays operable — the writes are
  independent keys.
- **Saved** is the response DTO's value rendered in place — no toast, no banner.
- **Failed:** the switch returns to the stored value, and a filled warning line appears under the band:
  **Couldn't change this setting.** Nothing changed — try again. It is local to the row, like the
  level's refusal, and never turns the grant `degraded`. Panel 5 draws both.

### Copy — every new string, both locales

Namespace: `monitoring.row.sync.*` in `messages/en.json` / `messages/zh.json`, beside the shipped
`monitoring.row.level.*` and `monitoring.row.poll.*`. The `zh` register follows the shipped room's
(`最低级别`, `正在保存…`, `未做任何更改——请重试。`).

| Key                                     | `en`                                                                  | `zh`                                                     |
| --------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `monitoring.row.sync.label`             | Sync with Sentry                                                      | 与 Sentry 同步                                           |
| `monitoring.row.sync.resolve.label`     | Resolve in Sentry when the bug is done                                | 缺陷完成时，在 Sentry 中将问题标记为已解决               |
| `monitoring.row.sync.resolve.hint`      | Turn off to leave Sentry issues as they are when their bugs are done. | 关闭后，缺陷完成时 Sentry 中的问题将保持原状。           |
| `monitoring.row.sync.assignee.label`    | Take the assignee from Sentry                                         | 从 Sentry 获取负责人                                     |
| `monitoring.row.sync.assignee.hint`     | Turn off to ignore assignments made in Sentry.                        | 关闭后，将忽略在 Sentry 中进行的分配。                   |
| `monitoring.row.sync.saving`            | Saving…                                                               | 正在保存…                                                |
| `monitoring.row.sync.failed`            | `<b>Couldn't change this setting.</b> Nothing changed — try again.`   | `<b>无法更改此设置。</b>未做任何更改——请重试。`          |
| `monitoring.row.sync.resolveFailed`     | `<b>Couldn't resolve Sentry's issue for {key}:</b> {reason}`          | `<b>无法在 Sentry 中解决 {key} 对应的问题：</b>{reason}` |
| `monitoring.row.sync.resolveFailedWhen` | Tried {when}.                                                         | 尝试时间：{when}。                                       |

`{key}` renders as a link to the bug; `{reason}` is `lastSyncError` verbatim — the component never
words or summarises it (§4's rule, applied outward); `{when}` is `lastSyncErrorAt` formatted as a
relative time, like every other time on the row. Both switches are named by their visible label
(`aria-labelledby`), so no separate accessible-name string exists.

### Which behaviour came from which card

| Drawn behaviour                                                                                                                               | Defining card                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Both switches exist per connection, both default on                                                                                           | **MOTIR-5701** (the columns, `DEFAULT true`), **MOTIR-4931** (the default) |
| A switch writes only its own key and returns the DTO the row renders; `integration:manage` gates it                                           | **MOTIR-5706**                                                             |
| Resolve fires when a bug reaches a done-category status; a refusal is recorded on the connection with the provider's reason and the bug's key | **MOTIR-5703**                                                             |
| A success clears the connection's failure (the line disappears)                                                                               | **MOTIR-5703** (`clearSyncFailure`)                                        |
| A gone issue is said on the card, never on the room, and never retried                                                                        | **MOTIR-5703**                                                             |
| Assignee is taken only on a provider-side CHANGE; team / unmatched are recorded no-ops                                                        | **MOTIR-5705**                                                             |
| The DTO carries `resolveOnDone`, `syncAssignee`, `lastSyncError*`                                                                             | **MOTIR-5706**                                                             |

These are `relates_to` specifications, not build prerequisites: those cards are `blocked_by` nothing
here, and the consumer, MOTIR-5707, is `blocked_by` this card.

### Scope boundary

- **The work-item page** — provenance, recurrence, the gone-issue presentation and any assignee no-op
  note on a bug — is MOTIR-4932's panel.
- **No per-issue sync log**, and no count of resolved issues. The row shows the LAST failure only.
- **No Motir → Sentry assignee control.** The story ships monitor → Motir only.
- **No change** to the rail entry, the grant card, the picker, disconnect, Minimum level or the poll
  line. `monitoring-room.mock.html` and `monitoring-room--ingestion.mock.html` remain their design of
  record.

### Tokens and primitives

Colour only through `--el-*` (`--el-switch-on`, `--el-switch-knob`, `--el-muted`,
`--el-border-strong`, `--el-border-soft`, `--el-warning*`, `--el-link`, `--el-text*`); shape only
through `--radius-*`, `--spacing-*` and `--height-*`. Primitives: `Switch`, `Combobox` (unchanged
level trigger), the row card, the icon button and the filled warning line the shipped row already
renders for a refused level. Icons (`activity`, `sliders-horizontal`, `folder-git-2`, `bug`,
`circle-check-big`, `triangle-alert`, `refresh-cw`, `trash-2`, `chevron-down`, `loader-circle`) are
extracted from the installed `lucide-react`, each with its provenance comment.

### GIVES / TAKES sweep

| Key            | GIVES / TAKES                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-5707** | **GIVES** the complete build spec: band placement, labels, hints, pending/failed-save, degraded-operable, the failure line and its placement, every `en`/`zh` string and key. **No TAKES** — its criteria already assign the surface and both locales. |
| **MOTIR-5706** | **GIVES** a visible consumer for all five DTO fields. **No TAKES:** the row needs nothing the card does not already expose.                                                                                                                            |
| **MOTIR-5703** | **GIVES** where its recorded failure is read. **No TAKES:** the gone comment stays its own, on the card.                                                                                                                                               |
| **MOTIR-5705** | **GIVES** the switch that gates it. **No TAKES:** its no-op notes are not drawn here.                                                                                                                                                                  |
| **MOTIR-5701** | **GIVES** a reader for both switches and the failure columns. **No TAKES.**                                                                                                                                                                            |
| **MOTIR-4932** | Nothing drawn. Named only to hold the scope boundary above.                                                                                                                                                                                            |

---

## §14 · The Errors section on the work-item page

_A NEW surface, drawn by MOTIR-5727 for Story MOTIR-4932 in
`design/monitoring/work-item-errors.mock.html`. It amends no earlier mock: §7, §12 and §13 each handed
this surface to MOTIR-4932 by name, and this section is where those hand-offs land. Built by
**MOTIR-5732** (the section, its door and picker, both confirmations, both locales), which is
`blocked_by` this card._

### What it composes — the Development card grammar with a different source

The Development section already answers _what outside this tree does this work item relate to_ for
pull requests, and people have learned it. The Errors section answers the same question for monitor
issues, so it is drawn as the same grammar and invents no second provenance idiom. Each piece below
was read from the shipped source and rendered from its real class strings with the real theme tokens
before the mock was drawn.

| Element                   | Shipped primitive it reuses                                                                                                                                                                 | Source                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The section               | `ContentSectionCard` — title, the muted `— gloss`, the `headerRight` door                                                                                                                   | `app/(authed)/items/[key]/_components/ContentSectionCard.tsx`                                                                |
| One row                   | the `PullRequestRow` row, class for class: bordered row on `--el-surface`, 17px muted glyph, 13.5px medium title over a 12px `--el-text-identifier` line, the pill group, the 16px out-link | `components/github/DevelopmentSection.tsx`                                                                                   |
| The door and the picker   | `DevelopmentLinkControl`'s door + inline form: the `AddLinkControl` / query-driven `Combobox` grammar through `useLinkCandidateSearch`, Link + Cancel, the rose typed-error banner          | `app/(authed)/items/[key]/_components/DevelopmentLinkControl.tsx` · `AddLinkControl.tsx` · `hooks/useLinkCandidateSearch.ts` |
| Remove, and both confirms | the `RemoveLinkButton` popover: a 24px × LAST in the row, a `Popover.Content` aligned to the trigger's edge, ghost Cancel + the action                                                      | `app/(authed)/items/[key]/_components/RemoveLinkButton.tsx`                                                                  |
| Level and linked chips    | `Pill` — `severity` for known levels, `tone="neutral"` for the rest and for **Linked to {key}** / **Linked here**                                                                           | `packages/design-system/src/components/ui/Pill.tsx`                                                                          |
| Loading                   | the shared `LateUpperFallback` / `SectionCardSkeleton`, **unchanged**                                                                                                                       | `app/(authed)/items/[key]/_components/LateSections.tsx`                                                                      |
| A failed read             | `ErrorState` with a retry, rendered inside the card body                                                                                                                                    | `packages/design-system/src/components/ui/ErrorState.tsx`                                                                    |
| The no-link door          | one row in the detail page's ⋯ menu — `WorkItemActionsMenu`'s `ITEM_CLASS` row, reached through `WorkItemDetailActions`                                                                     | `components/issues/actions/WorkItemActionsMenu.tsx` · `app/(authed)/items/[key]/_components/WorkItemDetailActions.tsx`       |

### The ACCESS PATH, and where the section sits

It is reached by opening a work item, and there is no other door. It sits in the page's **late upper
tier, directly below Development** (panel 1 draws the page with Development above it). It streams with
its neighbours inside the same `LateUpperSections` boundary, so it never blocks the page, and its read
joins `readLateSections` with that file's containment: a failed read is `null`, never a thrown page.

### Decision 1 · No link ⇒ no section, and the door for that case lives in the ⋯ menu

The story's criterion is that a work item with no link renders no panel and the page is unchanged.
The story's manual link is FOR exactly such a work item — a customer-reported bug that has never had
an error. A door that lives only in the section's header therefore cannot reach the case it exists
for. The two are reconciled like this:

- **With one or more links**, the door is **+ Link error**, header-right, where Development puts
  **+ Link pull request** (panels 1, 6a).
- **With no link**, there is no section, no heading and no empty state (panel 5a). The door is ONE row
  in the detail page's ⋯ menu, **Link an error**, placed after **Add to active sprint** (panel 5b).
  Choosing it mounts the section in its slot with the picker already open and a one-line body, **No
  errors linked to this work item yet.** (panel 5c). Cancel with nothing linked takes the section away
  again; a successful link keeps it, now with its row, and the menu row is no longer shown.
- **Both doors show under the same rule** (Decision 5). The row is added by the detail page's wrapper,
  so the shared menu other surfaces render (board cards, list rows) does not gain it.

**Why the menu and not an always-present empty section:** in a monitored project most members hold
`work_item:edit`, so an empty Errors card would appear on nearly every work item — stories, tasks and
epics included — to serve an act that happens occasionally. The ⋯ menu is where this page already keeps
the occasional actions on the work item itself, and it is where Jira keeps its _Link issue_ action.

### Decision 2 · Recurrence reads by WIDTH, not by a chart

Four events and forty thousand are different problems, so the count must be told apart at a glance.
It is drawn as **Seen `<count>` times**: the number at full precision with the locale's digit
grouping, in tabular figures, semibold `--el-text`, in a right-aligned slot of its own — so
**40,112** is visibly five digits against **4**. No compaction to "40k" (it hides the difference
between 40,112 and 40,999, which is the point of storing the count), no bar and no chart (charts are
out of scope). Rows are ordered **most recently seen first** — the order the read returns (MOTIR-5730).

### Decision 3 · The level pill, and a level Motir does not know

| Stored `level`   | Pill                                                       |
| ---------------- | ---------------------------------------------------------- |
| `fatal`, `error` | `severity="danger"` (`--el-tint-rose`, `--el-text-strong`) |
| `warning`        | `severity="warning"` (`--el-tint-peach`)                   |
| `info`           | `severity="info"` (`--el-tint-sky`)                        |
| `debug`          | `tone="neutral"`                                           |
| any other string | `tone="neutral"`, the string VERBATIM — never mapped       |
| `null`           | no pill                                                    |

The level vocabulary is `lib/monitors/levels.ts`'s, which deliberately lets an unrecognised value
through; mapping one to a plausible known level would hide a real value.

### Decision 4 · The already-linked chip names the key; the LINK to that work item is in the confirmation

The candidate linked to a different work item shows **Linked to `<KEY>`** where its level pill would
be — the shipped `github.development.linkedTo` chip. The key is text there, not a link: an
interactive element inside a `Combobox` option is an accessibility defect, and a click on the option
already has a meaning. The key IS a link in the move confirmation (panel 7), which is the moment the
reader decides whether to take the error off that work item.

### Decision 5 · Who sees the door

- **The rows** show to anyone who can read the work item (the read is gated like the rest of the page,
  MOTIR-5730).
- **The header door, the ⋯-menu row and the × on each row** show only to a reader holding
  `work_item:edit` on the work item's project **and** only when that project has at least one
  monitoring connection. Absent otherwise — never disabled (the shipped Development rule, design Q1/Q4
  in `design/github/design-notes.md`).
- **A project with no monitoring connection shows no door and no prompt to connect one** (panel 9).
  The Monitoring room is gated on `integration:manage` (§6), so a prompt would lead most readers to a
  refusal — the same reason §12 gives for not linking the other way. Such a project can also have no
  rows: a link is deleted with its connection.

### The state set is the checklist

| Panel | State                                                     | What it shows                                                                                                                                                                                                                                 | Defined by                         |
| ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1     | One link                                                  | Title (links out to the permalink, `target=_blank`) · identifier line `<org> / <project> · <environment> · <release>` · level pill · **Seen N times** · **last seen `<relative>`** (absolute on hover) · out-link · ×                         | MOTIR-5730, MOTIR-5576, MOTIR-5729 |
| 1     | `orgSlug` null                                            | The identifier line starts with the project slug alone                                                                                                                                                                                        | MOTIR-5730                         |
| 2     | Several links, two connections                            | One row each, most recently seen first; the connection leads each identifier line                                                                                                                                                             | MOTIR-5730                         |
| 2     | No environment / no release                               | That part of the identifier line is absent — never "unknown"                                                                                                                                                                                  | MOTIR-5729                         |
| 3     | `resolve_state` `null`                                    | Nothing extra                                                                                                                                                                                                                                 | MOTIR-5701                         |
| 3     | `pending`                                                 | Quiet line: `LoaderCircle` + **Resolving in Sentry…**                                                                                                                                                                                         | MOTIR-5703                         |
| 3     | `resolved`                                                | Quiet line: `CircleCheckBig` + **Resolved in Sentry by Motir `<relative resolved_by_motir_at>`**                                                                                                                                              | MOTIR-5703, MOTIR-5704             |
| 3     | `failed`                                                  | Filled warning line (`--el-warning-surface`, `TriangleAlert` on `--el-warning`): **Couldn't resolve this in Sentry:** `<resolve_error verbatim>` Tried `<relative resolve_attempted_at>` — Motir tries again at the next check.               | MOTIR-5703                         |
| 3     | `gone`                                                    | The row stays listed on `--el-surface-soft`, title in `--el-text-secondary` and NOT a link, no out-link (a spacer keeps the columns), quiet line with `CircleOff`: **Sentry no longer has this error.** Its facts are as they were last seen. | MOTIR-5703 (§13 hand-off)          |
| 4     | `assignee_sync_note` `team_assignee`                      | Quiet line, `UsersRound`: Assigned to a team in Sentry, so this work item's assignee was left as it is.                                                                                                                                       | MOTIR-5705 (§13 hand-off)          |
| 4     | `assignee_sync_note` `no_matching_member`                 | Quiet line, `UserRound`: Assigned in Sentry to someone who isn't a member here, so this work item's assignee was left as it is.                                                                                                               | MOTIR-5705 (§13 hand-off)          |
| 4     | Both a resolve line and an assignee note                  | Resolve line first, then the note                                                                                                                                                                                                             | —                                  |
| 5a    | No link                                                   | No section. The page is unchanged from today                                                                                                                                                                                                  | Story MOTIR-4932                   |
| 5b    | No link, editor, connected project                        | The ⋯ menu's **Link an error** row                                                                                                                                                                                                            | Decision 1                         |
| 5c    | The menu row chosen                                       | The section mounts below Development, picker open, body **No errors linked to this work item yet.**                                                                                                                                           | Decision 1                         |
| 6a    | The picker before typing                                  | The most recently seen issues (an empty query), placeholder **Search errors, or paste a short id…**                                                                                                                                           | MOTIR-5728, MOTIR-5731             |
| 6a    | Results                                                   | Option: title · `<org> / <project> · Seen N times · <relative last seen>` · level pill                                                                                                                                                        | MOTIR-5731                         |
| 6b    | Searching                                                 | The Combobox loading row, **Searching…**                                                                                                                                                                                                      | —                                  |
| 6b    | No results                                                | **No matching errors** + hint                                                                                                                                                                                                                 | —                                  |
| 6b    | One connection's search failed                            | A status line INSIDE the results, filled warning: **Couldn't search `<org> / <project>`:** `<reason verbatim>`; the other connections' candidates still listed below it                                                                       | MOTIR-5728, MOTIR-5731             |
| 6b    | A refused link (`issue_gone` · `not_found` · `forbidden`) | The rose banner under the list with that code's sentence (copy table)                                                                                                                                                                         | MOTIR-5731                         |
| 7     | A candidate linked to another work item                   | **Linked to `<KEY>`** chip in the pill slot; picking it and pressing Link opens the move confirmation                                                                                                                                         | MOTIR-5731                         |
| 7     | A candidate linked to THIS work item                      | **Linked here** chip; the option is disabled                                                                                                                                                                                                  | MOTIR-5731                         |
| 7     | The move confirmation                                     | Names the work item the link leaves (a link), says it keeps its other links and history; **Move link** re-sends with `move: true`; **Cancel** leaves both as they were                                                                        | MOTIR-5731                         |
| 8     | Unlink                                                    | The × (hover: `--el-tint-rose`, `--el-danger`) → 300px popover, consequence sentence, ghost Cancel + danger **Remove link**                                                                                                                   | MOTIR-5731                         |
| 8     | Unlink with nothing to remove (`removed: false`)          | The popover's error line: **There was nothing to unlink — the link had already been removed.**                                                                                                                                                | MOTIR-5731                         |
| 9     | A reader without `work_item:edit`                         | Rows in full; no door, no ×, no menu row; nothing else moves                                                                                                                                                                                  | Decision 5                         |
| 9     | A project with no monitoring connection                   | No door anywhere and no section                                                                                                                                                                                                               | Decision 5                         |
| 10    | Loading                                                   | The shared late-upper fallback, unchanged                                                                                                                                                                                                     | —                                  |
| 10    | A failed read                                             | `ErrorState` inside the card, with Try again (a page refresh); drawn only in a project that has a connection; Development and every later section unaffected                                                                                  | MOTIR-5730                         |

**Narrow widths** follow the shipped row: below a 30rem column the facts group (level, count, last
seen) drops to its own line under the title, indented past the glyph — the `@max-[30rem]` rule
`PullRequestRow` already carries. The resolve and assignee lines keep their indent.

### Copy — every new `en` string

Namespace `monitorErrors.*` in `messages/en.json` (and its `zh` twin, MOTIR-5732's), plus one key in
the shipped `workItemActions` namespace for the menu row. Counts use ICU plurals; relative times use the
formatter the Development section uses.

| Key                                   | `en`                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `monitorErrors.title`                 | Errors                                                                                                                       |
| `monitorErrors.gloss`                 | Linked Sentry errors · counts as of the last check                                                                           |
| `monitorErrors.seen`                  | `Seen <b>{count}</b> {count, plural, one {time} other {times}}`                                                              |
| `monitorErrors.lastSeen`              | last seen {when}                                                                                                             |
| `monitorErrors.openInSentry`          | Open in Sentry _(the out-link's `aria-label`)_                                                                               |
| `monitorErrors.resolve.pending`       | Resolving in Sentry…                                                                                                         |
| `monitorErrors.resolve.resolved`      | Resolved in Sentry by Motir {when}                                                                                           |
| `monitorErrors.resolve.failed`        | `<b>Couldn't resolve this in Sentry:</b> {reason} Tried {when} — Motir tries again at the next check.`                       |
| `monitorErrors.resolve.gone`          | `<b>Sentry no longer has this error.</b> Its facts are as they were last seen.`                                              |
| `monitorErrors.assignee.teamAssignee` | Assigned to a team in Sentry, so this work item's assignee was left as it is.                                                |
| `monitorErrors.assignee.noMatch`      | Assigned in Sentry to someone who isn't a member here, so this work item's assignee was left as it is.                       |
| `monitorErrors.link`                  | Link error                                                                                                                   |
| `workItemActions.linkError`           | Link an error                                                                                                                |
| `monitorErrors.empty`                 | No errors linked to this work item yet.                                                                                      |
| `monitorErrors.field`                 | Error to link                                                                                                                |
| `monitorErrors.searchPlaceholder`     | Search errors, or paste a short id…                                                                                          |
| `monitorErrors.searching`             | Searching…                                                                                                                   |
| `monitorErrors.noMatches`             | No matching errors                                                                                                           |
| `monitorErrors.noMatchesHint`         | Search words from the error's title, or paste its short id from Sentry.                                                      |
| `monitorErrors.searchFailed`          | `<b>Couldn't search {connection}:</b> {reason}`                                                                              |
| `monitorErrors.candidate`             | {connection} · Seen {count} {count, plural, one {time} other {times}} · {when}                                               |
| `monitorErrors.linkedTo`              | Linked to {key}                                                                                                              |
| `monitorErrors.linkedHere`            | Linked here                                                                                                                  |
| `monitorErrors.linkAction`            | Link                                                                                                                         |
| `monitorErrors.error.issueGone`       | Sentry no longer has this error, so it can't be linked.                                                                      |
| `monitorErrors.error.notFound`        | This error or work item is no longer available. Close the picker and try again.                                              |
| `monitorErrors.error.forbidden`       | You can't link errors on this work item.                                                                                     |
| `monitorErrors.move.title`            | Move this error's link from {key} to this work item?                                                                         |
| `monitorErrors.move.body`             | {key} keeps its other links and its history. From the next check, this error's count and resolve-back follow this work item. |
| `monitorErrors.move.action`           | Move link                                                                                                                    |
| `monitorErrors.unlink.aria`           | Remove the link to {title}                                                                                                   |
| `monitorErrors.unlink.confirm`        | Remove the link to {title}? If this error happens again, a new bug will be filed for it.                                     |
| `monitorErrors.unlink.action`         | Remove link                                                                                                                  |
| `monitorErrors.unlink.nothing`        | There was nothing to unlink — the link had already been removed.                                                             |
| `monitorErrors.loadFailedTitle`       | Couldn't load this work item's errors                                                                                        |
| `monitorErrors.loadFailedBody`        | The rest of the page is unaffected. Try again in a moment.                                                                   |

`{reason}` is the stored or returned provider reason VERBATIM — never worded or summarised (§4's
rule); `{title}` in the unlink strings is the error's title, rendered `font-mono` like the
Development confirm's target. **The unlink sentence is the consequence, not a warning for effect:**
deleting the link row makes the error exactly as untracked as one never ingested, so if it happens
again and qualifies under the connection's minimum level, the reconciler files a new bug
(MOTIR-5731 §3). Nothing is touched in Sentry. The product noun on every string is **work item**;
_card_ is not used.

### Tokens and icons

Colour only through `--el-*` (`--el-text*`, `--el-text-identifier`, `--el-surface*`, `--el-border*`,
`--el-link`, `--el-tint-rose|peach|sky|mint`, `--el-chip-*`, `--el-warning*`, `--el-danger`,
`--el-accent*`, `--el-icon-muted`); shape only through `--radius-*`, `--spacing-*`, `--height-*` and
`--shadow-*`. The mock's field label takes `--el-text-secondary`, not the shipped form's
`--el-text-eyebrow`, which is under AA on `--el-surface-soft`. Icons, each extracted from the installed
`lucide-react@1.16.0` with its provenance comment: `activity` (a row, a candidate and the menu row —
the monitoring area's glyph), `plus`, `x`, `external-link`, `triangle-alert`, `circle-check-big`,
`loader-circle`, `circle-alert`, `circle-off`, `user-round`, `users-round`, `search`, `ellipsis`, and
the menu frame's `pencil`, `goal`, `copy` plus Development's `git-merge`.

### Scope boundary

- **Not drawn:** a board column or filter for error-sourced bugs; a trend or chart of recurrence; a
  triage inbox; any change to the Monitoring room (§11–§13 stay its design of record); a link or unlink
  door for agents (no MCP / v1 surface in this story); the quick-view peek, which stays read-only as
  Development's does.
- **The ⋯-menu row belongs to the detail page only** (Decision 1).

### Workflow grounding

| Behaviour drawn                                                                       | Defining card          |
| ------------------------------------------------------------------------------------- | ---------------------- |
| The stored facts (title, level, count, first/last seen, permalink)                    | MOTIR-5576             |
| Environment and release, and a hand-linked issue below the minimum level refreshing   | MOTIR-5729             |
| The read, its order, its gate, and that it makes no provider call                     | MOTIR-5730             |
| Search, `linkedTo`, the refusal, the move, unlink and its consequence, the permission | MOTIR-5731             |
| The search's inputs (text and short id) and its per-connection failure                | MOTIR-5728             |
| The resolve-back states and the gone issue                                            | MOTIR-5703, MOTIR-5701 |
| The assignee notes                                                                    | MOTIR-5705             |

These are `relates_to` specifications, not build prerequisites: none of them builds before this card.

### GIVES / TAKES sweep

| Key            | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5732** | **GIVES** the whole build spec: placement, rows, every state, both doors, the picker, both confirmations, loading and error, the copy table. **TAKES** the ⋯-menu door: the detail page's `WorkItemDetailActions` passes one **Link an error** row (editor + connected project + no link), which mounts the section with the picker open (Decision 1). Amended onto the card. |
| **MOTIR-5734** | **GIVES** the states the walk checks. **TAKES** step 3's door: a customer-reported work item has no link, so it is linked from the ⋯ menu's **Link an error**, not from a **+ Link error** that is not on the page yet. Amended onto the card.                                                                                                                                |
| **MOTIR-5730** | **GIVES** a reader for every DTO field. **TAKES** one field: `resolve.attemptedAt` (`resolve_attempted_at`, ISO or `null`), which the failed line's **Tried `<when>`** reads. Amended onto the card.                                                                                                                                                                          |
| **MOTIR-5731** | **GIVES** the surface its codes and `linkedTo` render on. **No TAKES** — the candidate shape, the codes and `removed` already carry what the picker and the confirmations need.                                                                                                                                                                                               |
| **MOTIR-5728** | **GIVES** the placeholder that advertises the short-id lookup and the per-connection failure line. **No TAKES.**                                                                                                                                                                                                                                                              |
| **MOTIR-5729** | **GIVES** the environment · release rendering and its absent case. **No TAKES.**                                                                                                                                                                                                                                                                                              |
| **MOTIR-5733** | Nothing drawn. **No TAKES.**                                                                                                                                                                                                                                                                                                                                                  |
| **MOTIR-5701** | **GIVES** a reader for `resolve_state` and `assignee_sync_note`. **No TAKES.**                                                                                                                                                                                                                                                                                                |
| **MOTIR-5703** | **GIVES** the standing presentation of a gone issue that §13 handed here. **No TAKES** — its one-time comment stays its own.                                                                                                                                                                                                                                                  |
| **MOTIR-5704** | **GIVES** nothing new; a move leaves `resolved_by_motir_at` alone (MOTIR-5731), so the loop guard is untouched. **No TAKES.**                                                                                                                                                                                                                                                 |
| **MOTIR-5705** | **GIVES** where its two no-op notes are read. **No TAKES.**                                                                                                                                                                                                                                                                                                                   |
| **MOTIR-5576** | **GIVES** a reader for its stored facts. **No TAKES.**                                                                                                                                                                                                                                                                                                                        |
| **MOTIR-4932** | **GIVES** its panel. Its criterion _"a work item with no link renders no panel"_ holds; the one visible change on such a work item is Decision 1's ⋯-menu row for an editor in a monitored project, noted on the story.                                                                                                                                                       |
| **MOTIR-5727** | This is the producing design card, not a consumer allocation.                                                                                                                                                                                                                                                                                                                 |
