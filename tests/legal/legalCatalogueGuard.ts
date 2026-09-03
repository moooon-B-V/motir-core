import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';
import { sourceFilesUnder } from './contentLegalReaderGuard';

// The scanner behind MOTIR-4104's catalogue clause: which `legal.*` message keys
// does a SURVIVING surface actually read?
//
// ── ⚠️ THE ORPHAN DIRECTION IS THE QUIET ONE ───────────────────────────────
// `tests/i18n-catalog.test.ts` already holds `en` ⟷ `zh` parity, in both
// directions, for the whole catalogue. What no check in this repository can see
// is a key that BOTH locales carry and NOTHING reads: it produces no type error,
// no missing-message crash, no failing render and no lint. MOTIR-4103 split the
// `legal.*` namespace — ten keys the deleted pages read left `en` and `zh`
// together, `signUpNotice` and `reconsent.*` stayed — and an eleventh left
// behind would be invisible to every other gate in the tree.
//
// So the property is a SET EQUALITY between two populations that are derived
// independently: the keys the catalogue declares, and the keys the source reads.
// Either direction failing is a real defect and they are different defects —
// a key read and not declared is a render crash for a `zh` user, a key declared
// and not read is dead copy somebody will translate again next quarter.
//
// ── WHY A SEPARATE MODULE FROM THE TEST ────────────────────────────────────
// Same reason as `./contentLegalReaderGuard.ts` beside it: the controls run the
// IDENTICAL extractor over sources that offend, and a control that
// re-implements the extractor proves the control works, not the guard.

/** The roots a surface that reads a message catalogue can live under. */
export const CATALOGUE_ROOTS = ['app', 'components'] as const;

/**
 * The catalogue namespace this guard is about. Scoped deliberately: the split
 * MOTIR-4103 performed was of `legal.*`, and `shell.nav.legal` /
 * `projectSquare.footCompanyLegal` are different namespaces owned by different
 * surfaces.
 */
export const LEGAL_NAMESPACE = 'legal';

/**
 * `const t = useTranslations('ns')` / `const t = await getTranslations('ns')`.
 *
 * ⚠️ THE BINDING NAME IS CAPTURED, not assumed to be `t`. `SignUpCard.tsx` holds
 * TWO translators — `t` for `auth` and `tLegal` for `legal` — so a scan that
 * looked for `t('…')` would attribute the sign-up form's own copy to the legal
 * namespace and report thirty phantom keys.
 */
const NAMESPACE_BINDING_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Build `VAR('key')` / `VAR.rich('key')` / `VAR.raw('key')` for one binding. */
function callsFor(binding: string): RegExp {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b${escaped}\\s*(?:\\.\\s*(?:rich|raw|markup|has)\\s*)?\\(\\s*['"]([^'"]+)['"]`,
    'g',
  );
}

/**
 * Every fully-qualified `legal.*` key ONE source file reads, comment-stripped.
 *
 * Comment-stripped for the same reason the reader guard is: three shipped
 * components carry headers naming the keys they used to read, and a scan that
 * counted prose would report a key as live for as long as its epitaph survived.
 */
export function legalKeysReadIn(source: string): string[] {
  const code = stripComments(source);
  const keys = new Set<string>();

  for (const binding of code.matchAll(NAMESPACE_BINDING_RE)) {
    const variable = binding[1] as string;
    const namespace = binding[2] as string;
    if (namespace !== LEGAL_NAMESPACE && !namespace.startsWith(`${LEGAL_NAMESPACE}.`)) continue;
    for (const call of code.matchAll(callsFor(variable))) {
      keys.add(`${namespace}.${call[1] as string}`);
    }
  }

  return [...keys].sort();
}

/** Where each read key was found — so a red build names the file, not just the key. */
export interface KeyRead {
  key: string;
  file: string;
}

/** Every `legal.*` key read anywhere under `roots` (absolute paths). */
export function legalKeysReadUnder(roots: readonly string[], base: string = REPO_ROOT): KeyRead[] {
  const reads: KeyRead[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const rel = relative(base, file).split('\\').join('/');
      for (const key of legalKeysReadIn(readFileSync(file, 'utf8'))) {
        reads.push({ key, file: rel });
      }
    }
  }
  return reads.sort((a, b) => `${a.key}${a.file}`.localeCompare(`${b.key}${b.file}`));
}

/** The repository's own catalogue roots, absolute. */
export function catalogueRoots(): string[] {
  return CATALOGUE_ROOTS.map((root) => join(REPO_ROOT, root));
}

/**
 * Every leaf key path under `legal.` in one locale catalogue.
 *
 * The catalogue is READ FROM DISK rather than imported: this module runs in the
 * structural-guard lane, whose members may not import from `lib/`, `app/` or
 * `components/` — and reading the file is also what makes the two populations
 * genuinely independent, since the source scan reads text too.
 */
export function legalKeysDeclaredIn(locale: 'en' | 'zh'): string[] {
  const raw = readFileSync(join(REPO_ROOT, 'messages', `${locale}.json`), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const root = parsed[LEGAL_NAMESPACE];
  if (root === undefined) return [];

  const leaves: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, `${path}.${key}`);
      }
      return;
    }
    leaves.push(path);
  };
  walk(root, LEGAL_NAMESPACE);
  return leaves.sort();
}
