// GitHub code-scanning READ leaf (Story 7.14 · MOTIR-1605) — the authenticated
// half of the §10.3 external-scanner detection. motir-ai runs the detection but
// holds NO GitHub credential (the 7.5 ingest invariant — motir-core owns the App
// token), so it probes the code-scanning API UNAUTHENTICATED, which serves only
// PUBLIC repos. This leaf lets motir-core probe the same API WITH a tenant
// installation token (minted via `appAuth`, never persisted, never leaving this
// process), so a PRIVATE connected repo becomes detectable. It is the
// installation-token analogue of motir-ai's `makeGithubCodeScanningClient`, and
// hits the exact same two endpoints.
//
// Purely best-effort: like the git provider's fetches this is a leaf services
// compose, and like the ai-side probe EVERY failure (no code scanning, no
// access, network/timeout, a non-JSON body) returns null — "source absent",
// never an error. §10.3 detection is NEVER a gate.

const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 10_000;
// One page is plenty: we only need "does code scanning exist" + the newest
// analysis per tool, and the API returns newest-first.
const ANALYSES_PER_PAGE = 50;

/** One analysis row off `GET /repos/{o}/{r}/code-scanning/analyses` — the wire
 *  shape motir-ai's proxy client consumes (mirrors ai `CodeScanningAnalysis`). */
export interface CodeScanningAnalysisSummary {
  id: number;
  toolName: string;
  /** ISO `created_at` — motir-ai picks the newest per tool. */
  createdAt: string;
}

/**
 * Parse a repoRef into GitHub owner/name coordinates. The 7.10 feed's canonical
 * shape is "owner/name"; "github.com/owner/name", a bare https URL, and a
 * trailing ".git" are tolerated. Null = not GitHub-shaped. Also the input
 * validation for the URL PATH below — only `[A-Za-z0-9._-]` segments pass, so a
 * caller-supplied ref can never inject into the GitHub request path. (Mirrors
 * motir-ai `parseGithubRepoRef`, deliberately duplicated across the boundary.)
 */
export function parseRepoRef(repoRef: string): { owner: string; name: string } | null {
  let ref = repoRef.trim();
  ref = ref.replace(/^https?:\/\//i, '').replace(/^github\.com\//i, '');
  ref = ref.replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = ref.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || /[^A-Za-z0-9._-]/.test(owner) || /[^A-Za-z0-9._-]/.test(name)) {
    return null;
  }
  return { owner, name };
}

async function ghRequest(token: string, path: string, accept: string): Promise<Response | null> {
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      headers: {
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return null; // network / timeout — unavailable, not an error.
  }
}

/**
 * List the code-scanning analyses for `owner/name` with the installation
 * `token`. Null = code scanning not enabled / no access / unavailable (the
 * detector treats null as "source absent"). Parses GitHub's raw rows into the
 * clean wire shape motir-ai consumes.
 */
export async function fetchCodeScanningAnalyses(
  token: string,
  owner: string,
  name: string,
): Promise<CodeScanningAnalysisSummary[] | null> {
  const res = await ghRequest(
    token,
    `/repos/${owner}/${name}/code-scanning/analyses?per_page=${ANALYSES_PER_PAGE}`,
    'application/vnd.github+json',
  );
  // 404 = code scanning not enabled / no access; any !ok = unavailable.
  if (!res?.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;
  const analyses: CodeScanningAnalysisSummary[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const tool = o['tool'] as Record<string, unknown> | undefined;
    const toolName = typeof tool?.['name'] === 'string' ? tool['name'] : null;
    if (typeof o['id'] === 'number' && toolName) {
      analyses.push({
        id: o['id'],
        toolName,
        createdAt: typeof o['created_at'] === 'string' ? o['created_at'] : '',
      });
    }
  }
  return analyses;
}

/**
 * Fetch ONE analysis's SARIF document (`application/sarif+json`) for
 * `owner/name` with the installation `token`. Returned OPAQUE — motir-ai
 * validates + normalizes it through its §10.1 adapter. Null = unavailable /
 * unfetchable (skipped by the detector, never an error).
 */
export async function fetchCodeScanningSarif(
  token: string,
  owner: string,
  name: string,
  analysisId: number,
): Promise<unknown | null> {
  const res = await ghRequest(
    token,
    `/repos/${owner}/${name}/code-scanning/analyses/${String(analysisId)}`,
    'application/sarif+json',
  );
  if (!res?.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}
