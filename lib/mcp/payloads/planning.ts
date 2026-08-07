import { z } from 'zod/v4';
import { projectSchema, presentProject } from '@/lib/api/v1/projects/schema';
import { sprintSchema, presentSprint } from '@/lib/api/v1/sprints/schema';
import { membershipMoveResultSchema, presentMembershipMove } from '@/lib/api/v1/sprints/membership';
import { meSchema, workspaceSummarySchema } from '@/lib/api/v1/identity/schema';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { definePayload } from './define';
import { mcpWorkItemSchema, presentMcpWorkItem } from './workItems';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';

// The PROJECT / SPRINT / BACKLOG / IDENTITY payload shapes
// (Story 11.6 · Subtask 11.6.4 — MOTIR-2230).
//
// The less dramatic family, and that is exactly why it is in the story. The
// founding defect was not caused by the work-item tools being special — it was
// caused by three tools describing one resource in three places with nothing
// comparing them, and that arrangement is equally true here. Nobody has yet
// planned a card against an assumption these tools quietly violate, which is a
// statement about elapsed time rather than about their design.
//
// ── The happy case: SPRINTS ─────────────────────────────────────────────────
// `SprintDto` and v1's `sprintSchema` have the SAME eleven fields. So the sprint
// tools derive with no widening at all and carry a REAL probe — the payload IS
// the v1 resource, and the drift guard compares it directly.

/** A sprint, exactly as `/api/v1` publishes it. No widening: the DTO matches. */
export const mcpSprintSchema = sprintSchema;

/** The single-sprint confirmation the five sprint WRITES return. */
export const sprintWritePayload = definePayload({
  schema: mcpSprintSchema as unknown as z.ZodType<z.infer<typeof sprintSchema>>,
  probes: [{ resource: 'Sprint', select: (p) => [p] }],
});

/** The `list_sprints` collection. */
export const listSprintsPayload = definePayload({
  schema: z
    .object({ sprints: z.array(mcpSprintSchema) })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { sprints: z.infer<typeof sprintSchema>[] } & Record<string, unknown>
  >,
  probes: [{ resource: 'Sprint', select: (p) => p.sprints }],
});

/** Map a `SprintDto` — v1's own presenter, unchanged. */
export function presentMcpSprint(dto: SprintDto): z.infer<typeof sprintSchema> {
  return presentSprint(dto);
}

/**
 * A PROJECT picker row — v1's `projectSchema` WIDENED with the two fields the
 * MCP row carries for addressing (`id`, `slug`).
 *
 * `archived` is ADDED here rather than omitted. The MCP row did not carry it and
 * `ProjectDTO.archivedAt` was right there, so adding it costs nothing, turns a
 * narrowing into a pure widening, and buys a REAL probe against `Project`.
 * (`listProjects` filters archived rows out, so the value is `false` in
 * practice — but a client that cannot tell a dead project from a live one is the
 * hazard v1's own field comment names.)
 */
export const mcpProjectRowSchema = projectSchema.extend({
  id: z.string(),
  slug: z.string(),
});
export type McpProjectRowShape = z.infer<typeof mcpProjectRowSchema>;

/** Map a `ProjectDTO` — the shared half through v1's own presenter. */
export function presentMcpProjectRow(dto: ProjectDTO): McpProjectRowShape {
  return { ...presentProject(dto), id: dto.id, slug: dto.slug };
}

/** The `list_projects` collection. */
export const listProjectsPayload = definePayload({
  schema: z
    .object({ projects: z.array(mcpProjectRowSchema) })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { projects: McpProjectRowShape[] } & Record<string, unknown>
  >,
  probes: [{ resource: 'Project', select: (p) => p.projects }],
});

/**
 * `whoami`'s identity payload.
 *
 * NOT a derivation of `meSchema` as a whole: that resource answers a different
 * question (`workspaceId` + the token's `scopes`), and this one returns the
 * resolved user and workspace OBJECTS. What derives is each PART —
 * `meSchema.shape.user` widened with the avatar the profile carries, and the
 * workspace summary narrowed by the `createdAt` the MCP read does not fetch.
 * Both are declared derivations, so a change to either base breaks here.
 */
export const mcpWhoamiSchema = z.object({
  user: meSchema.shape.user.extend({ image: z.string().nullable() }),
  /** Null in the race where the membership was revoked mid-request. */
  workspace: workspaceSummarySchema.omit({ createdAt: true }).nullable(),
});
export type McpWhoami = z.infer<typeof mcpWhoamiSchema>;

/** Map the resolved identity — field by field, never a spread. */
export function presentMcpWhoami(
  user: { id: string; name: string; email: string; image: string | null },
  workspace: { id: string; name: string; slug: string } | null,
): McpWhoami {
  return {
    user: { id: user.id, name: user.name, email: user.email, image: storedAssetUrl(user.image) },
    workspace: workspace ? { id: workspace.id, name: workspace.name, slug: workspace.slug } : null,
  };
}

/** The `whoami` payload. No probe: neither part is a whole registered resource
 *  (the user is a widening of an inner shape, the workspace a narrowing). */
export const whoamiPayload = definePayload({
  schema: mcpWhoamiSchema as unknown as z.ZodType<McpWhoami>,
  probes: [],
});

/**
 * A membership MOVE result — `move_to_sprint` / `move_to_backlog`.
 *
 * `movedKeys` is ADDED from v1's `presentMembershipMove`, beside the `items`
 * the MCP payload already returned. "Which items moved" has several reasonable
 * encodings and no obviously right one, which is exactly the profile of a
 * divergence that costs someone an afternoon later — so the two surfaces now
 * answer it with one expression.
 */
export const mcpMembershipMoveSchema = membershipMoveResultSchema.extend({
  items: z.array(mcpWorkItemSchema),
});
export type McpMembershipMove = z.infer<typeof mcpMembershipMoveSchema>;

/** Map a bulk move — the shared half through v1's own presenter. */
export function presentMcpMembershipMove(moved: WorkItemDto[]): McpMembershipMove {
  return {
    ...presentMembershipMove(moved),
    items: moved.map(presentMcpWorkItem),
  };
}

/** The bulk-move payload, probed against the shared result shape. */
export const membershipMovePayload = definePayload({
  schema: mcpMembershipMoveSchema as unknown as z.ZodType<McpMembershipMove>,
  probes: [{ resource: 'MembershipMoveResult', select: (p) => [p] }],
});
