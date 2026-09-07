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
  validate_plan:
    'The same verdict shape again, over the PROJECTED forest of a plan being authored ' +
    '(`{ planId, valid, blockers }`). v1 returns plans, and a plan resource is not this — ' +
    'this is a judgement ABOUT one, computed over a projection that is never persisted ' +
    '(MOTIR-3095).',
  get_project_state:
    'Reports a project’s PLANNING PRECONDITIONS (established?, code connected + indexed?, ' +
    'repo set, onboarding run) — an agent-facing readiness report assembled for dispatch, ' +
    'with no REST client asking for it.',
  publish_design_result:
    'Returns the published RESULT\u2019s receipt \u2014 `{ id, workItemKey, assetCount, ' +
    'noteTruncated, createdAt }`. `/api/v1` publishes no design-evidence component at all: the ' +
    'design result is reached over the CI-authed `/api/work-items/[id]/design-evidence` route ' +
    'and read by the panel server-side, neither of which is a v1 operation, so ' +
    '`V1_RESOURCE_COMPONENTS` has nothing to derive from \u2014 by architecture rather than by ' +
    'omission. \u26a0\ufe0f `noteTruncated` is load-bearing rather than decorative: it is how a ' +
    'caller learns the inline note hit the 64 KiB cap and that the complete text lives in the ' +
    '`note_file` asset, which is the difference between a rendering bound and data loss ' +
    '(MOTIR-3782).',
  create_acceptance_upload:
    'Returns an UPLOAD GRANT — `{ workItemKey, video: { pathname, uploadUrl, contentType, ' +
    'maxBytes }, trace }`. A presigned PUT URL and the key it is bound to is not a ' +
    'representation of any resource at all: it is a capability that expires in minutes, and ' +
    '`/api/v1` publishes no acceptance-evidence component to derive from either — the receipt ' +
    'is reached over the CI-authed `/api/work-items/[id]/acceptance-evidence` routes and read ' +
    'by the panel server-side. By architecture rather than by omission (MOTIR-4704).',
  publish_acceptance_result:
    'Returns the published RECEIPT\u2019s confirmation \u2014 `{ id, workItemKey, status, ' +
    'chapterCount, sizeBytes, createdAt }`. Same boundary as its design twin above: no v1 ' +
    'operation exposes acceptance evidence, so `V1_RESOURCE_COMPONENTS` has nothing to derive ' +
    'from. \u26a0\ufe0f `status` is load-bearing rather than decorative \u2014 a receipt lands ' +
    '`pending` and only a person moves it to `approved`, so a caller that reads this field ' +
    'learns the publish SUCCEEDED and the story is still not accepted, which is the whole ' +
    'shape of the gate (MOTIR-4704).',
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
  search_work_items_semantic:
    'Returns a RANKING — `{ outcome, results: [{ key, title, score }], model, coverage, message }`. ' +
    'The row is not a work-item representation and is forbidden from becoming one: ' +
    '`plan-tree-embeddings.md` §2 pins it to keys, titles and scores, never prose, so it cannot ' +
    'derive from a resource whose whole job is to describe an item. `score`, `coverage` and ' +
    '`outcome` have no v1 counterpart at all — no v1 operation exposes semantic search ' +
    '(MOTIR-3101).',
  add_lesson:
    'Returns the recorded LESSON (`id`, `title`, its three routing axes, `sourceRef`). The ' +
    'lesson store lives in motir-ai and is reached over the 7.1 boundary; no `/api/v1` ' +
    'operation returns a lesson at all — the only other reader is the AI-planning settings ' +
    'surface, which consumes `ProjectLessonDTO` server-side and never over REST. So there is ' +
    'no shared component to derive from, by architecture rather than by omission ' +
    '(MOTIR-3361).',
  search_lessons:
    'Returns RANKED LESSONS AS PROSE — `{ outcome, lessons: [{ id, title, body, howToApply, ' +
    'scope, kinds, types, phases, distance }] }`. Two reasons it cannot derive: the lesson store ' +
    'lives in motir-ai and no `/api/v1` operation returns a lesson at all (the same reason ' +
    '`add_lesson` is exempt), and `outcome` / `distance` have no v1 counterpart — no v1 ' +
    'operation exposes lesson search. ⚠️ `outcome` is load-bearing rather than decorative: ' +
    '`nothing-matched` and `unavailable` are opposite answers that both carry an empty ' +
    '`lessons`, so a caller reading the payload structurally must be able to tell them apart ' +
    '(MOTIR-3480).',
  reinforce_lesson:
    'Returns WHAT WAS REINFORCED and whether this call counted — `{ id, title, scope, ' +
    'lastOccurredAt, recurrenceCount, counted }`. Exempt for the same reason its two lesson ' +
    'siblings are: the store lives in motir-ai and no `/api/v1` operation returns a lesson at ' +
    'all, so there is no shared component to derive from. ⚠️ `counted` is load-bearing rather ' +
    'than decorative: `false` means the occurrence was ALREADY on the ledger, so nothing was ' +
    'written and both counters stand — a caller reading the payload structurally must be able ' +
    'to tell that from a fresh record without parsing the prose (MOTIR-3553).',
  link_pull_request:
    'Returns the DECLARED LINK — `{ key, created, pullRequest: { repo, number, url, ' +
    'title, state, ci, linkedManually } }`. The row is a `LinkedPullRequestDto`, the shape the ' +
    'item detail page’s Development section renders, and no `/api/v1` operation returns a ' +
    'change request at all — the linking table is reached only through the webhook, the ' +
    'detail-page picker and now this tool. `created` has no v1 counterpart either, and it is ' +
    'load-bearing rather than decorative: it says the row existed only because this call wrote ' +
    'it (no delivery had arrived) (MOTIR-3526). ⚠️ `movedFrom` is GONE (MOTIR-3757): it named ' +
    'the item a singular foreign key had been taken off, and with that column dropped a link ' +
    'ADDS rather than moving, so there is no move to report — a caller that read it can stop.',
  unlink_pull_request:
    'Returns WHAT WAS REMOVED — `{ key, removed, pullRequest }`, where `pullRequest` is the ' +
    '`owner/name#number` coordinate the caller addressed. Exempt for the same reason its sibling ' +
    'is: no `/api/v1` operation returns a change request at all, so there is no shared component ' +
    'to derive from. ⚠️ `removed` is load-bearing rather than decorative — `false` means the ' +
    'pull request and the item both EXIST and were simply not linked (a retry, or a correction ' +
    'already made), which a caller must be able to tell from a real removal without parsing the ' +
    'prose. An unknown repository or number does not reach this payload at all; it raises ' +
    '(MOTIR-3756).',
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
