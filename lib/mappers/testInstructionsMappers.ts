import type { TestInstructionsRepo } from '@/generated/prisma/client';
import type { TestInstructionsWithRepos } from '@/lib/repositories/testInstructionsRepository';
import type { TestInstructionsDTO, TestInstructionsRepoDTO } from '@/lib/dto/testInstructions';

// Row → DTO for the HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
// The body is the agent's rich text, passed through untouched — it is rendered
// by the one Markdown pipeline, never parsed here.

export function toTestInstructionsRepoDto(row: TestInstructionsRepo): TestInstructionsRepoDTO {
  return { repoId: row.repoId, commitSha: row.commitSha };
}

export function toTestInstructionsDto(row: TestInstructionsWithRepos): TestInstructionsDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    bodyMd: row.bodyMd,
    previewPath: row.previewPath,
    repos: [...row.repos].sort((a, b) => a.position - b.position).map(toTestInstructionsRepoDto),
    dispatchRunId: row.dispatchRunId,
    publishedById: row.publishedById,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt.toISOString(),
  };
}
