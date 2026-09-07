# ADR: The internal-billing classification — `Organization.internalBilling`, the paired offset, and the boundary against Epic 10

- **Status:** Accepted (2026-09-05)
- **Story / Subtask:** Story **MOTIR-4337** (an internal org bills like a customer and pays
  nothing) · Subtask **MOTIR-4563** (this record)
- **Supersedes / superseded by:** none. It **quotes** `code-graph-index-fleet.md` §9.1 and amends
  nothing in it.
- **Consumed by:** see the [`## Consumed by`](#consumed-by) list at the end — twelve sibling
  subtasks across two repositories build against this record.

> Structured **Status → Context → Decision → Consequences**, the shape
> `platform-staff-auth.md`, `billing-tiering.md` and `ci-minutes-allowance.md` set, with the
> load-bearing splits pinned in explicit tables so twelve subtasks in two repositories implement
> against one authoritative source.

> **This record ships no code.** No column, no migration, no service, no policy SQL and no UI
> change lands with it; every one of those is a sibling subtask named below. What it fixes is the
> shape those subtasks agree on, before the first of them is built.

---

## Context

### What ships today, and why it is exactly wrong for this story

`Organization.isMeta` exists and its schema comment states its shipped meaning:

> The internal dogfood org (moooon B.V.) — the META org. Resolves to the `meta` entitlement tier
> (every §4 cap lifted) and disables the AI paywall. DISTINCT from the future commercial
> `enterprise` tier: `meta` is never billed and is excluded from revenue … The §4 cap reader
> (`entitlementsService`) and the 8.1.8 AI paywall (`billingService.getAiAccess`) consume it; it is
> also propagated to motir-ai on the job-submit envelope so the AI credit gate honours it too.

It is a **suppression** flag, and the suppression reaches the UI: `BillingClient.tsx` opens
`if (data.isMeta) {` and `OrgUsageClient.tsx` branches on it in five places. So the one org used
every day is the only org that cannot see the product's billing and usage surfaces the way a
paying customer sees them — the balance hero, the allotment line, the low-balance panel and the
out-of-credits panel are precisely the states `isMeta` switches off.

It also cannot be set from anywhere. The flag is written by the
`20260623000000_add_organization_is_meta` data-flip migration
(`UPDATE "organization" SET "isMeta" = true WHERE "slug" = 'moooon'`) plus the dev seed. A second
internal org today means writing another migration.

### The ledger already carries the mechanism

`motir-ai` `src/creditKinds.ts` pins a **frozen** `CREDIT_TRANSACTION_KINDS` vocabulary — three
debit kinds (`debit`, `ci_overage`, `search`) and three credit kinds (`top_up`, `grant`,
`adjustment`) — with `tests/contract.test.ts` asserting the set exactly, so _"a new kind cannot be
added silently, and lands with its doc row in the same PR."_ `CreditTransaction.credits` is a
signed `Int`, `balanceAfter` is written on every row (self-auditing), `externalRef` is a globally
unique idempotency hook namespaced `<kind>:<token>` by `externalRefFor`, and every balance mutation
already runs inside `client.$transaction` after `creditRepository.lockLedgerByOrg`'s
`SELECT … FOR UPDATE` on the org's ledger row.

So the shape this story needs is not a subsystem. It is the GitHub public-repo invoice: the line
says $999, the discount says −$999, the invoice says $0, and **every number in between is real**.

---

## Decision

### 1. Two flags, two meanings, and `isMeta` gains no third one

| flag                           | means                                                                                | who reads it today                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `Organization.isMeta`          | **Motir's own COGS**: every §4 cap lifted, the AI paywall off, excluded from revenue | `entitlementsService`, `billingService.getAiAccess`, the job-submit envelope, `ciAllowanceService`'s bypass |
| `Organization.internalBilling` | **this org is charged exactly like a customer, and is then made whole**              | the offset path (motir-ai), the billing / usage surfaces, revenue reporting                                 |

**A NEW column beside `isMeta`, not a re-purposing of it.** `isMeta` keeps the meaning quoted
above and acquires nothing. The reason is recorded, in this repository, in
`docs/decisions/code-graph-index-fleet.md` §9.1, and it is quoted here verbatim because it predicts
exactly the failure a re-purposing would be:

> **`isMeta` is a BILLING flag that has been used as a proxy for "this workload is not real."**
> That proxy was safe while meta ran nothing on shared infrastructure. **It stops being safe the
> moment meta shares infrastructure with customers** — which is what decision 7 does.
>
> **Every `isMeta` branch should be read as _"should this be un-charged?"_ — never as _"should
> this be un-measured?"_ or _"should this run somewhere else?"_**

That flag already carries two meanings. Adding _"bills like a customer and is then made whole"_ as
a third would silently change the answer for the §4 cap reader, the 8.1.8 AI paywall, the
job-submit envelope and the fleet ADR's own charge bypass — four consumers that were written
against the first two meanings and would not be re-read. The two flags will be true together on
exactly one org today (`moooon`), and that coincidence is not identity: a future internal org that
should bill-and-be-offset without having its caps lifted is expressible under two flags and is not
under one.

**Both flags are `Boolean @default(false)` on `Organization`, and neither implies the other.**

### 2. The offset is written INSIDE the debit's own transaction, under the same ledger row lock

**The decision:** for an org classified `internalBilling`, every debit that lands writes a second,
positive `internal_offset` row of equal magnitude **in the same `$transaction`, after the same
`lockLedgerByOrg` `FOR UPDATE` on that org's ledger row**, and the ledger balance is updated once,
to the netted value. Two `CreditTransaction` rows, one balance mutation, one lock, one transaction.

The `internal_offset` kind joins the frozen `CREDIT_TRANSACTION_KINDS` set with its
`docs/credit-model.md` row **in the same pull request**, because `tests/contract.test.ts` forces
the two together. That friction is the right friction for a billing vocabulary and is why the kind
is named here rather than left to the implementing card to invent.

**REJECTED: post the credit afterwards** — a second call, a follow-up job, a nightly reconciliation.
The reason is not tidiness. Between the debit and the credit the org's balance is genuinely
negative, and `debitForTurn` / the external-debit path both apply a debit that crosses zero **in
full** and report exhaustion to motir-core's dispatch gate. So a window of negative balance is a
window in which the org is out of credits by the product's own reckoning — and closing it would
need a SECOND gate bypass keyed on the new flag, which is `isMeta`'s suppression rebuilt one layer
down and is the exact defect this story exists to remove.

**Paired-in-one-transaction makes _"the org is never blocked"_ structural rather than defended.**
The balance never moves, so no refusal valve is ever reached: there is nothing to bypass, because
nothing is ever refused. A test asserting the org keeps working is then confirming a property of
the write, not of a second gate.

Three ledger facts this rests on, each verified against `origin/main` rather than assumed:

- `CreditTransaction.credits` is **signed** (`Int`), so an offset is an ordinary row and needs no
  new column;
- `balanceAfter` is written per row and is **self-auditing** — the pair reads `−N` then `+N` with
  `balanceAfter` returning to its starting value, which is the audit trail;
- `externalRef` is **globally unique** and namespaced `<kind>:<token>`, so the offset is idempotent
  on the debit it offsets and a redelivered charge cannot double-offset.

### 3. Both sides stay VISIBLE — a constraint, not a nicety

**Every surface that lists ledger rows lists both the debit and its offset.** No surface nets them
into a single line, hides the offset behind a toggle, or suppresses the debit because it was made
whole.

This is stated as a constraint because the failure mode is one step from the fix: an offset that
hid its own debit would be `isMeta`'s suppression with more machinery — the same invisible second
code path, now with a ledger table behind it. The whole point of the classification is that the
run log, the per-model breakdown, the CI line and search spend render with **real** numbers for the
org that uses the product most.

### 4. What the classification does NOT do

- **It changes no rate.** Debits are computed identically for an internal org — same
  `ModelCreditRate` lookup, same lane, same `creditsForTurn`. There is no branch in the metering
  path.
- **It touches no Stripe object.** No subscription, no invoice, no checkout. The offset is a ledger
  entry, and `credit-model.md` §5's Epic-8 boundary stands.
- **It lifts no cap and grants no entitlement.** Caps and the AI paywall stay `isMeta`'s job. An
  org that should be uncapped is `isMeta`; an org that should bill-and-be-offset is
  `internalBilling`; an org that should be both carries both.
- **It does not re-point the CI bypass.** `ciAllowanceService`'s meta bypass stays keyed on
  `isMeta` — `ci-minutes-allowance.md` §4.4 records that _"moooon B.V. pays its own GitHub bill
  directly; metering it would bill the house to itself"_, and charging a CI minute Motir never paid
  for and then offsetting it would put an invented figure on the very screen this story exists to
  make honest. What changes is only that the CI **line stops being hidden** and renders whatever
  `ciAllowanceService` returns, which for a meta org is `bypassed`.
- **It does not re-open `isMeta`'s COGS role.** `code-graph-index-fleet.md` §9's Decision 8 —
  `isMeta` bypasses the CHARGE, not the PLACEMENT and not the METER — is untouched, and the
  indexing story owns any change to it.
- **It builds no governance console.** One control, in the shipped `app/(admin)/` shell — see §5.

### 5. The Epic-10 boundary, per card

Three Epic-10 cards have overlapping claims on this territory. None of them is wrong, and none was
authored knowing this story would exist, so the split is stated here rather than discovered by
whichever card runs second.

| card                                                                  | keeps                                                                                                                                                           | moves to Story MOTIR-4337                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **MOTIR-730** (10.1.3 — the audited cross-tenant READ layer)          | `platformReadService`, the platform-scoped repositories, and the `platform_staff` policy arms for **every tenant table except `organization`**                  | the SELECT and UPDATE `platform_staff` policy arms for `organization`, **and only `organization`**         |
| **MOTIR-733** (10.1.6 — the org / workspace / project drill-down)     | the org page's usage, recent-jobs and members panels, and the workspace and project drill-down levels                                                           | the org LOOKUP, the org page **shell** and its route — the surface the classification control hangs on     |
| **MOTIR-745** (10.3 — credit/account operations + governance toolkit) | the **general** per-org feature-flag mechanism, credit grants and adjustments, tier management, suspend / reactivate, impersonation, the hash-chained audit log | the internal classification itself, its billing semantics, and the **one** control that sets and unsets it |

**Why this way round.** The classification is meaningless without the billing semantics, and those
belong to Epic 9's economics work rather than to a governance toolkit; conversely the general
flag mechanism, the credit operations and the tamper-evident log are genuinely Epic 10's and are
not made cheaper by this story. `lib/platform/context.ts` states the third row's problem in as many
words — _"no tenant table has gained a `platform_staff` policy arm … a tenant read inside this
context returns zero rows"_ — so without the `organization` arms the operator console cannot see an
org at all, and this story cannot be built by waiting for a lower-priority epic.

**Two work items may not own the same write.** After this record, exactly one of them does, for
each write named above.

### 6. The audit trail is the SEAM, and there is ONE log

Setting or unsetting `internalBilling` writes **one `PlatformAuditLog` row** — the shipped table
from MOTIR-2896, `platform-staff-auth.md` §3b — carrying the actor, the actor's role snapshotted at
the time, the target org, the timestamp, and a **required `reason`**. It joins
`PLATFORM_AUDIT_ACTIONS` (`lib/platform/auditActions.ts`) as an ordinary member under that file's
own naming rule (`<domain>.<verb>`, the domain being the subject of the action), and it joins
`platform-staff-auth.md` §7's allocation table as a `superadmin`-level, reason-required, audited
write — the row that table would have carried had this story existed when it was written.

**No second audit log is built, and that absence is a decision rather than an omission** — say so
here so the next reader cannot mistake one for the other. Tamper-evidence (the hash chain) is
MOTIR-751's and extends this same table; when it lands, this control is simply one of its sources.
A separate log for one flag would answer _"who touched this tenant, and when?"_ from two places,
which is the failure §3b's one-table shape exists to prevent.

---

## Consequences

- **Six figures become real on the dogfood org's screens** — the balance hero, the allotment, the
  per-model breakdown, the run log, search spend and the CI line — because the debits are real and
  the netting happens in the ledger rather than in the UI.
- **The billing and usage surfaces lose a code path.** The `isMeta` branches in `BillingClient.tsx`
  and `OrgUsageClient.tsx` are deleted rather than duplicated for the new flag; an internal org
  renders exactly what a paying org renders. A second path nobody exercises is the thing this story
  is removing, so introducing one for `internalBilling` would be a regression dressed as a feature.
- **The ledger carries two rows per charge for an internal org.** That doubles that org's ledger
  volume and is the intended cost: the debit is the honest record of what the work cost, and the
  offset is the honest record of who paid for it.
- **Revenue reporting must exclude internal orgs and be able to say which.** The flag is the
  discriminator, and an internal org's spend is Motir's COGS, not revenue.
- **A second internal org no longer needs a migration.** It needs a platform-staff action with a
  reason, which is auditable and reversible; unsetting the flag returns the org to ordinary
  behaviour with its ledger history intact.
- **`isMeta` and `internalBilling` will be true together on `moooon` and only there, at first.** A
  future reader looking at two booleans that agree on every row will want to merge them. This
  record is where the reason not to lives, and §1's quotation is why it is written down rather than
  left as a schema comment.

---

## Consumed by

Every sibling subtask of Story **MOTIR-4337** that builds against this record, in dependency order.
This is the ADR's own close-out worklist.

| card           | repo         | what it takes from here                                                                |
| -------------- | ------------ | -------------------------------------------------------------------------------------- |
| **MOTIR-4564** | `motir-core` | §1 and §6 — the control's shape and its audit row, drawn as a design amendment         |
| **MOTIR-4565** | `motir-core` | §1's column, §5's `organization` policy arms, §6's audited service                     |
| **MOTIR-4566** | `motir-core` | §5's MOTIR-733 boundary — the org lookup and the org page shell, and nothing beyond it |
| **MOTIR-4567** | `motir-core` | §1 — the classification on the job-submit envelope and on the billing + usage DTOs     |
| **MOTIR-4568** | `motir-core` | §6 — the set / unset control, its required reason, its one audit row                   |
| **MOTIR-4569** | `motir-ai`   | §1 — the envelope field and the `AiOrganization` column that mirrors it                |
| **MOTIR-4570** | `motir-ai`   | §2 — the `internal_offset` kind and the paired same-transaction write                  |
| **MOTIR-4571** | `motir-ai`   | §2 — reconciling the drift an org already carries when it is newly classified          |
| **MOTIR-4572** | `motir-core` | §3 and §4 — the de-branching, and the CI line that renders instead of hiding           |
| **MOTIR-4573** | `motir-core` | §1–§6 — the core-side test gate, including the guards against a second suppression     |
| **MOTIR-4574** | `motir-ai`   | §2 and §3 — the debit→offset seam on real Postgres, and the frozen-kind guard          |
| **MOTIR-4575** | `motir-core` | §3 — the E2E and the acceptance video, which is literally watching both sides render   |

**MOTIR-4576** is the post-deploy manual task that classifies `moooon` on the live tenant; it sits
outside the story deliberately, because a deployment is a later clock than a merge.

---

## References

- `docs/decisions/code-graph-index-fleet.md` §9 (Decision 8) and **§9.1** — the warning quoted in
  §1, and Decision 8's charge-not-meter rule this record does not re-open.
- `docs/decisions/platform-staff-auth.md` §3b (the `PlatformAuditLog` shape, one table, and its
  RLS), §7 (the allocation table this control joins) and §4 (`app/(admin)/admin/` inside
  motir-core).
- `docs/decisions/ci-minutes-allowance.md` §4.4 (the meta CI bypass §4 leaves keyed on `isMeta`)
  and §8.1 (the meter's owner converts).
- `docs/decisions/billing-tiering.md` — the tier vocabulary `meta` belongs to.
- `prisma/schema.prisma` — `Organization.isMeta` and its comment (the shipped meaning §1 pins);
  `PlatformAuditLog` and `PlatformAuditTargetKind`.
- `lib/platform/auditActions.ts` — `PLATFORM_AUDIT_ACTIONS`, the closed union §6's member joins.
- `lib/platform/context.ts` — the statement that no tenant table carries a `platform_staff` arm.
- **Evidence in another repository, cited and not amended here:** `motir-ai`
  `src/creditKinds.ts` (the frozen kind set and `externalRefFor`), `src/repositories/creditRepository.ts`
  (`lockLedgerByOrg`'s `SELECT … FOR UPDATE`, `createTransaction`, `findByExternalRef`),
  `src/services/creditService.ts` (`debitForTurn` and the shared external-debit path, both of which
  apply a balance-crossing debit in full), `docs/credit-model.md` §4 and §5,
  `prisma/schema.prisma` (`CreditLedger`, `CreditTransaction`), `tests/contract.test.ts`.
- Story **MOTIR-4337**; Epic **MOTIR-4329**; the Epic-10 boundary cards **MOTIR-730**,
  **MOTIR-733**, **MOTIR-745** and their epic **MOTIR-726**; the audit foundation **MOTIR-2896**.
