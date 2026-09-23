import { acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';

// THE PATH-REFERENCE advisory (MOTIR-5424) — the pure half. The service half,
// which reads the other work items and asks the repository host, is
// `lib/services/pathReferenceAdvisoryService.ts`.
//
// The rule. `core.md` gate 4 says an acceptance criterion naming a not-`done`
// work item is a missing `blocked_by` until proven otherwise, and the
// `reference` advisory mechanises it by scanning for `motir:` KEYS. A criterion
// can name a sibling's deliverable by FILE PATH instead — the natural way to
// write a design citation or a test-helper reference — and then neither the gate
// nor the key detector sees it (MOTIR-4856 is the record, and the red design
// lane it cost). This check reads the PATH:
//
//   a card X fires for path P when
//     (1) one of X's acceptance criteria names P,
//     (2) P does NOT resolve on the default branch of X's own repository,
//     (3) P's TOP-LEVEL directory DOES resolve there, and
//     (4) another not-`done` work item Y also names P, with no `blocked_by`
//         between X and Y in either direction — at the cards themselves or at
//         any of their ancestors.
//
// ⚠️ (2) AND (4) TOGETHER ARE THE WHOLE DISCRIMINATOR, and both were measured
// before they were written (the MOTIR-5204 sweep, 520 open work items). A path
// that does not exist yet is named by exactly ONE work item most of the time —
// the card that will create it — and that card is right; only a path named by
// TWO OR MORE is one card creating and another citing. Drop (4) and the check
// reports every card that names its own deliverable (37 of 49 as measured).
//
// ⚠️ (3) IS THE THIRD-PARTY GUARD. The same sweep met two work items citing
// `src/install-pnpm/run.ts` — a file in `pnpm/action-setup`, created by neither
// and resolving in no repository the workspace holds. A forward reference lands
// in a directory the repository ALREADY HAS (`design/`, `tests/`, `lib/`); a
// path whose top-level directory is absent too is somebody else's file, a
// repo-qualified spelling (`motir-ai/src/x.ts` read against `motir-core`), or a
// URL, and none of those is a missing edge.
//
// ⚠️ ADVISORY, NEVER A BLOCKER — the same contract as every family on the
// channel (`WorkItemProseReferenceAdvisoryDto` states it). Two cards naming one
// not-yet-existing file are USUALLY creator and consumer, not always.

/**
 * A path-like token for THIS check — {@link PATH_TOKEN_RE}'s class in
 * `proseVsGraph.ts` WIDENED by `(`, `)`, `[` and `]`, because the repository this
 * was written against routes through Next.js segments: `app/(authed)/home/page.tsx`
 * and `app/api/items/[key]/route.ts`. Under the narrower class the first of those
 * reads as `home/page.tsx`, which is the wrong path and would be the finding's
 * whole message. The brackets a sentence wraps AROUND a path are trimmed after
 * the match ({@link normalizePathToken}).
 */
const FILE_PATH_TOKEN_RE = /[A-Za-z0-9_.@()[\]-]+(?:\/[A-Za-z0-9_.@()[\]-]+)+/g;

/** The corpus writes paths in backticks; bold and italics wrap them too. */
const INLINE_MARKUP_RE = /[`*]/g;

/** The last segment must carry an extension — a FILE, not a directory or a URL. */
const EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/** How many of one bracket kind a string holds. */
const count = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * Trim the punctuation a sentence puts around a path, keeping the brackets the
 * path itself carries. `(lib/x.ts)` → `lib/x.ts`; `app/(authed)/page.tsx` is left
 * alone because its parentheses balance; `lib/db.ts.` loses the full stop.
 */
function normalizePathToken(raw: string): string {
  let token = raw;
  for (;;) {
    const before = token;
    token = token.replace(/[.,;]+$/, '');
    if (token.endsWith(')') && count(token, ')') > count(token, '(')) token = token.slice(0, -1);
    if (token.endsWith(']') && count(token, ']') > count(token, '[')) token = token.slice(0, -1);
    if (token.startsWith('(') && count(token, '(') > count(token, ')')) token = token.slice(1);
    if (token.startsWith('[') && count(token, '[') > count(token, ']')) token = token.slice(1);
    // A WRAPPING pair balances, so the two tests above leave it. A real path
    // cannot both open a segment with `(` and end on `)` — its last segment ends
    // in an extension — so `(lib/x.ts)` and `[lib/x.ts]` are prose around a path.
    if (/^\(.*\)$|^\[.*\]$/.test(token)) token = token.slice(1, -1);
    if (token === before) return token;
  }
}

/**
 * Whether a normalized token is a repository-relative FILE path this check may
 * ask about. Drops, as prose:
 *  - a token with no extension on its last segment (a directory, a URL route);
 *  - a segment of dots only (`.../pnpm-lock.json`, an elision, not a path);
 *  - a first segment that reads as a HOST (`app.motir.co/api/x.ts`,
 *    `github.com/o/r/blob/x.md`) — a dot inside it, not leading it. A leading dot
 *    is a dot-directory and is kept (`.github/workflows/ci.yml`).
 */
function isRepoFilePath(token: string): boolean {
  const segments = token.split('/');
  if (segments.length < 2 || segments.some((s) => s.length === 0)) return false;
  if (segments.some((s) => /^\.+$/.test(s))) return false;
  const first = segments[0] as string;
  if (!first.startsWith('.') && first.includes('.')) return false;
  return EXTENSION_RE.test(segments[segments.length - 1] as string);
}

/** Every repository file path in `text`, in order, deduped. */
function filePathsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.replace(INLINE_MARKUP_RE, '').matchAll(FILE_PATH_TOKEN_RE)) {
    const token = normalizePathToken(m[0]);
    if (!isRepoFilePath(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** A file path an acceptance criterion names, and which criterion (1-based). */
export interface CriterionFilePath {
  path: string;
  criterionIndex: number;
}

/**
 * Every file path the ACCEPTANCE CRITERIA name, each attributed to the FIRST
 * criterion naming it, numbered as every other criterion-scoped check numbers
 * them ({@link acceptanceCriteriaTexts}) so one card's findings are read against
 * one numbering. A body with no acceptance-criteria heading names none.
 *
 * AC-scoped, deliberately, on the X side only: gate 4 is about what a card is
 * CLOSED AGAINST, and a path in its Context refs is something it read, not
 * something it waits for.
 */
export function criterionFilePaths(md: string | null | undefined): CriterionFilePath[] {
  const out: CriterionFilePath[] = [];
  const seen = new Set<string>();
  acceptanceCriteriaTexts(md).forEach((criterion, i) => {
    for (const path of filePathsIn(criterion)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, criterionIndex: i + 1 });
    }
  });
  return out;
}

/**
 * Every file path the WHOLE body names — the Y side's reading. A card that will
 * create a file names it wherever it likes (its title line, its body, its
 * criteria), so the second namer is looked for everywhere.
 */
export function bodyNamedFilePaths(md: string | null | undefined): ReadonlySet<string> {
  return new Set(md ? filePathsIn(md) : []);
}

/** The first segment — the directory a forward reference must land in. */
export function topLevelDirectory(path: string): string {
  return path.split('/')[0] as string;
}

/**
 * Whether two cards ship in a repository in common — the Y side's narrowing. A
 * card carrying NO repository has not said where it ships, so it is read as
 * possibly any (the honest reading, and the one the subsumption check takes); a
 * card carrying a DIFFERENT set names a different file that happens to share a
 * spelling (`lib/db.ts` exists in three repositories).
 */
export function sharesRepository(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const lower = new Set(a.map((r) => r.toLowerCase()));
  return b.some((r) => lower.has(r.toLowerCase()));
}

/** What the host said about one path in one repository. */
export type PathPresence = 'present' | 'absent' | 'unknown';

/**
 * The resolution verdict for one path across the card's repositories — the (2)
 * and (3) of the rule, decided in one place.
 *
 * Returns the repository the forward reference lands in, or `null` when there is
 * no finding. **`unknown` anywhere is `null`**: an unreachable host, a
 * disconnected repository or a mint failure is "we could not ask", and a check
 * that cannot ask stays silent rather than reporting every path it could not
 * check — a false entry costs a reader more than a missed one on a channel that
 * never blocks.
 */
export function forwardReferenceRepo(
  byRepo: ReadonlyArray<{ repo: string; path: PathPresence; directory: PathPresence }>,
): string | null {
  if (byRepo.length === 0) return null;
  if (byRepo.some((r) => r.path !== 'absent')) return null;
  const home = byRepo.find((r) => r.directory === 'present');
  if (home) return home.repo;
  return null;
}
