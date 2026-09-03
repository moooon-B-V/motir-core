import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, specifiersOf, stripComments } from '../helpers/importGraph';

// The scanner behind MOTIR-4104's structural guard: does anything in this
// repository still READ moooon B.V.'s contract text off disk?
//
// ── WHY THIS IS A SEPARATE MODULE FROM THE TEST ────────────────────────────
// It exists so the guard's own NEGATIVE CONTROL can run the IDENTICAL scan over
// a directory that offends. A control that re-implements the scanner proves the
// control works, not the guard — the same reasoning
// `tests/hosting/abandonedPathGuard.ts` records, and this module deliberately
// mirrors its shape rather than inventing a second one.
//
// ⚠️ AND HERE THAT MATTERS MORE THAN IT DID THERE, because this guard asserts an
// absence whose SUBJECT IS GONE. `content/legal/` left the repository with
// MOTIR-4103, so there is no state of the world in which a green run of this
// scan could be distinguished, by its result alone, from a scan that read
// nothing at all. The only evidence that a green means anything is a red
// obtained from the same code — which is what `contentLegalReader.test.ts`'s
// control section buys, permanently, on every run.
//
// ── COMMENTS ARE NOT CODE, AND THAT IS LOAD-BEARING ────────────────────────
// `lib/legal/documents.ts` opens with a header saying it *used to* `readdirSync`
// `content/legal/`, and `lib/legal/consent.ts` explains that the slug list is the
// one place slugs are enumerated *because* the directory used to be the registry.
// A guard built on `grep 'content/legal'` would fail on both, and the repair for
// a red build would be to DELETE the explanation of why the guard exists. So the
// scan runs over comment-stripped text, and the control asserts BOTH directions.

/**
 * The roots a shipped module can live under. `tests/` is deliberately absent: a
 * test may name the old path (a fixture, a header explaining a re-point, this
 * guard's own control). So is `docs/` and `design/` — a decision record and a
 * design asset are prose ABOUT the application, and MOTIR-4103's sweep
 * deliberately kept 37 re-pointed citations there.
 */
export const SCANNED_ROOTS = ['app', 'lib', 'components'] as const;

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * The modules the `fs` clause applies to — the legal document reader and its
 * neighbours.
 *
 * ⚠️ SCOPED, ON PURPOSE. The property is *this module family does not touch the
 * filesystem*, not *nothing under `lib/` does*: plenty of shipped modules read
 * files legitimately, and a repo-wide ban would be a rule nobody could keep. The
 * document source is `MOTIR_LEGAL_DOCUMENTS`, a process-wide environment value
 * (`lib/legal/documents.ts`), so an `fs` reach from inside this directory is a
 * second source appearing beside the configured one — which is the exact shape
 * MOTIR-3909 replaced and MOTIR-4103 deleted the input for.
 */
const LEGAL_MODULE_RE = /(^|\/)lib\/legal\//;

/** The specifiers that would put a filesystem reader back into `lib/legal/`. */
const FS_SPECIFIERS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/**
 * The read primitives, matched as CALLS rather than as words.
 *
 * ⚠️ The import clause alone is not sufficient and the reason is mundane: a
 * module can reach `readFileSync` through a helper, a re-export or a namespace
 * import (`import * as fs`), and `specifiersOf` would report `node:fs` for the
 * last of those but nothing for the first two. Matching the call site catches
 * what the specifier misses, and matching the specifier catches an import held
 * for a type. Neither subsumes the other, so both are asserted.
 */
const FS_CALL_RE =
  /\b(readFileSync|readdirSync|existsSync|statSync|opendirSync|globSync|createReadStream|readFile|readdir)\s*\(/g;

/**
 * The path that left. Matched on the comment-stripped text of any scanned file,
 * because a shipped module naming it is a module that can still resolve it —
 * whether it reads it, globs it, or hands the string to something that does.
 */
const CONTENT_LEGAL_RE = /content\/legal/g;

export interface Offence {
  /** Repo-relative (or root-relative) path of the offending module. */
  file: string;
  /**
   * `fs-import` — a filesystem specifier imported under `lib/legal/`.
   * `fs-call` — a filesystem read called under `lib/legal/`.
   * `content-path` — the retired document path named in shipped code.
   */
  kind: 'fs-import' | 'fs-call' | 'content-path';
  /** The specifier, the function called, or the path named. */
  name: string;
}

/** Every `.ts`/`.tsx` file under `root`, recursively. */
export function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The offences in ONE file's source text, given the repo-relative path it sits
 * at. Exported so the control can assert direction by direction without a
 * filesystem at all.
 */
export function offencesIn(file: string, source: string): Array<Omit<Offence, 'file'>> {
  const found: Array<Omit<Offence, 'file'>> = [];
  const code = stripComments(source);

  if (LEGAL_MODULE_RE.test(file)) {
    for (const specifier of specifiersOf(source)) {
      if (FS_SPECIFIERS.has(specifier)) found.push({ kind: 'fs-import', name: specifier });
    }
    for (const match of code.matchAll(FS_CALL_RE)) {
      found.push({ kind: 'fs-call', name: match[1] as string });
    }
  }

  for (const match of code.matchAll(CONTENT_LEGAL_RE)) {
    found.push({ kind: 'content-path', name: match[0] });
  }

  return found;
}

/**
 * Sweep every source file under `roots` (absolute paths) and return the
 * offences, sorted, with paths relative to `base`.
 */
export function sweep(roots: readonly string[], base: string = REPO_ROOT): Offence[] {
  const offences: Offence[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const rel = relative(base, file).split('\\').join('/');
      for (const offence of offencesIn(rel, readFileSync(file, 'utf8'))) {
        offences.push({ file: rel, ...offence });
      }
    }
  }
  return offences.sort((a, b) =>
    `${a.file}${a.kind}${a.name}`.localeCompare(`${b.file}${b.kind}${b.name}`),
  );
}

/** The repository's own roots, absolute. */
export function repoRoots(): string[] {
  return SCANNED_ROOTS.map((root) => join(REPO_ROOT, root));
}
