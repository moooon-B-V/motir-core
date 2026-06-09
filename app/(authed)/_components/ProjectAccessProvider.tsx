'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * ProjectAccessProvider — carries the active project's EDIT capability into the
 * client tree so role-gated affordances (Story 6.4 · Subtask 6.4.6) can render
 * disabled-with-a-tooltip rather than firing a write the server (6.4.3) will
 * reject. The layout resolves `canEdit` once (server-side, via
 * `projectAccessService.getCapabilities` on the active project) and passes it
 * here; the create-issue buttons, the board's drag, and the issue-detail field
 * pickers consume it via `useProjectAccess()`.
 *
 * The BROWSE gate is enforced separately (the switcher only lists browsable
 * projects; a non-browsable active project renders the no-access state on the
 * server), so this context is purely about EDIT affordances.
 */
interface ProjectAccessContextValue {
  /** Whether the actor may edit the active project (create / move / assign / update). */
  canEdit: boolean;
}

const ProjectAccessContext = createContext<ProjectAccessContextValue | null>(null);

export function ProjectAccessProvider({
  canEdit,
  children,
}: {
  canEdit: boolean;
  children: ReactNode;
}) {
  const value = useMemo<ProjectAccessContextValue>(() => ({ canEdit }), [canEdit]);
  return <ProjectAccessContext.Provider value={value}>{children}</ProjectAccessContext.Provider>;
}

/**
 * Read the active project's edit capability. Defaults to `{ canEdit: true }`
 * when no provider is present, so a component rendered outside the authed shell
 * (or in a unit test without the provider) keeps its pre-6.4.6 behaviour — the
 * gate only ever TIGHTENS affordances when a provider explicitly says read-only.
 */
export function useProjectAccess(): ProjectAccessContextValue {
  return useContext(ProjectAccessContext) ?? { canEdit: true };
}
