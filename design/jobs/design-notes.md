# Design notes — Job runs (`/settings/workspace/jobs`)

The operator surface for this workspace's background jobs. **This area had no
design asset until MOTIR-3514**; the page shipped in Story 1.6 and was drawn by
nobody. The gate fired because a sibling card needs to add one column to it, and
a column cannot be built against a mockup that does not exist.

## Surfaces in this area

| Surface                     | Source                     | Export               | What it covers                                                                                                                     |
| --------------------------- | -------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Delivery state              | `delivery-state.mock.html` | `delivery-state.png` | The Recent-runs table gaining a **Delivery** column; the five delivery values and the no-row case; the row detail; the access path |
| _(evidence, not a surface)_ | —                          | `_shipped-today.png` | The live page photographed **before** anything here was drawn                                                                      |

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
