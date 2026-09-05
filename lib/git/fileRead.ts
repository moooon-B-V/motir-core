// The provider-agnostic parts of the FILE-READ capability
// (Story MOTIR-4585 · MOTIR-4586): the repository-relative path guard, and the
// two small measurements both providers make on a response.
//
// ⚠️ IT LIVES BESIDE THE SEAM, NOT INSIDE ONE PROVIDER, AND EVERY PROVIDER CALLS
// IT FIRST. The path a `read_file` carries is MODEL-SUPPLIED — it is the one
// argument of the whole capability that is not bound from the job context — so
// the refusal has to be a property of the seam rather than of whichever call
// site happened to remember it. A guard written once at the route would be
// correct today and absent the first time anything else reaches a provider
// directly.
//
// ⚠️ AND IT REFUSES BEFORE ANY HOST CALL, WHICH IS THE POINT. Both hosts would
// very likely 404 a traversal anyway, and that is not the guarantee being made:
// a 404 is the HOST deciding, over the network, with our credential attached,
// and it is indistinguishable in a log from an honest miss. Refusing here means
// no request carrying a traversal is ever issued at all — which is what makes
// "a path outside the named repository cannot be reached" a fact about this
// code rather than a bet on two third parties.

/** Why a path was refused. Rendered to the caller verbatim, so it says what to
 *  fix rather than that something was wrong. */
export type RepoPathRefusal = string;

export interface RepoPathOk {
  ok: true;
  /** The path in its canonical form — no leading slash, no `./`, no `//`. */
  path: string;
}

export interface RepoPathRefused {
  ok: false;
  reason: RepoPathRefusal;
}

/**
 * Normalize a repository-relative file path, or refuse it.
 *
 * REFUSED: an absolute path (`/etc/passwd`), a Windows drive or UNC path, any
 * `..` segment however it is spelled or nested, a URL, an empty path, a NUL or
 * newline (header/URL smuggling), and anything over {@link MAX_REPO_PATH_LENGTH}.
 *
 * ACCEPTED and normalized: a leading `./`, redundant separators, a trailing
 * slash on a directory-looking path (the host answers for it; that is the
 * host's business, not the guard's).
 *
 * ⚠️ THE `..` CHECK IS PER-SEGMENT, NOT A SUBSTRING SCAN. `src/..foo/bar.ts` is
 * a legal path with a file whose name begins with two dots, and a
 * `path.includes('..')` guard refuses it — a guard that is wrong in the
 * direction nobody notices, because the only report is a model being told a
 * real file does not exist.
 */
export const MAX_REPO_PATH_LENGTH = 1024;

export function normalizeRepoFilePath(raw: string): RepoPathOk | RepoPathRefused {
  const refuse = (reason: string): RepoPathRefused => ({ ok: false, reason });

  if (typeof raw !== 'string') return refuse('the path must be a string');
  const path = raw.trim();
  if (!path) return refuse('the path is empty');
  if (path.length > MAX_REPO_PATH_LENGTH) {
    return refuse(`the path is longer than ${MAX_REPO_PATH_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return refuse('the path contains a control character');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return refuse('the path must be repository-relative, not a URL');
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    return refuse('the path must be repository-relative, not absolute');
  }
  if (/^[a-z]:[\\/]/i.test(path)) {
    return refuse('the path must be repository-relative, not a drive path');
  }

  const segments = path.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return refuse('the path names no file');
  if (segments.some((s) => s === '..')) {
    return refuse('the path must not traverse out of the repository ("..")');
  }

  return { ok: true, path: segments.join('/') };
}

/**
 * The byte length of a decoded string — what the cap is measured in.
 *
 * ⚠️ `text.length` IS NOT THIS. It counts UTF-16 code units, so a file of CJK
 * prose or emoji measures roughly a third to a half of its real size, and a cap
 * enforced on it lets through a payload well over the bound while reporting
 * that it did not. The bound exists to protect a model's context and a
 * function's heap, and both are spent in bytes.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * A short, SAFE description of a failed response, for a thrown error's message.
 *
 * ⚠️ IT IS TRUNCATED AND IT IS NEVER THE WHOLE BODY. An error message travels
 * into logs and, on some paths, into a response — and a host's error body can
 * echo the request, headers included. Taking the first 200 characters of text
 * is enough for an operator to recognise the failure and small enough that a
 * whole echoed request cannot ride along inside it.
 */
export async function describeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}
