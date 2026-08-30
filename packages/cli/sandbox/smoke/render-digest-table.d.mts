// The typed contract of `render-digest-table.mjs` (MOTIR-2699).
//
// The script itself is plain `.mjs` for the same reason `assert-public.mjs` is:
// it runs on a bare release runner with no install and no build step, and a human
// is meant to be able to `node` it from any shell. This file is what lets the
// strict TypeScript suite in `test/sandboxDigestTable.test.ts` drive it without
// an `@ts-expect-error`, and it doubles as the script's published API — anything
// not here is internal.

/** One row of § Published images: the moving tag, and the bytes it resolves to. */
export interface DigestRow {
  /** The published name — `base`, or a profile id from `profiles.json`. */
  name: string;
  /** The moving reference the Tag column prints (`<image>:<name>`). */
  tag: string;
  /** The `sha256:…` GHCR serves for it to an ANONYMOUS caller. */
  digest: string;
}

/** A release section already recorded in the README. */
export interface ParsedSection {
  version: string;
  /** 0-based line index of the section's first line (its marker, or its heading). */
  start: number;
  /** 0-based line index one past its last line. */
  end: number;
  /** Whether it carries the machine-readable frame a demotion needs. */
  marked: boolean;
}

/** The outcome of resolving every published tag for one release. */
export interface ResolvedDigests {
  /** 0 every tag resolved · 1 a DEFINITE refusal · 2 could not tell. */
  exitCode: 0 | 1 | 2;
  rows: DigestRow[];
  /** One human-readable line per name that could not be recorded. */
  problems: string[];
  summary: string;
}

/** The verdict of an invariant check. `checked: false` means it did not apply. */
export interface InvariantCheck {
  checked: boolean;
  problems: string[];
  /** The version the novelty check compared against, when it ran. */
  against?: string;
}

export interface PreviousRelease {
  version: string;
  rows: DigestRow[];
}

export interface RenderOptions {
  /** The OCI repository, without a tag (`ghcr.io/moooon-b-v/motir-sandbox`). */
  image: string;
  /** The bare `x.y.z` this release published. */
  version: string;
  /** The Actions run that published it — its trailing id becomes the link text. */
  runUrl: string;
  rows: DigestRow[];
  novelty: InvariantCheck;
}

/** The result of placing a section in the file. Exactly one of `content` /
 *  `error` is present. */
export interface ReadmeUpdate {
  content?: string;
  /** True only when the result differs from what is already on disk — the bit
   *  criterion 5 turns into "a no-op release opens no pull request". */
  changed?: boolean;
  action?: 'inserted' | 'replaced';
  /** The section this insert demoted to history, if any. */
  displaced?: string | null;
  error?: string;
}

/** The IO seam, so the CLI entrypoint can be driven from a test. */
export interface RenderDigestTableIo {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  log(line: string): void;
  error(line: string): void;
  /** Publishes one bit to the workflow: did the README change. */
  setOutput(name: string, value: string): void;
  /** Optional fetch override; production leaves it unset. */
  fetch?: typeof fetch;
}

export interface ResolveOptions {
  fetch?: typeof fetch;
  /** A reference known to be public. Defaults to `assert-public.mjs`'s control. */
  control?: string;
}

export declare function resolveDigestRows(
  image: string,
  names: string[],
  version: string,
  options?: ResolveOptions,
): Promise<ResolvedDigests>;
export declare function checkNovelty(
  rows: DigestRow[],
  previous: PreviousRelease | null,
): InvariantCheck;
export declare function checkRecorded(
  rows: DigestRow[],
  recorded: Record<string, string> | null,
): InvariantCheck;
/** Greedy word wrap at `width` columns (default 80). Never splits a token, so an
 *  inline code span cannot be broken across lines. */
export declare function wrapProse(text: string, width?: number): string;
export declare function renderTable(rows: DigestRow[]): string;
export declare function renderSection(options: RenderOptions): string;
export declare function parseSections(readme: string): ParsedSection[];
export declare function parseRows(text: string): DigestRow[];
export declare function demoteSection(
  sectionText: string,
  version: string,
  supersededBy: string,
): string | null;
export declare function updateReadme(
  readme: string,
  options: { version: string; section: string },
): ReadmeUpdate;
export declare function resolveNames(argv: string[], io: RenderDigestTableIo): Promise<string[]>;
export declare function resolveRecorded(
  argv: string[],
  io: RenderDigestTableIo,
): Promise<Record<string, string> | null>;
export declare function main(argv: string[], io: RenderDigestTableIo): Promise<0 | 1 | 2>;

/**
 * The REAL `io` the script executes with, exported so a test can drive the one
 * seam every other test replaces with a double (Bug MOTIR-3989).
 *
 * `setOutput` is SYNCHRONOUS by contract: when it returns, the bytes are in
 * `$GITHUB_OUTPUT`. The caller's next statement may be `process.exit`, which does
 * not flush pending async I/O.
 */
export declare function nodeIo(fs: {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  writeFile: (path: string, content: string, encoding: 'utf8') => Promise<void>;
  appendFileSync: (path: string, content: string, encoding: 'utf8') => void;
}): RenderDigestTableIo;
