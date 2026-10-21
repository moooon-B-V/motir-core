import { dbRead } from '@/lib/db';
import type { Prisma, ProjectAutoTranslateChange } from '@/generated/prisma/client';

// The attributed trail of a project's settings flips (Story MOTIR-7738 ·
// MOTIR-8826) — who changed it, from what, to what and when. Single Prisma
// operations on `project_auto_translate_change`, the project-tier twin of
// `organizationContentLanguageChangeRepository`. The table is under forced RLS
// keyed on `app.workspace_id`, so every call runs inside a workspace-bound
// transaction. `append` is the table's ONLY writer.

export interface ProjectAutoTranslateChangeAppend {
  workspaceId: string;
  projectId: string;
  changedByUserId: string;
  fromEnabled: boolean;
  toEnabled: boolean;
}

export const projectSettingChangeRepository = {
  async append(
    data: ProjectAutoTranslateChangeAppend,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectAutoTranslateChange> {
    return tx.projectAutoTranslateChange.create({ data });
  },

  /** Newest first, bounded; `id` breaks a tie between two changes in the same instant. */
  async listRecentByProject(
    projectId: string,
    limit: number,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectAutoTranslateChange[]> {
    const client = tx ?? dbRead;
    return client.projectAutoTranslateChange.findMany({
      where: { projectId },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  },

  async countByProject(projectId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.projectAutoTranslateChange.count({ where: { projectId } });
  },
};
