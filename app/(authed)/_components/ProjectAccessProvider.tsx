'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PermissionKey } from '@/lib/permissions/catalog';

/**
 * ProjectAccessProvider — carries the actor's resolved PERMISSION SET for the
 * active project into the client tree, so a role-gated affordance can ask the
 * permission it actually depends on instead of a two-bit summary of the actor.
 *
 * ## Why a set (Story MOTIR-2258 · Subtask MOTIR-2466)
 *
 * Until MOTIR-2466 this context carried `{ canEdit, canManage }`, resolved by
 * `projectAccessService.getSettingsCapabilities`. Two booleans were an accurate
 * summary of the world while a project role was a RANK (admin / member /
 * viewer). They stopped being one when MOTIR-2256 split `project:administer`
 * into twelve per-domain administrative permissions: there is no true answer to
 * "may this person administer" for a role that was given the board and nothing
 * else. So the layout now resolves the whole set once (one `resolveInputs`
 * round trip, exactly as before — the difference is what gets thrown away
 * afterwards) and hands it here as the serialisable `ActorPermissionsDTO`
 * array, in catalog order.
 *
 * ## `canEdit` / `canManage` are DERIVED, not passed
 *
 * They remain on the context value, so not one of the ~15 components reading
 * `useProjectAccess()` changed in MOTIR-2466 — but they are now computed from
 * the set rather than supplied beside it. That is provably the same answer, not
 * merely believed to be: `lib/projects/access.ts` defines `canEdit(i)` as
 * `hasPermission(i, 'work_item:edit')` and `canManageProject(i)` as
 * `hasPermission(i, 'project:administer')`, and `hasPermission` is literally
 * `resolvePermissions(i).has(key)` — the same set, asked the same question.
 * Retiring the two booleans from the call sites is the affordance sweep's job
 * (MOTIR-2473), deliberately separated so this seam stays reviewable as a pure
 * substitution.
 *
 * The BROWSE gate is enforced separately (the switcher only lists browsable
 * projects; a non-browsable active project renders the no-access state on the
 * server), so this context is about AFFORDANCES — and hiding one is never
 * enforcement: every destination it hides keeps its own server guard.
 */
interface ProjectAccessContextValue {
  /**
   * Whether the actor holds `key` on the active project. THE reader — a new
   * affordance gates on the permission its action needs, by name, rather than
   * on whichever of the two legacy booleans is closest.
   */
  can: (key: PermissionKey) => boolean;
  /** Whether the actor may edit the active project (create / move / assign / update). */
  canEdit: boolean;
  /**
   * Whether the actor may MANAGE the active project (project admin / workspace
   * owner-admin) — the gate for the work-item ⋯ menu's **Delete** action (Story
   * 2.8 · Subtask 2.8.4), mirroring `deleteWorkItem`'s `assertCanManage`.
   * Distinct from `canEdit` (Archive / inline edits).
   */
  canManage: boolean;
}

const ProjectAccessContext = createContext<ProjectAccessContextValue | null>(null);

export function ProjectAccessProvider({
  permissions,
  children,
}: {
  /**
   * The actor's permission keys for the active project — the `permissions`
   * array of the shipped `ActorPermissionsDTO`, in catalog order. An array
   * rather than a `Set` because a `Set` cannot cross the server/client
   * boundary; the order is deterministic so the prop does not churn.
   *
   * An EMPTY array is the honest "no active project / nothing resolved" value:
   * every `can()` is false, which is where the layout's own `?? []` lands.
   */
  permissions: readonly PermissionKey[];
  children: ReactNode;
}) {
  const value = useMemo<ProjectAccessContextValue>(() => {
    const held = new Set<PermissionKey>(permissions);
    const can = (key: PermissionKey) => held.has(key);
    return { can, canEdit: can('work_item:edit'), canManage: can('project:administer') };
  }, [permissions]);
  return <ProjectAccessContext.Provider value={value}>{children}</ProjectAccessContext.Provider>;
}

/**
 * The value `useProjectAccess()` answers with when NO provider is mounted — a
 * component rendered outside the authed shell, or in a unit test that never
 * wrapped it. Everything is granted, deliberately: the gate only ever TIGHTENS
 * an affordance, and it can only tighten one when a provider explicitly says
 * what the actor holds. Inverting this would silently hide UI in every test
 * that does not know this context exists.
 */
const NO_PROVIDER_ACCESS: ProjectAccessContextValue = {
  can: () => true,
  canEdit: true,
  canManage: true,
};

/**
 * Read the active project's access. See {@link NO_PROVIDER_ACCESS} for the
 * no-provider direction — outside a provider every permission reads as held,
 * preserving the pre-6.4.6 behaviour of any component mounted without the shell.
 */
export function useProjectAccess(): ProjectAccessContextValue {
  return useContext(ProjectAccessContext) ?? NO_PROVIDER_ACCESS;
}
