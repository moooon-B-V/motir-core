// The typed contract of `assert-public.mjs` (MOTIR-2010).
//
// The script itself is plain `.mjs` on purpose — it runs on a bare release
// runner with no install and no build step, and a human is meant to be able to
// `node` it from any shell. This file is what lets the strict TypeScript suite
// in `test/sandboxPublic.test.ts` drive it without an `@ts-expect-error`, and it
// doubles as the script's published API: anything not here is internal.

/** A reference that is public and RESOLVES — the positive control every run
 *  probes before it believes any other verdict. */
export declare const CONTROL_REFERENCE: string;

export interface ParsedReference {
  /** The registry HOST (`ghcr.io`, `localhost:5000`). */
  registry: string;
  /** The repository path (`moooon-b-v/motir-sandbox`). */
  repository: string;
  /** A `sha256:…` digest or a tag — whatever the reference pinned. */
  reference: string;
}

/** The three-valued answer about one reference. `pullable: null` is "could not
 *  tell" and is never a statement about the image. */
export type AnonymousPullVerdict =
  | { pullable: true; reference: string; scope: string | null; digest: string | null }
  | {
      pullable: false;
      reference: string;
      scope?: string | null;
      reason: 'unauthorized' | 'absent' | 'refused';
      detail: string;
    }
  | {
      pullable: null;
      reference: string;
      reason: 'unreachable' | 'unparseable';
      detail: string;
    };

export interface ProbeOptions {
  /** Injected for the tests, which drive a real stub registry over http. */
  fetch?: typeof fetch;
  /** A reference known to be public. Defaults to {@link CONTROL_REFERENCE}. */
  control?: string;
  /** How many times a "could not tell" is retried. Refusals are never retried. */
  attempts?: number;
  retryDelayMs?: number;
}

export interface AssertionResult {
  /** 0 all public · 1 a DEFINITE refusal · 2 could not tell (control included). */
  exitCode: 0 | 1 | 2;
  control: AnonymousPullVerdict;
  results: AnonymousPullVerdict[];
  summary: string;
}

/** The IO seam, so the CLI entrypoint can be driven from a test. */
export interface AssertPublicIo {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  log(line: string): void;
  error(line: string): void;
  /** Optional fetch override; production leaves it unset. */
  fetch?: typeof fetch;
}

export declare function parseReference(reference: unknown): ParsedReference | null;
export declare function parseBearerChallenge(header: string | null): Record<string, string> | null;
export declare function probeAnonymousPull(
  reference: string,
  options?: ProbeOptions,
): Promise<AnonymousPullVerdict>;
export declare function assertPublic(
  references: string[],
  options?: ProbeOptions,
): Promise<AssertionResult>;
export declare function resolveReferences(argv: string[], io: AssertPublicIo): Promise<string[]>;
export declare function main(argv: string[], io: AssertPublicIo): Promise<0 | 1 | 2>;
