// The typed contract of `assert-current.mjs` (MOTIR-2131).
//
// Same arrangement as `assert-public.d.mts` next door, and for the same reason:
// the script is plain `.mjs` so it runs on a bare runner with no install and no
// build step, and a human can `node` it from any shell. This file is what lets
// the strict TypeScript suite in `test/sandboxCurrent.test.ts` drive it without
// an `@ts-expect-error`, and it doubles as the script's published API —
// anything not declared here is internal.

/** The package-scoped release tag prefix, `cli-v`. */
export declare const TAG_PREFIX: string;
/** Days unreleased work may sit before drift becomes a defect. */
export declare const DEFAULT_MAX_DRIFT_DAYS: number;
/** The paths whose change changes the published artifact. */
export declare const DEFAULT_WATCH_PATHS: string[];

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  raw: string;
}

/** One commit between the newest release tag and the ref under test. */
export interface DriftCommit {
  sha: string;
  /** ISO-8601. Unparseable dates are counted but not aged. */
  date: string;
  subject: string;
}

/**
 * What the check concluded.
 *
 * - `current` — the newest tag names this tree. Exit 0.
 * - `drifting` — unreleased commits exist, inside the grace window. Exit 0, and
 *   still REPORTED, so the number is visible before it is fatal.
 * - `stale` — the oldest unreleased commit has sat past the window. Exit 1.
 * - `untagged-bump` — package.json is ahead of the newest tag: a release was
 *   prepared and never cut. Exit 1.
 * - `version-behind-tag` — package.json went backwards past a published
 *   release. Exit 1, and a different remedy from `untagged-bump`.
 * - `never-released` / `unreadable` — could not measure. Exit 2, never a
 *   staleness claim.
 */
export type StalenessVerdict =
  | 'current'
  | 'drifting'
  | 'stale'
  | 'untagged-bump'
  | 'version-behind-tag'
  | 'never-released'
  | 'unreadable';

export interface StalenessResult {
  verdict: StalenessVerdict;
  /** 0 acceptable · 1 a definite staleness defect · 2 could not tell. */
  exitCode: 0 | 1 | 2;
  /** A sentence a human can act on, quoted into the runner annotation. */
  summary: string;
  declaredVersion?: string;
  latestTag?: string;
  latestVersion?: string;
  commitCount?: number;
  commits?: DriftCommit[];
  /** Whole days since the OLDEST unreleased commit; null when undatable. */
  oldestAgeDays?: number | null;
  oldestCommitDate?: string | null;
  maxDriftDays?: number;
  watchedPaths?: string[];
}

export interface AssessInput {
  packageVersion: string | null | undefined;
  /** Raw `git tag --list` lines; non-release tags are ignored. */
  tags: string[];
  commits?: DriftCommit[];
  /** Injected so tests pin time rather than racing the wall clock. */
  now?: Date;
  maxDriftDays?: number;
}

/** The IO seam. Production shells out to git; the tests pass fakes. */
export interface AssertCurrentIo {
  readVersion(): Promise<string>;
  listTags(pattern: string): Promise<string[]>;
  commitsBetween(tag: string, ref: string, paths: string[]): Promise<DriftCommit[]>;
  now?(): Date;
  log(line: string): void;
  error(line: string): void;
}

export interface CollectOptions {
  ref?: string;
  paths?: string[];
  maxDriftDays?: number;
}

export declare function parseVersion(value: unknown): ParsedVersion | null;
export declare function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1;
export declare function parseReleaseTags(
  tags: string[],
): Array<{ tag: string; version: ParsedVersion }>;
export declare function assessRelease(input?: Partial<AssessInput>): StalenessResult;
export declare function collectAndAssess(
  io: AssertCurrentIo,
  options?: CollectOptions,
): Promise<StalenessResult>;
export declare function main(argv: string[], io: AssertCurrentIo): Promise<0 | 1 | 2>;
