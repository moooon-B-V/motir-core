import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';

// PUTTING THE APPROVED DESIGN ON DISK (Story MOTIR-5553 · Subtask MOTIR-5562).
//
// `docs/decisions/design-result.md` AMENDMENT 5 Q5: when the launcher CAN
// materialize the design, it writes it into the run's own temporary directory —
// the one `prompt.md` and `$MOTIR_AGENT_REPORT` already live in — and hands the
// agent `$MOTIR_DESIGN_DIR`. The agent then opens and greps the files like any
// others, instead of learning a fetch protocol before it can start.
//
// ── ALL OR NOTHING, and it is the decision rather than a convenience ────────
// A partial directory is WORSE than none. An agent that finds two of three
// mocks has no way to know a third existed, so it designs to what it can see and
// reports success. Any failure therefore removes the directory entirely, leaves
// `$MOTIR_DESIGN_DIR` unset, and warns — and the prompt's fetch instruction,
// which is written for exactly this case, takes over.
//
// ── AND IT NEVER FAILS THE DISPATCH ────────────────────────────────────────
// A design that could not be fetched is a degraded run, not a broken one: the
// agent can still fetch it through `get_design`. Failing the dispatch would turn
// a transient object-store hiccup into a card nobody is working on.

/** The environment variable the agent reads. ONE constant, so the CLI and the
 *  dispatched prompt cannot drift about its name (a test pins the equality). */
export const MOTIR_DESIGN_DIR_ENV = 'MOTIR_DESIGN_DIR';

/** The run directory's design subfolder. */
export const DESIGN_SUBDIR = 'design';

/** One file to write, resolved from an approved verdict. */
interface PlannedDownload {
  designCardKey: string;
  sourcePath: string;
  url: string;
}

/**
 * Is this `sourcePath` safe to join onto the design root?
 *
 * ⚠️ CHECKED BEFORE ANY WRITE, not per file as it is written. The path comes
 * from the server, but it ORIGINATES in a repository the design was published
 * from — so it is data that has travelled, and an absolute path or a `..`
 * segment would put a write outside the run's own directory, which is the one
 * place this feature is allowed to touch. Refusing the whole batch keeps the
 * all-or-nothing rule true: a run must never get some files plus a warning.
 */
export function isSafeSourcePath(sourcePath: string): boolean {
  if (sourcePath === '' || isAbsolute(sourcePath)) return false;
  // Windows-style roots and drive letters travel as neither of the above.
  if (/^[A-Za-z]:/.test(sourcePath) || sourcePath.startsWith('\\')) return false;
  const segments = sourcePath.split(/[\\/]/);
  return !segments.includes('..') && !segments.includes('');
}

/** The shape this module needs of an approved-designs response. */
export interface DesignsResponse {
  designs: Array<{
    verdict: string;
    designCardKey: string;
    design?: {
      assets: Array<{ sourcePath: string; state: string; url?: string }>;
    };
  }>;
}

export interface MaterializeDesignsDeps {
  /** Read the designs the card waits on — `GET …/work-items/{key}/designs`. */
  readDesigns: (key: string) => Promise<DesignsResponse>;
  /**
   * Fetch one asset's bytes.
   *
   * ⚠️ IT MUST SEND NO `Authorization` HEADER. The link is PRESIGNED: the
   * credential is in the URL, and the object store is a third party. Attaching
   * the user's Motir token would hand it to a host that has no business seeing
   * it, for no benefit — the request already carries everything it needs.
   */
  fetchAsset: (url: string) => Promise<ArrayBuffer>;
  /** Injected so the tests can drive the failure paths without a filesystem. */
  fs?: {
    mkdir: (path: string) => void;
    writeFile: (path: string, bytes: Buffer) => void;
    remove: (path: string) => void;
  };
  /** Where a warning goes. One line, never a stack. */
  warn?: (message: string) => void;
}

const realFs = {
  mkdir: (path: string) => mkdirSync(path, { recursive: true }),
  writeFile: (path: string, bytes: Buffer) => writeFileSync(path, bytes),
  remove: (path: string) => rmSync(path, { recursive: true, force: true }),
};

/**
 * Build the materializer `runAgent` calls with the run's design root.
 *
 * Resolves to `true` when EVERY available asset of every approved design landed
 * — the only case in which `$MOTIR_DESIGN_DIR` is set — and `false` otherwise,
 * having already cleaned up and warned.
 *
 * A card with no approved design resolves `false` with NO warning: there is
 * nothing to fetch and nothing went wrong, and warning about it would train an
 * operator to ignore the line that matters.
 */
export function materializeDesignsFor(
  key: string,
  deps: MaterializeDesignsDeps,
): (designRoot: string) => Promise<boolean> {
  const fs = deps.fs ?? realFs;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  return async (designRoot: string): Promise<boolean> => {
    let planned: PlannedDownload[];
    try {
      const body = await deps.readDesigns(key);
      planned = [];
      for (const verdict of body.designs) {
        if (verdict.verdict !== 'approved' || !verdict.design) continue;
        for (const asset of verdict.design.assets) {
          // An `unavailable` asset is SKIPPED, not a failure: an approved
          // version whose bytes were reclaimed is a real state (AMENDMENT 5
          // Q6), and it has no url to fetch.
          if (asset.state !== 'available' || !asset.url) continue;
          planned.push({
            designCardKey: verdict.designCardKey,
            sourcePath: asset.sourcePath,
            url: asset.url,
          });
        }
      }
    } catch (err) {
      warn(designWarning(`could not read the designs this card waits on (${reasonOf(err)})`));
      return false;
    }

    if (planned.length === 0) return false;

    const unsafe = planned.find((file) => !isSafeSourcePath(file.sourcePath));
    if (unsafe) {
      // Refused BEFORE the first write, so there is nothing to clean up.
      warn(
        designWarning(
          `refused a design file whose path would escape the run directory ` +
            `(${unsafe.designCardKey}: "${unsafe.sourcePath}")`,
        ),
      );
      return false;
    }

    try {
      for (const file of planned) {
        const target = join(designRoot, file.designCardKey, ...file.sourcePath.split(/[\\/]/));
        fs.mkdir(dirname(target));
        fs.writeFile(target, Buffer.from(await deps.fetchAsset(file.url)));
      }
      return true;
    } catch (err) {
      // ALL OR NOTHING: a half-written directory is the one outcome that makes
      // an agent confidently wrong.
      fs.remove(designRoot);
      warn(designWarning(`could not download the approved design (${reasonOf(err)})`));
      return false;
    }
  };
}

/** One line, in the voice the operator needs: what is missing, and what follows. */
function designWarning(what: string): string {
  return `motir: ${what}. The agent will be told to fetch the design itself with \`get_design\`.`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exported for the tests, which assert the separator is not hard-coded. */
export const PATH_SEPARATOR = sep;

/**
 * Fetch one presigned asset — the production {@link MaterializeDesignsDeps.fetchAsset}.
 *
 * ⚠️ NO `Authorization` HEADER, and that is the point of the function existing
 * rather than an inline `fetch`. The url already carries its own credential, and
 * the host on the other end is the object store, not Motir — attaching the
 * user's token would hand it to a third party for no benefit at all. Keeping the
 * call here means there is ONE place to read to confirm that, and one place a
 * test can assert it about.
 */
export async function fetchPresignedAsset(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`the object store answered ${response.status} for a design file`);
  }
  return response.arrayBuffer();
}
