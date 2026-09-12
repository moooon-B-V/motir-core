# `design/monitoring/` — design notes

**One surface: the project-settings `Monitoring` room** — where a workspace connects the error
monitor its services already report to, binds one or more of that monitor's projects to this Motir
project, sees the connection's health, and disconnects one.

| Surface                                               | Asset                                                                                                       | Card                                                     | Sections |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- |
| **The `Monitoring` room** and its settings-rail entry | [`monitoring-room.mock.html`](./monitoring-room.mock.html) + [`monitoring-room.png`](./monitoring-room.png) | MOTIR-5256 (design) → **MOTIR-5262** (surface + locales) | §1–§7    |

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

| Panel | State                      | What it draws                                                                                                   |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **1** | `(none)`                   | The empty state: the muted mark, the serif title, ONE line saying what connecting does, one primary affordance. |
| **2** | `connected`                | One monitored project — the degenerate case of the set, with the grant header above it.                         |
| **3** | `connected` + `connecting` | Four rows at real-product scale, the last of them mid-return-leg.                                               |
| **4** | `degraded`                 | The provider's own reason, verbatim, with `Re-check` and `Reconnect`.                                           |
| **5** | the ACCESS PATH            | The rail entry that opens the room, drawn rather than described, plus the per-value state table.                |

---

## §3 · The state set is the checklist

The connection carries a lifecycle, and the room renders something different per value. All four are
drawn; none is left to the implementer.

| value        | what the row shows                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connecting` | The return leg is in flight. **The row EXISTS and is visibly not usable**, and carries no action at all — each would be a promise the server has not made. |
| `connected`  | The organisation and the bound projects, with when the credential was last checked. A filled success chip on the GRANT, not per row.                       |
| `degraded`   | The provider's OWN reason, verbatim, in a filled warning banner, with `Re-check` and `Reconnect`.                                                          |
| `(none)`     | The empty state carrying the connect affordance and one line saying what connecting does.                                                                  |

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
| `connecting` exists as a row state                                         | **MOTIR-5260** — the callback's return leg, and its four named non-happy statuses.                                                                            |
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
| Health values           | **Connected** · **Degraded** · **Connecting**                                                                                                                                           |
| Degraded banner         | **Sentry says:** `<the provider's own reason>` Motir cannot read this organisation's issues until somebody reconnects it — nothing new will reach the board in the meantime.            |
| Grant actions           | **Re-check** · **Reconnect**                                                                                                                                                            |
| Row actions             | **Open in Sentry** · (icon) disconnect                                                                                                                                                  |
| Add affordance          | **Add a monitored project**                                                                                                                                                             |
| Row sub-line            | Bound `<when>` · N issues seen — or, while connecting, _Waiting for Sentry to confirm the install_                                                                                      |

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
