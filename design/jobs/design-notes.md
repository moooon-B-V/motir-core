# Design notes — Job runs (`/settings/workspace/jobs`)

The operator surface for this workspace's background jobs. **This area had no
design asset until MOTIR-3514**; the page shipped in Story 1.6 and was drawn by
nobody. The gate fired because a sibling card needs to add one column to it, and
a column cannot be built against a mockup that does not exist.

## Surfaces in this area

| Surface                     | Source                          | Export                          | What it covers                                                                                                                                                                                         |
| --------------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivery state              | `delivery-state.mock.html`      | `delivery-state.png`            | The Recent-runs table gaining a **Delivery** column; the five delivery values and the no-row case; the row detail; the access path                                                                     |
| System dead letters         | `system-dead-letters.mock.html` | _(none — retired, AMENDMENT 4)_ | The System tab gaining a section of dead letters with no workspace, above System runs; the Replay control's states and outcomes; where it is absent; empty and loading; both access doors (MOTIR-8084) |
| _(evidence, not a surface)_ | —                               | `_shipped-today.png`            | The live page photographed **before** anything here was drawn                                                                                                                                          |

`_shipped-today.png` is a render of the running app, not a mock. It is committed
because the design-against-shipped-reality rule asks for it and because it is the
argument for the change: four `email.send` runs, all reading `succeeded`, at least
one of which did not arrive. A reader who wants to know what this asset changed
should open it first.

## Why this asset exists

`job_run` records whether the SEND succeeded. For a real provider that means one
thing only: **the provider accepted the POST**. It says nothing about whether the
message was delivered, and `succeeded` beside a bounced invitation is what hid
MOTIR-3507 for a day — a workspace invitation sat in a NetEase
spam folder and was found by a person opening the folder, because nothing in the
system could have reported it.

The only asset that had ever named this page is
`design/platform-admin/design-notes.md`, which tells the estate console **"Do NOT
fork the existing jobs surface"** and points here. That is a DOOR. A door is
evidence the room is required, not evidence it is drawn — so the design gate
fired rather than treating the mention as coverage.

## What it composes from

Built from the SHIPPED component's own markup, not an approximation of it —
`app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx`:

| Element                | Shipped source                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Table shell            | `TableShell` — `overflow-x-auto rounded-(--radius-card) border border-(--el-border)` |
| Header cells           | `Th` — `px-3 py-2 text-left text-xs font-semibold text-(--el-text-muted)`            |
| Body cells             | `Td` — `px-3 py-2 align-middle text-sm text-(--el-text)`                             |
| Row                    | `border-b border-(--el-border) last:border-0 hover:bg-(--el-surface)`                |
| Status / Delivery chip | `Pill` (`@motir/design-system`) — hue in the TINT, `--el-text-strong` ink            |
| Tab strip              | `TabStrip` — `Recent runs` / `Dead letter` / `System` (owner-gated)                  |
| Status filter          | `StatusFilter` — URL-driven pills over `JobRunStatus`                                |
| Function / Event       | `font-mono text-xs`                                                                  |
| Attempts / Duration    | `text-right tabular-nums`                                                            |

## The Delivery column

**Its own column, immediately right of Status. Never a second pill inside the
Status cell.** The two answer different questions — Status is _did our job run_,
Delivery is _did the message arrive_ — and the whole reason this asset exists is
that a run can succeed while its message bounces. Two chips in one cell would
read as one fact with two moods.

A row with no delivery record shows `—`, which is the em-dash this table already
uses in Failure and Duration. So the column costs a reader nothing on the rows it
does not apply to, and needs no "n/a" vocabulary of its own.

### Every value, and the token it takes

Per gate 9, the enum IS the checklist — each value is drawn in Panel 3, and each
is the `Pill` primitive with no new component:

| Value        | Variant              | Token                                  | Why                                                                                                                                                                                                       |
| ------------ | -------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`   | `tone="neutral"`     | `--el-chip-bg` / `--el-text-secondary` | The provider took it and has said nothing since. **Deliberately not green:** it is the absence of news, not good news, and colouring it as success would restate the exact lie this column exists to end. |
| `delayed`    | `severity="info"`    | `--el-tint-sky`                        | Deferred, still being retried. Not a failure; not yet an arrival.                                                                                                                                         |
| `delivered`  | `severity="success"` | `--el-tint-mint`                       | The receiving server accepted it.                                                                                                                                                                         |
| `bounced`    | `severity="danger"`  | `--el-tint-rose`                       | Refused — nobody received it.                                                                                                                                                                             |
| `complained` | `severity="warning"` | `--el-tint-peach`                      | A person marked it as spam. Peach rather than rose because it _arrived and was read_: the damage is to sender reputation, not to this message.                                                            |
| _(no row)_   | —                    | `--el-text-secondary`                  | Not `email.send`, a send predating the record, or a send the provider refused outright — whose Status is already `failed`.                                                                                |

**⚠️ `delivered` does not mean "in the inbox".** A spam-foldered message is
`delivered`, and no value in this enum can say otherwise, because the provider
cannot see the recipient's folders. That is why MOTIR-3516 exists as a separate
human card and why nothing on this surface should be read as answering it.

## Ink and contrast

Every chip carries its hue in the BACKGROUND with `--el-text-strong` ink — the
recipe that clears AA in both themes. The board's own annotations use
`--el-text-secondary` (6.18–6.80:1 on all four surfaces), never
`--el-text-muted`, which clears AA on the white page alone and would fail on the
`--el-surface` panels this board paints on. The `—` in an empty Delivery cell is
`--el-text-secondary` for the same reason.

The dark-theme block overrides all six tints, including peach, rose and yellow —
the neighbouring `design/estimation` mock omits three of them, which is a latent
contrast bug in that asset rather than a convention to copy.

## What this asset decides AGAINST

**Delivery is not a filter in this revision.** The existing filter row segments by
run status, and a second pill group in the same row would mix two dimensions in
one control — precisely the confusion the separate column exists to avoid. The
operator's path to a bounced message is the Delivery column on the default _All_
view; a message that bounced has a `succeeded` run, so the existing _Failed_
filter would never have surfaced it either way.

This is a decision, not a deferral: at the volumes this surface holds, a column
you can see beats a filter you must think to apply. **If the ledger grows to where
scanning stops working, a delivery filter is its own card** — and it would come
with a decision about whether the two filter groups stack or merge, which is more
design than a column warranted.

## Access path

Settings → Workspace → **Job runs** (Panel 5). The door is an existing sidebar
entry and this change adds none; it is drawn because a design that does not show
its own entrance leaves the reader trusting a route string.

## Gives and takes

- **GIVES to MOTIR-3517** (the jobs-dashboard code card): the column position,
  the per-value tone map, the no-row treatment, and the row-detail block. That
  card builds to this asset and re-decides none of it.
- **GIVES to MOTIR-3515** (the delivery webhook): nothing structural — but the
  five values drawn here are the same enum it writes into, and it adds no sixth.
- **TAKES from MOTIR-3513**: the `EmailDelivery` record and its state enum. This
  asset draws that enum and does not extend it.
- **AGREES WITH** `design/platform-admin/design-notes.md`, whose estate console
  renders the same job data one tier up. Its _Recent jobs_ / _Failed jobs_
  vocabulary and health-tile tones are the language this surface stays inside, so
  an operator learns one system rather than two.

---

## System dead letters — the System tab's dead letters with no workspace (MOTIR-8084)

**Amends:** § _Surfaces in this area_ and the System tab as `delivery-state.mock.html`
(MOTIR-3514) leaves it, which draws the tab strip but never opens **System**. The
shipped System tab lists job RUNS only (`listSystemRuns`,
`lib/services/jobsDashboardService.ts`). **Delta mock:** `system-dead-letters.mock.html`.
`delivery-state.mock.html` is a record and is not edited.

**Design system** (read, not assumed): `package.json` depends on `@motir/design-system`
(`workspace:*`, `packages/design-system` **0.13.0**) AND `app/globals.css` imports
`@motir/design-system/theme.css` → **on Motir Design (branch a)**. The project's axes are
applied per user from the persisted appearance in `app/layout.tsx` (`data-style` /
`data-palette` / `data-type`); the mock renders the base axes, as this area's base does.
The package exports `@motir/design-system/mock` (`renderMock`), and it is NOT used: the
delta copies `delivery-state.mock.html`'s token block and its tab / filter / table / pill
rules byte for byte, so it composes from exactly what the base already reviewed (the
choice `design/billing/design-notes.md` and `design/auth/design-notes.md` record for
their deltas). It adds the five tokens the base predates, at `theme.css`'s own values:
`--el-button-border` (over `--color-hairline-strong`), `--el-icon-muted`,
`--el-text-subtitle`, `--height-btn-sm`, `--spacing-icon-btn`. The `Button` (sm ·
secondary · ghost · loading), `Toast`, `EmptyState` and `Spinner` rules are the
package's own recipes (`packages/design-system/src/components/ui/*.tsx`). Every part
this surface needs exists in the package or in `JobsDashboard.tsx`; **no proposed
addition and no product-local component.**

**What was read for shipped reality**, at `origin/main` `851b2a7d0`:
`app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx` (`TabStrip`,
`StatusFilter`, `DlqTable`, `Pagination`, `JobsDashboard`), `JobsPane.tsx`
(`parseJobsParams`), `page.tsx` (the tier gate, the `PLATFORM_ADMIN_EMAIL` gate, the
`SettingsPaneFrame` fallback), `app/(authed)/settings/organization/_components/JobRunsFoldInSection.tsx`,
`lib/services/jobsDashboardService.ts` (`listSystemRuns`, `replayDLQ`), `lib/dto/jobs.ts`
and `messages/en.json` § `settings.jobs`. Copy below is the shipped English catalog
unless marked **NEW**.

**⚠️ No `.png` export, although the card's first criterion names one.** `motir-core`
retired the export (`CLAUDE.md` § _Design assets_, `docs/decisions/design-result.md`
AMENDMENT 4), and the dispatch prompt for this card says the same ("no screenshot
export"). The mock renders on the card; an export would be a second copy of it. The
asset is the mock plus this section.

### The audience and the gate

One person: the operator who disposes of standing dead letters by `docs/jobs.md`
§ _Disposing of a standing dead letter_. **The gate is `PLATFORM_ADMIN_EMAIL`**, the
System tab's existing gate (`page.tsx`; the same comparison in `JobRunsFoldInSection`),
**not workspace ownership or the Manager role.** A workspace Manager who is not that
operator never sees this section, because the tab itself is not in their strip.

### Placement — a section ABOVE System runs (Panel 1)

The System tab becomes two stacked sections, each with its own `h3`:

1. **Dead letters with no workspace**, first.
2. **System runs**, the shipped runs table, unchanged.

**Why first:** these rows are the only thing on the tab an operator can act on, and a
standing one is a chore owed (the standing-depth filer turns each into a bug). Runs are
history; dead letters are a queue.

**Why a section and not a fourth tab:** a fourth tab would put workspace-less dead
letters beside the workspace's own **Dead letter** tab under nearly the same name, and
a non-operator would see a strip whose meaning changes with who is looking. Keeping it
inside **System** keeps the one gate and the one place an operator already goes.

**The status filter and the pager belong to the runs section.** Today both sit at the
top and foot of the whole tab and both act on runs. With two objects on the tab they
move into **System runs**' header (filter, right-aligned beside its title) and foot
(pager). A run status means nothing for a dead letter, and one control spanning both
would mix two dimensions, which this file's _What this asset decides AGAINST_ already
refuses. **Refresh** stays in the tab's top row and refreshes both.

**The dead-letter section has no filter and no pager.** It lists every row with
`workspace_id IS NULL` that has NOT been replayed, plus rows replayed in the last
**7 days**, unreplayed first, then newest `last_failed_at` first. The standing-depth
filer keeps the unreplayed set small, and the 7-day tail is long enough to confirm a
replay landed. A summary line under the title states both counts:
`{waiting} waiting to be replayed · {replayed} replayed in the last 7 days`
(**NEW** `jobs.systemDlqSummary`). The list must never read as more runs: it has its own
heading, its own columns and its own action.

### Columns (Panel 1)

`DlqTable`'s seven, as shipped, with the same cell classes:

| Column       | Cell                                                                 |
| ------------ | -------------------------------------------------------------------- |
| Function     | `font-mono text-xs`                                                  |
| Event        | `font-mono text-xs`                                                  |
| Attempts     | `text-right tabular-nums`                                            |
| First failed | `whitespace-nowrap`, `formatDateTime`                                |
| Last failed  | `whitespace-nowrap`, `formatDateTime`                                |
| Replayed     | `whitespace-nowrap text-(--el-text-secondary)`; `—` when null        |
| Actions      | right-aligned: **View** (`Button` ghost sm) + **Replay** (see below) |

The header is `thead bg-(--el-surface)` with `Th` in `--el-text-secondary` (MOTIR-3523).
**View** opens the shipped dead-letter detail `Modal` (failure JSON + event payload),
unchanged. No new column.

### The Replay control — every state (Panels 2–3)

| State                 | Drawn as                                                                                                   | Copy                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| idle                  | `Button variant="secondary" size="sm"`, `RotateCcw` left icon, `--el-button-border` outline                | `jobs.replay` — "Replay"                                                                                                                                                  |
| replaying             | the same button with `loading`: `Spinner` replaces the glyph, `aria-busy`, disabled. **Only that row.**    | —                                                                                                                                                                         |
| replayed              | `Toast` `success` (border + glyph `--el-success`), then `router.refresh()`                                 | `jobs.replayedToastTitle` / `jobs.replayedToastDesc`                                                                                                                      |
| already-replayed      | `Toast` `info` (`--el-info`), then refresh. A double click or a stale page (MOTIR-3730, `alreadyReplayed`) | `jobs.alreadyReplayedToastTitle` / `jobs.alreadyReplayedToastDesc`                                                                                                        |
| error — workspace row | `Toast` `error` (`--el-danger`); the row is left as it was                                                 | `jobs.replayErrorTitle` + **NEW** `errors.actions.systemReplayWorkspaceRow`: "That dead letter belongs to a workspace — replay it from that workspace's Dead letter tab." |
| error — gone          | `Toast` `error`; the row was deleted meanwhile                                                             | `jobs.replayErrorTitle` + `errors.actions.dlqGone` (existing): "That dead-letter entry no longer exists."                                                                 |

The workspace-row refusal is MOTIR-8083's criterion 2 made visible: the system door
refuses a row that has a workspace, and the copy sends the operator to the door that
takes it. A non-operator cannot reach the control at all, so no "only an operator can
replay" copy is drawn.

Toast descriptions are drawn in `--el-text-secondary`. The shipped `Toast` uses
`--el-text-muted` on `--el-page-bg`, which clears AA there by 0.04; this asset draws
the target that clears comfortably, and does not change the primitive.

### Where the control is ABSENT (Panel 4)

Each is derived from a refusal the server makes:

| State                      | What renders                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Non-operator**           | No **System** tab in the strip (`TabStrip` pushes `system` only when `showSystemTab`), and `?tab=system` falls back to **Recent runs** (`parseJobsParams(sp, showSystemTab)`). Nothing hints the rows exist.                             |
| **A row already replayed** | Replayed time shown, **Replay absent**, View kept, row ink `--el-text-secondary`. ⚠️ **A deliberate DEVIATION from the workspace Dead letter tab**, which keeps Replay enabled on a replayed row (see below).                            |
| **A row with a workspace** | **Never in this list** — it is defined by `workspace_id IS NULL`, so there is no row to draw, disabled or otherwise. It lives on that workspace's **Dead letter** tab behind the manager-gated Replay. Do not add a disabled row for it. |

**Why the replayed row loses its control here and not on the workspace tab:** a replay
re-emits with the `:replay:<dlqId>` key, so a second press can only ever answer
already-replayed (MOTIR-3730). The button invites an action that cannot do anything.
On this tab the rows that remain are the replayed tail kept for confirmation, and a live
button there reads as "still owed". The workspace tab is **unchanged**; whether it
should follow is its own card, not this one. The already-replayed toast stays a real
state, because a stale page still shows the button.

### Empty and loading (Panel 5)

- **Empty**: the dead-letter section's table is replaced by `EmptyState` (Card, `Inbox`
  icon in `--el-icon-muted`, serif title, `--el-text-subtitle` description), under the
  section's own heading. The **System runs** section beneath is unaffected. Copy is its
  own, because the Dead letter tab's says "the dead-letter queue", which reads as the
  workspace's: **NEW** `jobs.systemDlqEmptyTitle` — "No system dead letters";
  **NEW** `jobs.systemDlqEmptyDesc` — "Every job without a workspace has succeeded or is
  still retrying."
- **Loading**: the page's `<Suspense fallback={<SettingsPaneFrame />}>`, below the real
  header, which is painted from the gate. The System tab adds no frame of its own; only
  the pane card pulses (`--el-muted` blocks, `--radius-control`).

### Access path — two doors to one pane (Panel 6)

Both render the same `JobsPane` with the same `PLATFORM_ADMIN_EMAIL` comparison, so the
section appears identically behind either. **Neither door is new.**

1. **Settings → Workspace → Job runs → System** — `/settings/workspace/jobs?tab=system`,
   sidebar group _Operations_ › **Job runs**. This route exists only above the
   workspace-tier reveal; below it `resolveWorkspaceTierDisclosure` answers `notFound()`.
2. **Settings → Organisation → the _Job runs_ section → System** — `/settings/organization`,
   `JobRunsFoldInSection` ("Job runs" / "Background work for this workspace — what ran,
   what failed, and what is waiting in the dead-letter queue."), below the reveal.

### Tokens

Colour through `--el-*` only and shape through the element shape tokens, exactly as the
base: tabs and filters as the base; `Button` `--radius-btn` / `--height-btn-sm` /
`--el-button-border`; `Toast` `--radius-card` / `--shadow-card` with the hue in the
border; `EmptyState` `--radius-card` / `--spacing-card-padding`; skeleton blocks
`--radius-control` / `--el-muted`. The spinner is the one `9999px` radius — circular by
nature. Board annotations use `--el-text-secondary`, never `--el-text-muted`, because
they sit on `--el-surface`.

### Gives and takes

- **GIVES to MOTIR-8083** (the operator replay): the placement (a section above System
  runs, filter and pager moved into the runs section), the seven columns, the list's
  definition (unreplayed plus 7 days replayed, unreplayed first) and its summary line,
  every Replay state and its copy, the three absent states, the empty and loading
  states, the two doors, and the three **NEW** catalog keys
  (`jobs.systemDlqSummary`, `jobs.systemDlqEmptyTitle` / `jobs.systemDlqEmptyDesc`,
  `errors.actions.systemReplayWorkspaceRow`). That card builds to this asset and
  re-decides none of it.
- **TAKES from** nothing.
- **AGREES WITH** MOTIR-3514's asset set (`delivery-state.mock.html` and the sections
  above): the same tab strip, `TableShell` / `Th` / `Td`, `Pill` recipe and token block,
  and its refusal to mix two dimensions in one filter.
