// Wire DTOs for the HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
// The service maps rows to these via lib/mappers/testInstructionsMappers.ts just
// before returning. Dates are ISO strings, matching the other evidence DTOs.

/** One setup step a reviewer runs after checking out the branch. */
export interface SetupCommandDTO {
  /** What the step is, e.g. `Install`. */
  label: string;
  /** The command itself, e.g. `pnpm install --frozen-lockfile`. */
  command: string;
}

/** One stored version of a work item's HOW TO TEST for one repository. */
export interface TestInstructionsDTO {
  id: string;
  workItemId: string;
  /** The `GithubRepo` id the record is keyed on. */
  repoId: string;
  /** The commit the instructions were written for. */
  commitSha: string;
  /** Ordered click-path; empty exactly when `clickPathNotApplicable`. */
  clickPathSteps: string[];
  clickPathNotApplicable: boolean;
  clickPathNotApplicableReason: string | null;
  /** The path to open on the preview host, e.g. `/items/ACME-7`. */
  previewPath: string | null;
  /** Install / migrate / seed / run — never the branch fetch, which the read composes. */
  setupCommands: SetupCommandDTO[];
  preconditionMd: string | null;
  /** The dispatch run that wrote it, when one did. */
  dispatchRunId: string | null;
  publishedById: string | null;
  isCurrent: boolean;
  createdAt: string;
}

/** What a publish answers: the stored record, and whether this call wrote it. */
export interface PublishTestInstructionsResultDTO {
  record: TestInstructionsDTO;
  /** False when an identical record for the same commit already existed (a retry). */
  created: boolean;
}
