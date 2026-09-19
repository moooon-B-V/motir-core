// Typed errors for the HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
// Same convention as lib/designEvidence/errors.ts: each carries a stable `code`
// and the HTTP `status` a route would return. The MCP door (MOTIR-5331) maps the
// code into a tool error, so every message is written for an AGENT to act on —
// an agent cannot ask what went wrong, so the sentence has to say it.

export abstract class TestInstructionsError extends Error {
  abstract readonly code: string;
  /** HTTP status a route should return. */
  abstract readonly status: number;
}

/**
 * The work item does not resolve for the caller — a missing id, or one in
 * another workspace (RLS hides it). Both read as 404 (finding #44).
 */
export class TestInstructionsWorkItemNotFoundError extends TestInstructionsError {
  readonly code = 'TEST_INSTRUCTIONS_WORK_ITEM_NOT_FOUND' as const;
  readonly status = 404;
  constructor(ref: string) {
    super(`Work item "${ref}" was not found.`);
    this.name = 'TestInstructionsWorkItemNotFoundError';
  }
}

/**
 * The repository is not one of the item's PROJECT repositories. A record is
 * keyed per repository a pull request lands in, so a repository outside the
 * project's set could never be matched to one of the item's pull requests.
 * Names the valid set so the caller can correct itself in one step. → 422.
 */
export class TestInstructionsRepoNotInProjectError extends TestInstructionsError {
  readonly code = 'TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT' as const;
  readonly status = 422;
  constructor(
    readonly repo: string,
    readonly validRepos: readonly string[],
  ) {
    super(
      validRepos.length === 0
        ? `Repository "${repo}" is not connected to this work item's project, and the project has no connected repositories.`
        : `Repository "${repo}" is not one of this work item's project repositories. Use one of: ${validRepos.join(', ')}.`,
    );
    this.name = 'TestInstructionsRepoNotInProjectError';
  }
}

/** A field exceeds its cap (lib/testInstructions/caps.ts). Never truncated. → 422. */
export class TestInstructionsCapExceededError extends TestInstructionsError {
  readonly code = 'TEST_INSTRUCTIONS_CAP_EXCEEDED' as const;
  readonly status = 422;
  constructor(
    readonly field: string,
    readonly cap: number,
    readonly unit: 'items' | 'characters' | 'bytes',
  ) {
    super(`"${field}" exceeds its limit of ${cap} ${unit}. Shorten it and publish again.`);
    this.name = 'TestInstructionsCapExceededError';
  }
}

/** A field is present but malformed (an empty step, a non-hex sha, a bad path). → 422. */
export class TestInstructionsInvalidFieldError extends TestInstructionsError {
  readonly code = 'TEST_INSTRUCTIONS_INVALID_FIELD' as const;
  readonly status = 422;
  constructor(
    readonly field: string,
    /**
     * WHAT to do about it, without the `"field" is invalid:` frame — kept as its
     * own property (Subtask MOTIR-5455) because a person's form renders the
     * refusal BESIDE the field it is about, where naming the field again is
     * noise. Recovering it by string surgery on `message` would make the
     * sentence's punctuation load-bearing.
     */
    readonly detail: string,
  ) {
    super(`"${field}" is invalid: ${detail}`);
    this.name = 'TestInstructionsInvalidFieldError';
  }
}

/**
 * Two publishes for one (work item, repository) collided on the one-current
 * partial unique index. The item row lock makes this unreachable in practice;
 * it exists so a raw `P2002` can never escape the service. Retryable. → 409.
 */
export class TestInstructionsConflictError extends TestInstructionsError {
  readonly code = 'TEST_INSTRUCTIONS_CONFLICT' as const;
  readonly status = 409;
  constructor(workItemId: string) {
    super(`A concurrent publish for work item "${workItemId}" won the race. Publish again.`);
    this.name = 'TestInstructionsConflictError';
  }
}
