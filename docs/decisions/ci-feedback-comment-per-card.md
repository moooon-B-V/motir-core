# Where the CI feedback comment's identity lives, once a pull request delivers N cards

**Status:** accepted · MOTIR-3770 · 2026-08-28
**Supersedes nothing.** It settles the one storage question
[`delivery-reader-migration.md`](./delivery-reader-migration.md) §0 assigned to S2
and did not reach.

---

## The defect, in one paragraph

`link_pull_request` writes a delivery SET (MOTIR-3657), so one pull request
delivering several cards is ordinary rather than exotic: it is every `motir auto`
run and every sweep that finishes two cards. MOTIR-3721 moved the CI path's
readers onto that set and made the **`ciState` write per card**. It could not make
the **feedback comment** per card, because the comment's identity is stored as a
nullable scalar on the check row:

```prisma
// prisma/schema.prisma  (model GithubCheckRun)
feedbackCommentId String?  @map("feedback_comment_id")
feedbackComment   Comment? @relation(fields: [feedbackCommentId], references: [id], onDelete: SetNull)
```

One column holds one id, so `changeRequestCiFeedback` commented on
`deliveredWorkItemIds[0]` and said so on the record. The result is worse than a
missing comment: the second card's `ciState` pill says **passing** or **failing**
while its discussion carries no verdict at all, and an absent comment is not read
as _look at the sibling_ — it is read as _CI has not spoken_, which is exactly the
wrong conclusion when it has.

## What is NOT in question

**The comment's KEY.** MOTIR-2946 settled it as one comment per
`(change request, head commit)`, carrying the AGGREGATE over that commit's whole
check set and updated in place as conclusions land — after a per-CHECK key put
~34 comments on one motir-core work item, several contradicting each other while
the run was still going. Nothing here reopens that. The key gains a third
coordinate, **which card**, and gets no finer in the two it already had.

## The three candidates

### (a) An array column — `feedback_comment_ids text[]` — REJECTED

One column, no new table, no migration beyond the type. It fails on the single
property the current scalar actually buys, which is not its cardinality but its
**foreign key**:

- `onDelete: SetNull` is what guarantees the id the edit path writes to is LIVE.
  A person deleting a feedback comment nulls the column, and the next terminal
  conclusion at that commit posts a fresh one.
- Postgres cannot put a foreign key on an array element. So the array holds ids
  nothing keeps live, and a deleted comment turns the next conclusion into a
  throw **inside the delivery's transaction** — a webhook the host then retries
  for ever, with every retry throwing again.
- Recovering from that needs a catch-and-recreate arm around the edit: a second
  mechanism, present only to repair a guarantee the first shape gave away. Trading
  a database invariant for application-level compensation is a bad trade at any
  size, and here it buys nothing except avoiding one table.

### (b) The identity on `work_item_delivery` — REJECTED

The delivery row already names `(card, pull request)`, so hanging the comment id
there needs no new table either. It **changes the comment's key**: a delivery row
has no head-commit column, so the identity would become one comment per
`(card, pull request)` and a later push would EDIT the comment about the previous
commit instead of opening its own. That is a deliberate reversal of MOTIR-2946,
which chose `(change request, head sha)` after measuring what the alternatives
cost. Adding `commit_sha` to `work_item_delivery` to avoid this is not a smaller
change than (c) — it makes a table whose grain is _the link_ carry per-commit rows,
which breaks the unique index every reader of that table depends on.

### (c) A table keyed on the comment's own identity — **CHOSEN**

```prisma
model GithubCiFeedbackComment {
  pullRequestId String @map("pull_request_id")
  commitSha     String @map("commit_sha")
  workItemId    String @map("work_item_id")
  commentId     String @map("comment_id")

  comment Comment @relation(fields: [commentId], references: [id], onDelete: Cascade)

  @@unique([pullRequestId, commitSha, workItemId])
  @@map("github_ci_feedback_comment")
}
```

The key is _literally_ the comment's identity — MOTIR-2946's two coordinates plus
the card — so N cards is N rows and nothing is inferred. Three things follow, and
the third is the one that decided it:

1. **The FK guarantee is kept, and strengthened.** `onDelete: Cascade` rather than
   `SetNull`, because a row whose comment is gone carries no information: the
   record disappears with the comment, the next conclusion finds nothing recorded
   for that card and posts a fresh one. The dangling-id throw of (a) has no state
   to occur in.
2. **The scalar's real problem was its GRAIN, not its width.** `github_check_run`
   is one row PER CHECK, so the id was replicated across ~34 rows at one commit and
   read back with `siblings.find(r => r.feedbackCommentId)`. This table has one row
   per thing it identifies.
3. **It is a join table with its own foreign keys** — the option MOTIR-3770 named
   first, priced at one table and one relation, which is exactly what it cost.

## Consequences

- **`github_check_run.feedback_comment_id` is NOT dropped.** This is the EXPAND
  half, following the sequence `delivery-reader-migration.md` established: the
  column keeps its FK, and the service keeps WRITING it as a mirror of the FIRST
  delivered card's comment. Two reasons — the rollback stays a code revert, and an
  instance still running the previous build during a deploy window reads that
  column, finds the comment this build opened and EDITS it rather than opening a
  second one. **A CONTRACT card drops it once nothing reads it.**
- **The service reads the legacy column as a FALLBACK, for the first card only.**
  A `(change request, head commit)` whose first verdict predates this table — every
  row the migration backfilled, and any an older instance writes mid-deploy — is
  named only there. The loop ADOPTS what it finds into the per-card table, so the
  fallback fires at most once per commit. Reading it for a SIBLING card would be a
  bug of its own: it would edit the first card's comment while claiming to write
  the second's.
- **The idempotency guard's predicate changed, and it now says what it always
  claimed.** _"A redelivery of the same conclusion we already recorded and
  commented"_ was answered off the scalar, which reports whether the FIRST card has
  a comment. It is now answered off the per-card set, so a redelivery that would
  have skipped a card carrying no comment no longer does. For a single-card
  delivery the two predicates agree, which is why nothing about that case changes.
- **Tenancy is `github_check_run`'s policy, one table over** — the `system_admin`
  arm, else a join through `github_pull_request → github_repo`. This row hangs off
  the same pull request and has no tenant discriminator of its own.
  (`work_item_delivery` carries `workspace_id` instead because it is read BEFORE a
  tenant is bound; this table is read only inside the CI-feedback path, which has
  already resolved and bound one.) The policy ships in the table's own migration —
  no unguarded window.
- **The backfill reads the card off the COMMENT, not off the link column.**
  `comment.work_item_id` is where the comment actually was posted; the link column
  has since MOVED on any pull request that delivered more than one card, so reading
  it would re-point historical comments at whichever card was linked last.
- **History is not back-posted.** The migration reports, as a `NOTICE`, how many
  `(pull request, commit, card)` triples were delivered and never commented on —
  the defect's own population, a number nobody has had. It does not create comments
  for them: a verdict about a commit that is weeks old, posted today, is noise.
- **One pre-existing hazard is widened and not removed.** `commentsService` runs
  its own transaction on its own connection, so a comment it creates survives a
  rollback of the delivery transaction that asked for it. At N cards there are N
  such windows instead of one, and a failure between two of them can leave an
  orphaned comment whose record rolled back — the retry then posts a second one for
  that card. Closing it means moving the comment writes outside the change
  request's row lock, which is what MOTIR-2946's duplicate-comment defect was
  caused by; the trade is deliberate and unchanged in kind.

## References

- `lib/services/changeRequestCiFeedback.ts` — the consumer; the per-card loop.
- `lib/repositories/githubCiFeedbackCommentRepository.ts` — the two operations.
- `prisma/migrations/20260828190000_ci_feedback_comment_per_card/` — table,
  backfill, RLS.
- `tests/github/ciFeedbackCommentPerCard.test.ts` — the N = 2 fixtures, including
  the deletion case this decision turns on.
- [`delivery-reader-migration.md`](./delivery-reader-migration.md) §0 (S2 and its
  consumers), §6 (the EXPAND-1 / EXPAND-2 cut by failure mode) — the enumeration
  that assigned S2 and stopped one level short of its storage.
- [`work-item-delivery-links.md`](./work-item-delivery-links.md) — why one pull
  request delivers N cards at all.
