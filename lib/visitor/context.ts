import type { Project } from '@/generated/prisma/client';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The VISITOR's read context (Story MOTIR-6170 · MOTIR-6642) — the ONE value
// every Visitor read takes: the collection reads, the rooms, the name-only person
// shape and the client data doors. `projectAccessService.resolveVisitor` is the
// only thing that builds one.
//
// It carries a `kind: 'visitor'` discriminant so a service can never mistake it
// for a member's workspace context: a Visitor has NO workspace of their own in
// this project, and nothing in it may be passed where a `WorkspaceContext` is
// expected.

/** A Visitor's standing on ONE public project. */
export interface VisitorReadContext {
  readonly kind: 'visitor';
  /** The public project being read — resolved and proved `public` already. */
  readonly project: Project;
  /**
   * The signed-in reader — another organisation's person, or a Limited member who
   * was not added. Never null since MOTIR-6666: a Visitor has signed in and
   * consented (`visitor-sign-in-and-records.md`).
   */
  readonly actorUserId: string;
  /** Always {@link VISITOR_PERMISSIONS} — the Viewer's set, nothing that writes. */
  readonly permissions: ReadonlySet<PermissionKey>;
  /**
   * The ids of every descendant of a PRIVATE epic (`epic-privacy.md` §3), read
   * once at resolution. Every Visitor read excludes these; the private epic's
   * own row is not in the set.
   */
  readonly hiddenIds: ReadonlySet<string>;
}

/**
 * What the one-time CONSENT screen needs to say (MOTIR-6666) — the project's name
 * and key and the name of the workspace whose Managers will see the reader. Nothing
 * from inside the project: no work item, no count, no hidden set.
 */
export interface VisitorConsentSubject {
  readonly identifier: string;
  readonly projectName: string;
  readonly workspaceName: string;
}

/**
 * The five answers {@link projectAccessService.resolveVisitor} gives for a
 * Visitor URL, in the order it asks (MOTIR-6642, MOTIR-6666;
 * `visitor-sign-in-and-records.md`):
 *
 * - `not_found` — cloud off, no such project, or a project that is not public.
 *   ONE indistinguishable answer, asked FIRST, so a stranger — signed in or not —
 *   can never learn a private project exists.
 * - `sign_in` — a public project and no session. Carries only the key, for the
 *   way back after signing in.
 * - `enter` — the signed-in person can ENTER the project; they belong in their
 *   own in-app view, and are never asked to consent.
 * - `consent` — signed in, cannot enter, and has not yet consented on this
 *   project: the consent screen comes first. Carries what it shows, nothing more.
 * - `visitor` — signed in, cannot enter, consented: the context every Visitor
 *   read takes.
 */
export type VisitorVerdict =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'sign_in'; readonly identifier: string }
  | { readonly kind: 'enter'; readonly project: Project }
  | { readonly kind: 'consent'; readonly subject: VisitorConsentSubject }
  | { readonly kind: 'visitor'; readonly ctx: VisitorReadContext };

/** The not-found verdict — one frozen value, so every refusal is deep-equal. */
export const VISITOR_NOT_FOUND: VisitorVerdict = Object.freeze({ kind: 'not_found' as const });

/**
 * The actor id a Visitor's narrowed service context carries. It names no user
 * row (it is not a cuid), so every "is this the reader's own record" test is
 * false for it and no membership, role or custom role ever resolves for it.
 *
 * Kept although every Visitor is signed in since MOTIR-6666: the narrowed context
 * must resolve the VISITOR's standing on this project, never the signed-in
 * reader's own standing elsewhere in the workspace — which is exactly what using
 * their real id would do.
 */
export const VISITOR_ACTOR_ID = 'visitor:anonymous';

/**
 * A NARROWED service context for a Visitor's reads of the rooms (Story MOTIR-6170 ·
 * MOTIR-6645) — the shape the rooms' existing reads already take, built so that
 * running them for a Visitor resolves exactly the Visitor's standing:
 *
 * - `userId` is {@link VISITOR_ACTOR_ID}, which holds no membership anywhere, so
 *   the workspace-bound resolver answers the public read set on this public
 *   project and nothing more — never the signed-in reader's own standing in
 *   some other project of this workspace;
 * - `tokenProjectId` binds it to THIS project, so any read of another project
 *   through it is the same not-found a stranger gets;
 * - `tokenGrant` is the Visitor key set, so a record-view key is held only if
 *   the Visitor set holds it.
 *
 * It is a READ context. Nothing that writes may be called with it; the write
 * doors refuse a Visitor before any service is reached.
 */
export function visitorServiceContext(ctx: VisitorReadContext): {
  userId: string;
  workspaceId: string;
  tokenProjectId: string;
  tokenGrant: readonly PermissionKey[];
} {
  return {
    userId: VISITOR_ACTOR_ID,
    workspaceId: ctx.project.workspaceId,
    tokenProjectId: ctx.project.id,
    tokenGrant: [...ctx.permissions],
  };
}
