// Resolving the ADDRESS of a pull request — `(owner, name, number)` — from the
// two forms a caller actually holds (Task MOTIR-5048).
//
// ── Why this is its OWN module ─────────────────────────────────────────────
// It was `lib/mcp/tools/linkPullRequest.ts`'s private helper while exactly one
// door took a coordinate. There are two now: that MCP tool and
// `POST /api/v1/work-items/{key}/pull-requests`, and a v1 route may not import
// from `@/lib/mcp/` — the planning story gate enforces it, on the reasoning that
// the two transports align through the SERVICE and an import across them is how
// they start sharing a shape neither owns.
//
// The alternative is to re-derive the parse in the v1 layer, the way
// `lib/api/v1/workItems/resolveKey.ts` re-derives key normalization, and it is
// wrong HERE for a reason that does not apply there: a key parse that drifts
// yields a 404 the caller sees immediately, while a coordinate parse that drifts
// yields a link on the WRONG pull request under a success response. Two doors
// that disagree about what `url` means would be discovered by nobody. So the
// parser moves DOWN to a leaf both may import rather than being copied sideways.
//
// `lib/mcp/tools/linkPullRequest.ts` re-exports `resolveCoordinate`, so its own
// importers (`unlinkPullRequest.ts`) are unchanged.

/**
 * A pull-request URL as `gh pr create` prints it —
 * `https://github.com/<owner>/<name>/pull/<number>`.
 *
 * Host-agnostic on purpose (a GitHub Enterprise deployment serves the same path
 * shape under its own hostname), and the segment count is pinned so a URL that
 * merely CONTAINS `/pull/` somewhere cannot be misread as a coordinate.
 */
const PULL_REQUEST_URL_RE = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** `owner/name`, as a repository is connected. */
const REPOSITORY_RE = /^([^/\s]+)\/([^/\s]+)$/;

/** The coordinate a call resolved to, or the argument fault that stopped it. */
export type Coordinate =
  | { ok: true; owner: string; name: string; number: number }
  | { ok: false; message: string };

/**
 * Resolve `(owner, name, number)` from either address form.
 *
 * Both forms are accepted and CROSS-CHECKED rather than ranked, because a
 * disagreement between them is a caller mistake with a silent wrong answer: pick
 * one arbitrarily and the link lands on a real pull request that is not the one
 * the caller meant, under a success message.
 */
export function resolveCoordinate(args: {
  repository?: string;
  number?: number;
  url?: string;
}): Coordinate {
  let fromUrl: { owner: string; name: string; number: number } | null = null;
  if (args.url !== undefined) {
    const m = PULL_REQUEST_URL_RE.exec(args.url);
    if (!m) {
      return {
        ok: false,
        message:
          '`url` is not a pull-request URL. Expected ' +
          '"https://<host>/<owner>/<name>/pull/<number>", the form `gh pr create` prints.',
      };
    }
    fromUrl = { owner: m[1]!, name: m[2]!, number: Number(m[3]!) };
  }

  let fromPair: { owner: string; name: string; number: number } | null = null;
  if (args.repository !== undefined || args.number !== undefined) {
    if (args.repository === undefined || args.number === undefined) {
      return {
        ok: false,
        message: '`repository` and `number` go together — give both, or give `url` instead.',
      };
    }
    const m = REPOSITORY_RE.exec(args.repository);
    if (!m) {
      return { ok: false, message: '`repository` must be "owner/name", e.g. "acme/web".' };
    }
    fromPair = { owner: m[1]!, name: m[2]!, number: args.number };
  }

  const resolved = fromUrl ?? fromPair;
  if (!resolved) {
    return {
      ok: false,
      message:
        'Address the pull request: either `url`, or `repository` + `number`. ' +
        'After `gh pr create`, `url` is the line it printed.',
    };
  }
  if (
    fromUrl &&
    fromPair &&
    (fromUrl.number !== fromPair.number ||
      fromUrl.owner.toLowerCase() !== fromPair.owner.toLowerCase() ||
      fromUrl.name.toLowerCase() !== fromPair.name.toLowerCase())
  ) {
    return {
      ok: false,
      message:
        `\`url\` names ${fromUrl.owner}/${fromUrl.name}#${fromUrl.number} but ` +
        `\`repository\` + \`number\` name ${fromPair.owner}/${fromPair.name}#${fromPair.number}. ` +
        'Send one address, not two that disagree.',
    };
  }
  return { ok: true, ...resolved };
}
