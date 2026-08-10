// The typed contract of `assert-commands.mjs` (MOTIR-2612).
//
// The script itself is plain `.mjs` for the same reason its two siblings are: it
// runs on a bare release runner with no install and no build step, and a human
// mid-investigation must be able to `node` it from any shell. This file is what
// lets the strict TypeScript suite in `test/sandboxCommands.test.ts` drive it
// without an `@ts-expect-error`, and it doubles as the script's published API —
// anything not declared here is internal.

import type { ParsedReference } from './assert-public.d.mts';

/** The guide that OWNS the expectation: `lib/apiDocs/sandbox.ts`, repo-relative. */
export declare const DEFAULT_GUIDE_PATH: string;
/** Where `npm install -g` puts the CLI inside the image. */
export declare const CLI_PACKAGE_DIR: string;
/** A command name that cannot exist — the negative control every run requires to
 *  come back ABSENT before it believes a "present" verdict. */
export declare const CONTROL_COMMAND: string;
/** How much of an image a single platform's search may download before it gives
 *  up and reports "could not tell". */
export declare const MAX_DOWNLOAD_BYTES: number;

/** Every "could not tell": a transport failure, a digest mismatch, an
 *  unreadable manifest, a host node too old to run the extracted CLI. Distinct
 *  from a command being missing, which is a verdict rather than an error. */
export declare class IndeterminateError extends Error {}

/** The raw derivation, with the counts that make a silent under-match loud. */
export interface CliCommandParse {
  /** How many `cliCommands:` keys the source contains. */
  declared: number;
  /** How many of those arrays this parser actually understood. */
  parsed: number;
  /** The array bodies it could not read, verbatim. */
  unparsed: string[];
  /** The union of every command named, de-duplicated and sorted. */
  commands: string[];
}

/** The derivation as a verdict-or-refusal. An empty set is a REFUSAL. */
export interface Expectation {
  ok: boolean;
  commands: string[];
  /** Why the expectation cannot be stated, when `ok` is false. */
  detail: string | null;
}

/** One group of a `motir help` surface — a heading and the commands under it. */
export interface HelpGroup {
  heading: string;
  names: string[];
}

export interface HelpParse {
  groups: HelpGroup[];
  /** Every command name across all groups, de-duplicated. */
  commands: string[];
}

export type CommandVerdict =
  | 'complete'
  | 'missing'
  | 'unreadable-help'
  | 'control-present'
  | 'no-expectation'
  | 'unreadable-image';

export interface CommandAssertion {
  verdict: CommandVerdict;
  /** 0 every documented command present · 1 at least one MISSING · 2 could not tell. */
  exitCode: 0 | 1 | 2;
  expected: string[];
  present: string[];
  missing: string[];
  control?: string;
  summary: string;
}

/** One platform's row of the report. */
export interface PlatformResult extends CommandAssertion {
  reference: string;
  /** `linux/amd64`, `linux/arm64`, or `unspecified` for a single-arch manifest. */
  platform: string;
  /** The platform manifest's digest — the bytes that were actually read. */
  digest: string;
  /** The version the extracted `package.json` declares, when it could be read. */
  cliVersion: string | null;
}

/** A GET against one repository that carries no credential of ours. */
export type AnonymousGet = (path: string, accept: string) => Promise<Response>;

/** The IO seam, so every network call, subprocess and file read is injectable. */
export interface AssertCommandsIo {
  /** Read the guide source (`lib/apiDocs/sandbox.ts`). */
  readGuide(path: string): Promise<string>;
  /** Both used by `resolveReferences`, which is imported from `assert-public.mjs`. */
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** Build an anonymous reader for one repository. */
  registry(parsed: ParsedReference): AnonymousGet;
  /** Memoise per platform-manifest digest — every profile shares the CLI layer. */
  cached<T>(key: string, produce: () => Promise<T>): Promise<T>;
  /** Run the extracted CLI's entry point and return its stdout. */
  runNode(pkg: ExtractedPackage, entry: string, args: string[]): Promise<string>;
  log(line: string): void;
  error(line: string): void;
}

/** The `@motir/cli` package as extracted from one image layer. */
export interface ExtractedPackage {
  /** Files keyed by their path INSIDE the package (`dist/index.js`). */
  files: Map<string, Buffer>;
  /** The version the package declares, or null if unreadable. */
  version: string | null;
  /** The layer the bytes came from, digest-verified. */
  layerDigest: string;
  layerIndex: number;
  /** Where `runNode` materialised the package, once it has. */
  dir?: string;
}

export declare function parseCliCommands(source: unknown): CliCommandParse;
export declare function expectedCommands(source: unknown): Expectation;
export declare function parseHelpCommands(text: unknown): HelpParse;
export declare function assertCommandSet(args: {
  expected: string[];
  helpFor: (segments: string[]) => Promise<string>;
  control?: string;
}): Promise<CommandAssertion>;

export declare function anonymousRegistry(
  parsed: ParsedReference,
  fetchImpl?: typeof fetch,
): AnonymousGet;
export declare function verifyDigest(bytes: Uint8Array, digest: unknown, label: string): void;
export declare function walkTar(
  buffer: Buffer,
  onEntry: (entry: { name: string; size: number; body: Buffer }) => void,
): void;
export declare function orderLayersByLikelihood(config: unknown, layerCount: number): number[];
export declare function resolvePlatforms(
  reference: string,
  io: AssertCommandsIo,
): Promise<{
  parsed: ParsedReference;
  indexDigest: string | null;
  platforms: { platform: string; digest: string }[];
}>;
export declare function extractCliPackage(
  parsed: ParsedReference,
  manifestDigest: string,
  io: AssertCommandsIo,
): Promise<ExtractedPackage>;
export declare function runHelp(
  pkg: ExtractedPackage,
  io: AssertCommandsIo,
  segments?: string[],
): Promise<string>;
export declare function assertReference(
  reference: string,
  expected: string[],
  io: AssertCommandsIo,
): Promise<{ reference: string; indexDigest: string | null; results: PlatformResult[] }>;
export declare function main(argv: string[], io: AssertCommandsIo): Promise<0 | 1 | 2>;
