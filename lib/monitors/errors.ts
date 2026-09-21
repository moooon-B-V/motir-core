// Typed errors for the error-monitor integration (Story MOTIR-4926 ·
// MOTIR-5258). Kept in their own file so a route handler can import them without
// pulling in the Prisma client or the service. Each carries a discriminating
// `code` the layer above maps to a status or a redirect. Mirrors
// `lib/gitlab/errors.ts`.

/**
 * The binding this write would create already exists — the same *(project,
 * installation, monitored project)* triple is already bound.
 *
 * ⚠️ IT IS RAISED FROM THE DATABASE'S REFUSAL, NOT FROM A GUARDING READ. Binding
 * a project is a check-then-write, and two authorisation returns can land at
 * once: the `monitor_connection_project_id_installation_id_external_proj_key`
 * unique index is what makes exactly one of them win, and this error is how the
 * repository reports the loser's collision. A count-then-write guard with no
 * constraint behind it passes every serial test and only fails under a warm
 * pool, so the read is a courtesy and the constraint is the mechanism.
 *
 * The caller gets a typed refusal it can render — never a generic 500, and never
 * a silent second row.
 */
export class MonitorConnectionAlreadyExistsError extends Error {
  readonly code = 'MONITOR_CONNECTION_ALREADY_EXISTS' as const;
  constructor(
    readonly projectId: string,
    readonly externalProjectId: string,
  ) {
    super(
      `This project is already connected to monitored project ${externalProjectId}. ` +
        'Disconnect it first to re-bind it.',
    );
    this.name = 'MonitorConnectionAlreadyExistsError';
  }
}

/**
 * The stored `provider` discriminator names no implementation the registry knows.
 *
 * A typed error rather than a fallback to the only member: an open discriminant
 * resolved to a plausible default is silent for ever, and the one thing a row
 * from the future should not do is quietly get read as a row from the past.
 * (The registry that raises it lands with the provider seam, MOTIR-5259.)
 */
export class UnknownMonitorProviderError extends Error {
  readonly code = 'UNKNOWN_MONITOR_PROVIDER' as const;
  constructor(readonly provider: string) {
    super(`No monitor provider is registered for "${provider}".`);
    this.name = 'UnknownMonitorProviderError';
  }
}

/**
 * A provider call failed — a non-2xx, an unreachable host, or a response whose
 * shape the adapter could not read.
 *
 * ⚠️ IT CARRIES THE PROVIDER'S OWN REASON STRING, and that is the whole point of
 * the type. The credential-lifecycle card (MOTIR-5261) surfaces this string to a
 * person on the settings surface, so the adapter may not swallow it, summarise
 * it, or replace it with one of ours: a connection that says "something went
 * wrong" is a connection nobody can act on, which is the failure shape
 * MOTIR-4918 recorded one tier up.
 *
 * `status` is null when the call never got a response (a timeout, a dead host) —
 * which is a DIFFERENT fact from a 500, and the one an operator needs to tell
 * "the provider refused us" from "we could not reach the provider".
 */
export class MonitorProviderCallError extends Error {
  readonly code = 'MONITOR_PROVIDER_CALL_FAILED' as const;
  constructor(
    readonly operation: string,
    readonly status: number | null,
    /** The provider's OWN words, passed through unaltered. */
    readonly providerReason: string,
  ) {
    super(
      `Monitor provider call "${operation}" failed${status === null ? '' : ` (${status})`}: ${providerReason}`,
    );
    this.name = 'MonitorProviderCallError';
  }
}

/**
 * This workspace has no monitor grant at all — nothing has been connected, or
 * the last binding was removed and took its credential with it.
 *
 * A distinct type from {@link MonitorConnectionAlreadyExistsError} because the
 * remedy is opposite: this one means "start the install", that one means
 * "you already have this".
 */
export class MonitorGrantNotFoundError extends Error {
  readonly code = 'MONITOR_GRANT_NOT_FOUND' as const;
  constructor(readonly workspaceId: string) {
    super('This workspace has no connected error monitor.');
    this.name = 'MonitorGrantNotFoundError';
  }
}

/**
 * No such binding — or one in another workspace, which is the SAME answer
 * deliberately.
 *
 * The no-existence-leak posture every project-scoped service here keeps: a row
 * that does not exist and a row belonging to another tenant are literally
 * indistinguishable to a caller, so a cross-tenant id cannot be confirmed as
 * real by the shape of the refusal.
 */
export class MonitorConnectionNotFoundError extends Error {
  readonly code = 'MONITOR_CONNECTION_NOT_FOUND' as const;
  constructor(readonly connectionId: string) {
    super('That monitor connection does not exist.');
    this.name = 'MonitorConnectionNotFoundError';
  }
}

/**
 * The person whose name a monitor-filed bug goes on cannot file it (Story
 * MOTIR-4929 · Subtask MOTIR-5578).
 *
 * A filed bug's reporter is the person who BOUND the connection — never a system
 * principal, and never another member substituted in their place. So when that
 * person is unknown (a binding made before the column existed, or a deleted
 * account) or can no longer create work items in the project (removed from the
 * workspace, or the project's access changed), the reconciler files NOTHING and
 * records this error's `reason` on the connection's row, where a person sees it.
 *
 * ⚠️ THE REASON NAMES THE FIX. It is a sentence a project admin reads in the
 * Monitoring room, so it says what to do — re-bind the monitored project as
 * someone who can file into the project — rather than which guard refused.
 */
export class MonitorBinderUnavailableError extends Error {
  readonly code = 'MONITOR_BINDER_UNAVAILABLE' as const;
  constructor(
    readonly connectionId: string,
    /** The person-readable sentence the room shows, naming the remedy. */
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'MonitorBinderUnavailableError';
  }
}

/**
 * A minimum level that is not one of the vocabulary's members (Story MOTIR-4929
 * · Subtask MOTIR-5579). `null` — every level — is always valid; anything else
 * must be one of `lib/monitors/levels.ts`'s `MONITOR_LEVELS`.
 *
 * Refused rather than stored, because the filter treats an unrecognised MINIMUM
 * as filtering nothing: a typo would silently mean "file everything", which is
 * the opposite of what the person choosing a minimum asked for.
 */
export class InvalidMonitorLevelError extends Error {
  readonly code = 'INVALID_MONITOR_LEVEL' as const;
  constructor(readonly value: unknown) {
    super(
      `"${String(value)}" is not a monitor level. Choose debug, info, warning, error or fatal, ` +
        'or null for every level.',
    );
    this.name = 'InvalidMonitorLevelError';
  }
}

/**
 * The provider NO LONGER HAS the issue (Story MOTIR-4931 · Subtask MOTIR-5702) —
 * a 404 on a write addressed to one issue.
 *
 * A distinct type from {@link MonitorProviderCallError} because the remedy is
 * OPPOSITE: a refusal is a failure to show and retry, a deleted issue is a fact
 * to state ONCE, on the card, and never retry. Collapsing the two would force the
 * resolve-back to guess from a status code, which is how a deleted issue ends up
 * retried every half hour for ever.
 */
export class MonitorIssueGoneError extends Error {
  readonly code = 'MONITOR_ISSUE_GONE' as const;
  constructor(
    readonly operation: string,
    readonly externalIssueId: string,
    /** The provider's OWN words for the 404, passed through unaltered. */
    readonly providerReason: string,
  ) {
    super(`Monitor issue ${externalIssueId} no longer exists at the provider: ${providerReason}`);
    this.name = 'MonitorIssueGoneError';
  }
}

/**
 * A direction-switch write that carries no switch, or a non-boolean value
 * (Story MOTIR-4931 · Subtask MOTIR-5706). Refused rather than coerced: a
 * `"false"` string read as truthy would turn a switch ON that a person asked to
 * turn OFF.
 */
export class InvalidMonitorSyncDirectionError extends Error {
  readonly code = 'INVALID_MONITOR_SYNC_DIRECTION' as const;
  constructor(readonly value: unknown) {
    super(
      'Set resolveOnDone and/or syncAssignee to true or false — at least one, and nothing else.',
    );
    this.name = 'InvalidMonitorSyncDirectionError';
  }
}

/**
 * The issue is already linked to a DIFFERENT work item (Story MOTIR-4932 ·
 * Subtask MOTIR-5731), and the link was not asked to MOVE it.
 *
 * One issue belongs to one card — the `monitor_issue` unique index already says
 * so, and the monitor's own integrations model it the same way. So a link is
 * REFUSED, naming the card that holds it, and taking it from that card is a
 * separate, explicit act (`move: true`) a person confirms. Silently re-pointing
 * it would be a change nobody notices until the wrong card closes.
 */
export class MonitorIssueAlreadyLinkedError extends Error {
  readonly code = 'MONITOR_ISSUE_ALREADY_LINKED' as const;
  constructor(
    readonly externalIssueId: string,
    /** The `KEY-<n>` of the work item that holds the link. */
    readonly holderIdentifier: string,
  ) {
    super(`Monitor issue ${externalIssueId} is already linked to ${holderIdentifier}.`);
    this.name = 'MonitorIssueAlreadyLinkedError';
  }
}

/**
 * An unlink addressed a link this work item does not hold (Story MOTIR-4932 ·
 * Subtask MOTIR-5731) — it points at another card, or it is in another project.
 *
 * Indistinguishable from a link that does not exist at all, for the
 * no-existence-leak reason {@link MonitorConnectionNotFoundError} gives, and so
 * that a stale page can never unlink ANOTHER card's error.
 */
export class MonitorIssueLinkNotFoundError extends Error {
  readonly code = 'MONITOR_ISSUE_LINK_NOT_FOUND' as const;
  constructor(readonly monitorIssueId: string) {
    super('That error link does not exist on this work item.');
    this.name = 'MonitorIssueLinkNotFoundError';
  }
}

/**
 * The bug ENRICHMENT trigger (Story MOTIR-4930 · Subtask MOTIR-5849) was handed a
 * bug the monitor reconciler FILED — its `work-item/created` event carries the
 * binding's provenance — and no `monitor_issue` row points at it yet.
 *
 * ⚠️ THIS IS THE ORDERING WINDOW, AND IT IS THROWN SO IT IS RETRIED. The
 * reconciler's create commits its own transaction, and emits its event, before
 * the outer transaction that links the row commits. So a fast consumer can see
 * the bug before the link. Throwing hands the wait to the job's idempotent retry
 * budget, which is measured in seconds; returning a value here would skip the
 * enrichment for good. A link that NEVER appears — the reconciler's outer
 * transaction rolled back after its create committed, the one window it accepts —
 * exhausts the budget and dead-letters, which is loud rather than silent. The bug
 * itself is untouched either way.
 */
export class MonitorLinkNotYetVisibleError extends Error {
  readonly code = 'MONITOR_LINK_NOT_YET_VISIBLE' as const;
  constructor(
    readonly connectionId: string,
    readonly workItemId: string,
  ) {
    super(
      `The monitor link for work item ${workItemId} (connection ${connectionId}) is not visible yet.`,
    );
    this.name = 'MonitorLinkNotYetVisibleError';
  }
}
