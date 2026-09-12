# `work_item.subject` has no write door, and does not need one

**Status:** accepted · **MOTIR-5209** (Story MOTIR-5062 · MOTIR-5065 added the axis)

## Context

`subject` is the fourth coordinate of the planning-rule selector,
`pack(phase, kind, type, subject)`. A proposal carries it (`add_plan_items`,
`proposedFields.subject`), a correction can re-pin it before approve
(`update_plan_proposal`), and approving the plan copies it onto the created row
(`lib/services/plansService.ts`, beside the three planning-provenance columns).

There is no door onto an existing record. `update_work_item` refuses the
argument, `create_work_item` does not accept it, and `PLAN_ITEM_PATCH_KEYS` —
the declared set a `modify` proposal may patch — does not carry it either, even
though it carries `type`, the field `subject` is derived beside.

That was read as a gap. A disposition pass over the captured-mistake home
(MOTIR-5064, since cancelled) wanted to route existing records onto the axis and
could not set the field on any of them, and asked for one of: a narrow
`set_work_item_subject` tool, or `subject` added to `update_work_item`.

`prisma/schema.prisma` already argued the opposite posture at `work_item.subject`
— that it belongs with `planningHarness` / `planningModel` because it is "the
same KIND of fact: a record of how this card came to be planned, not a property
of the work", and is therefore "read-only wherever it appears".

## Decision

**No write door. `subject` is derived once, at `lay`, through the plan path, and
is read-only on a committed work item — where its only job is to be displayed.**

Neither proposed tool ships. `PLAN_ITEM_PATCH_KEYS` does not gain the key either.

### Why — the column's consumers are all upstream of the work item

The schema comment reaches the right answer on the weaker of the two available
arguments. Its stated reason — same kind of fact as the provenance columns —
does not survive the one test that separates the two: the provenance columns are
**stamped server-side** and `add_plan_items` does not accept them as arguments,
while `subject` is an **authored** field the caller supplies and may correct.
On that test `subject` groups with `type` and the repo pin, not with
`planningHarness`.

The load-bearing reason is consumption. `subject` has exactly two readers, and
both run inside a planning job, reading it **from the plan payload**:

| reader                                                    | phase    | source           |
| --------------------------------------------------------- | -------- | ---------------- |
| rule-pack resolution — `pack(phase, kind, type, subject)` | `lay`    | the proposal     |
| lesson-query narrowing (`plannerInputs.ts`, MOTIR-5080)   | `author` | the plan payload |

Nothing reads `work_item.subject` off a committed row. The single consumer of
the column is `ProvenanceSection`, which renders it read-only in the item rail.

So a write door would edit a value **no selector will ever re-read**. The
re-routing it appears to offer is an illusion: by the time a work item exists,
the selection the coordinate names has already been made and spent. The field
would look authoritative and do nothing — which is worse than the present
refusal, because the present refusal is legible.

### Why the `modify` patch is refused for the same reason

`PLAN_ITEM_PATCH_KEYS` is the near-miss: a `modify` reaches the review gate, so
a re-subject there would at least be audited. It is still wrong, and for the
reason above rather than a procedural one — a `modify` patches a **committed
card**, and that card's rule packs were composed at its `lay`. Patching the
coordinate afterwards records a selection that never happened.

This is the same shape as `todos`, which is `add`-only by an earlier decision
(`agent-authored-plans.md` AMENDMENT 14 D2) because a committed list carries a
person's progress. The two fields are refused for different reasons — progress
there, spentness here — and both refusals are about what the committed value
means, not about who is allowed to write it.

## Consequences

- **Re-routing an existing card is a re-plan**, not an edit. A card laid before
  the axis existed keeps `subject = null`, and `null` correctly means "no
  coordinate was recorded at lay", rather than "nobody has got round to it".
- **A card created outside a plan can never carry one**, because it was never
  laid. `create_work_item` staying closed is correct, not an oversight.
- **A mis-derived subject is correctable only while the plan is open**, through
  `update_plan_proposal`. After approve it is history. This is the cost, and it
  is bounded by the fact that the wrong value has already done whatever harm it
  was going to do to that card's composition.
- **A disposition pass routes in its own table**, not in this column. The column
  is not a routing surface for work performed later.
