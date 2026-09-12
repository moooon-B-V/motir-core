import type { User } from '@/generated/prisma/client';

/**
 * ADR §2's ROUTING RULE — `assigneeId ?? reporterId`, exactly ONE recipient —
 * written once, for the readers that are not a kind's own `routeTo`.
 *
 * ⚠️ IT ALREADY HAD THREE SPELLINGS BEFORE THIS FILE EXISTED, and that is why
 * it is here rather than inlined a fourth time: `designResultHandler.routeTo`
 * (TypeScript, at CREATION), `awaitingRoutedToWhere` (SQL, at QUEUE time), and
 * the ADR's own prose. The first two are both right and answer DIFFERENT
 * questions — which is the distinction this rule's readers keep getting wrong
 * (MOTIR-5191) — so collapsing them into one function is not available. What is
 * available is making the EXPRESSION shared, so a change to §2 lands in one
 * place and the SQL is the only restatement left.
 *
 * ⚠️ STRUCTURAL, not `WorkItem`. The queue reads a narrow projection of the
 * work item (`AWAITING_GATE_SELECT`) and never materialises a whole row; a
 * signature demanding `WorkItem` would force either an N+1 of full item reads
 * or a fourth inline spelling, which is the thing this file exists to prevent.
 */
export function routingTargetId(item: {
  assigneeId: string | null;
  reporterId: string | null;
}): string | null {
  return item.assigneeId ?? item.reporterId ?? null;
}

/**
 * A routed person's name AS A SURFACE DRAWS IT — the *Waiting on {name}* line's
 * argument (MOTIR-5191).
 *
 * ⚠️ NOT `actorLabel`, AND THE DIFFERENCE IS THE AUDIENCE. `approvalGatesService`
 * has a second, similar-looking function that renders `Name <email>` into
 * `decidedByLabel`; that one is an AUDIT string, denormalised at decision time so
 * it survives the user row's deletion, and it carries the email precisely because
 * an auditor may need to resolve a person who has gone. This one is read by
 * somebody deciding who to go and ask, so it is the bare name — an email in the
 * middle of a sentence is noise to that reader.
 *
 * `name` is non-nullable in the schema but not non-EMPTY, so a blank one degrades
 * to the email rather than to an empty sentence (`boardsService`'s own
 * `nameById` rule, which is where this convention already lives). A user row that
 * no longer resolves degrades to `null`, and the caller's fallback copy — *"this
 * work item's assignee"* — is what renders then. That fallback is the reason the
 * gate's routing column is allowed to be `onDelete: SetNull` with no surviving
 * label beside it (ADR §3), so it must keep working rather than become the
 * ordinary path.
 */
export function routedToDisplayName(user: Pick<User, 'name' | 'email'> | null): string | null {
  if (!user) return null;
  return user.name?.trim() || user.email;
}
