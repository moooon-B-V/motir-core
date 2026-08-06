import type { McpToolName } from '../registry';

// The EXEMPTION + MIGRATION registries (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// A guard's SILENCE is only information if an absent tool and a deliberately
// excluded one look different. These two maps are what makes them different:
// every tool is derived from a shared schema, or it appears here with a written
// reason, and `toolOk` accepts nothing else.
//
// ADR Amendment 7 Q5 records the decision and the rule for joining the list.

/**
 * Tools whose payload has NO shared resource schema to derive from, because no
 * `/api/v1` operation returns that resource.
 *
 * ⚠️ That is the ONLY thing an exemption means. It is not "we did not get to
 * it", and it is not a per-tool opt-out — a tool that returns a shape v1
 * describes must derive, whether or not it has an endpoint of its own.
 *
 * Adding an entry is a deliberate edit with a reason string, in the same PR as
 * the tool. `MOTIR-2231` (11.6.5) SEALS this against `lib/mcp/registry.ts`:
 * every registered tool must resolve to derived-or-exempt, so a tool in neither
 * column fails the run rather than being skipped.
 */
export const EXEMPT_TOOLS = {
  validate_work_item:
    'Returns a subtree FINISHABILITY verdict (valid / blockers / advisories) — a planning ' +
    'judgement computed over a tree, not a representation of a resource. No v1 operation ' +
    'exposes it (ADR Amendment 6’s boundary records why no client has asked).',
  validate_sprint:
    'The same verdict shape over a sprint’s membership. Same boundary, same reason — it ' +
    'describes whether a set of work can finish, which is not a thing v1 returns.',
  get_project_state:
    'Reports a project’s PLANNING PRECONDITIONS (established?, code connected + indexed?, ' +
    'repo set, onboarding run) — an agent-facing readiness report assembled for dispatch, ' +
    'with no REST client asking for it.',
  link_work_items:
    'Returns the created EDGE ROW (`WorkItemLinkDto` — `id`, `fromId`, `toId`, `kind`, ' +
    '`createdById`). v1 has a link-create endpoint, but its 201 body is an inline ' +
    '`{ toKey, relationship }` declared at the operation — key-addressed, not a registered ' +
    'component, and a different resource from the row. Nothing shared to derive from (MOTIR-2229).',
  unlink_work_items:
    'Returns `{ removed, relationship }` — a removal COUNT. v1’s delete is a 204 with no body ' +
    'at all (idempotent by post-condition), so there is no shared shape (MOTIR-2229).',
  delete_work_item:
    'Returns a cascade-delete summary (`totalCount`, `descendantCount`, `byKind`). ADR §3 ' +
    'leaves the irreversible cascade delete OUT of v1 entirely, and `tests/helpers/v1RouteAudit.ts` ' +
    'enforces it with a `reaches-cascade-delete` rule — so no v1 resource exists, by decision ' +
    'rather than by omission (MOTIR-2229).',
  delete_sprint:
    'Returns `{ sprintId, deleted }` — a deletion acknowledgement. v1’s sprint delete answers ' +
    '204 with no body (the post-condition is the whole contract), so there is no shared shape ' +
    'to derive from (MOTIR-2230).',
} as const satisfies Partial<Record<McpToolName, string>>;

/** A tool the exemption registry covers. */
export type ExemptToolName = keyof typeof EXEMPT_TOOLS;

/**
 * ⚠️ SEALED by MOTIR-2231 (11.6.5). This map is EMPTY and stays empty.
 *
 * It existed only because Story 11.6 landed the seam (11.6.2) before the three
 * family cards that moved ~30 tools through it, and a commit that leaves the
 * tree red is not a commit. Every entry named the card that would remove it; all
 * three landed, so every registered tool is now DERIVED or EXEMPT and there is
 * no third column.
 *
 * The `unmigrated` constructor was deleted with the last entry. If a tool ever
 * needs staging again, restore both TOGETHER and card each entry — what must
 * never happen is a tool moving into {@link EXEMPT_TOOLS} to make a card finish,
 * because "no shared resource exists" and "nobody has done it yet" are different
 * facts and only one of them is permanent.
 */
export const MIGRATING_TOOLS = {} as const satisfies Partial<Record<McpToolName, string>>;

/** A tool still awaiting its family card. Empty since MOTIR-2231. */
export type MigratingToolName = keyof typeof MIGRATING_TOOLS;

/** Whether a tool is exempt (runtime form, for the registry walk 11.6.5 seals). */
export function isExemptTool(name: McpToolName): name is ExemptToolName {
  return name in EXEMPT_TOOLS;
}

/** Whether a tool is still staged for a family card. */
export function isMigratingTool(name: McpToolName): name is MigratingToolName {
  return name in MIGRATING_TOOLS;
}
