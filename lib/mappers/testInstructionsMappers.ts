import type { TestInstructionsRepo } from '@/generated/prisma/client';
import type { TestInstructionsWithRepos } from '@/lib/repositories/testInstructionsRepository';
import type {
  SetupCommandDTO,
  TestInstructionsDTO,
  TestInstructionsRepoDTO,
} from '@/lib/dto/testInstructions';

// Row → DTO for the HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
//
// The JSON columns are READ DEFENSIVELY. The service is the only writer and
// validates both shapes, so a malformed value means a row written by something
// else — a hand edit, a future migration. The mapper drops what it cannot read
// rather than handing a component a non-string to render.

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function toSetupCommands(value: unknown): SetupCommandDTO[] {
  if (!Array.isArray(value)) return [];
  const out: SetupCommandDTO[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const { label, command } = entry as Record<string, unknown>;
    if (typeof label === 'string' && typeof command === 'string') out.push({ label, command });
  }
  return out;
}

export function toTestInstructionsRepoDto(row: TestInstructionsRepo): TestInstructionsRepoDTO {
  return {
    repoId: row.repoId,
    commitSha: row.commitSha,
    setupCommands: toSetupCommands(row.setupCommands),
  };
}

export function toTestInstructionsDto(row: TestInstructionsWithRepos): TestInstructionsDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    clickPathSteps: toStringArray(row.clickPathSteps),
    clickPathNotApplicable: row.clickPathNotApplicable,
    clickPathNotApplicableReason: row.clickPathNotApplicableReason,
    previewPath: row.previewPath,
    preconditionMd: row.preconditionMd,
    repos: [...row.repos].sort((a, b) => a.position - b.position).map(toTestInstructionsRepoDto),
    dispatchRunId: row.dispatchRunId,
    publishedById: row.publishedById,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt.toISOString(),
  };
}
