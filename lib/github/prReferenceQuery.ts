/**
 * Parse a pull-request REFERENCE out of a picker query — MOTIR-5150.
 *
 * The link picker's grammar was four `contains` clauses (title / repo owner /
 * repo name / a bare number), which serves one gesture well: you half-remember
 * what the pull request was called, you type a few words, you pick it. It is not
 * the gesture somebody linking a pull request actually has. They have the pull
 * request OPEN in another tab, so what is in their hand is its URL — and a URL
 * is not all digits and is not a SUBSTRING OF the title, the owner or the name,
 * so it matched nothing, deterministically, whether or not the pull request was
 * ingested. The one form that did work, a bare number, is undiscoverable and
 * ambiguous across repositories.
 *
 * So this recognises the four forms a person reaches for and turns them into
 * COORDINATES, which the repository then matches EXACTLY on `(owner, name,
 * number)` rather than by substring:
 *
 *   https://github.com/moooon-B-V/motir-ai/pull/466   → owner + name + number
 *   moooon-B-V/motir-ai#466                           → owner + name + number
 *   motir-ai#466                                      → name + number
 *   #466                                              → number
 *
 * ⚠️ AN ADDED ARM, NEVER A REPLACEMENT. The free-text clauses stay: a reference
 * that parses is ORed with them, so `466` keeps matching the bare-number clause
 * and a title search is untouched. Nothing here narrows what used to be found.
 *
 * ⚠️ AND IT DECIDES NOTHING ABOUT TENANCY. The caller's workspace gate is a
 * separate, ANDed clause in `searchCandidates`; a coordinate naming a repository
 * in another workspace parses perfectly well here and returns no candidate
 * there, which is where that decision belongs.
 */

/** A pull-request coordinate a query named. `owner`/`name` absent = unconstrained. */
export interface PullRequestReference {
  owner?: string;
  name?: string;
  number: number;
}

/** GitHub's own shapes: an owner is alphanumeric + hyphen, a repo name also
 *  admits `.` and `_`. Kept tight so an arbitrary sentence containing a slash
 *  and a hash does not read as a coordinate. */
const OWNER = '[A-Za-z0-9][A-Za-z0-9-]*';
const NAME = '[A-Za-z0-9._-]+';

/** `…/<owner>/<name>/pull/<n>` on any host, with whatever GitHub appends —
 *  `/files`, `/commits/<sha>`, a `?w=1`, a `#discussion_r…` anchor. */
const URL_FORM = new RegExp(`^https?://[^/\\s]+/(${OWNER})/(${NAME})/pull/(\\d+)(?:[/?#].*)?$`);

/** `<owner>/<name>#<n>` */
const OWNER_NAME_HASH = new RegExp(`^(${OWNER})/(${NAME})#(\\d+)$`);

/** `<name>#<n>` */
const NAME_HASH = new RegExp(`^(${NAME})#(\\d+)$`);

/** `#<n>` */
const HASH = /^#(\d+)$/;

/**
 * The digit cap — nine, which keeps every value well inside a safe integer (so
 * no separate `isSafeInteger` arm is needed) and is already four orders of
 * magnitude past any real pull-request number.
 */
const MAX_DIGITS = 9;

function toNumber(digits: string): number | null {
  if (digits.length > MAX_DIGITS) return null;
  const n = Number(digits);
  // `#0` is not a pull request, and a leading-zero form (`#0466`) is not one
  // either — GitHub never renders one, so matching it would be inventing a form.
  // The round-trip is what rejects the second: `Number('0466')` is 466.
  if (n <= 0 || String(n) !== digits) return null;
  return n;
}

/**
 * Read a pull-request reference out of a raw query, or `null` when the query is
 * free text. The query is trimmed; nothing else about it is interpreted.
 */
export function parsePullRequestReference(query: string): PullRequestReference | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const url = URL_FORM.exec(trimmed);
  if (url) {
    const number = toNumber(url[3]!);
    return number === null ? null : { owner: url[1]!, name: url[2]!, number };
  }

  const ownerName = OWNER_NAME_HASH.exec(trimmed);
  if (ownerName) {
    const number = toNumber(ownerName[3]!);
    return number === null ? null : { owner: ownerName[1]!, name: ownerName[2]!, number };
  }

  const name = NAME_HASH.exec(trimmed);
  if (name) {
    const number = toNumber(name[2]!);
    return number === null ? null : { name: name[1]!, number };
  }

  const hash = HASH.exec(trimmed);
  if (hash) {
    const number = toNumber(hash[1]!);
    return number === null ? null : { number };
  }

  return null;
}
