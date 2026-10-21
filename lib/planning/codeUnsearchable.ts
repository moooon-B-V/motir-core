// THE CODE-CAN'T-BE-SEARCHED FACE (Story MOTIR-9165 · MOTIR-9167): which target
// repositories motir-ai stopped a planning phase on, and why.
//
// motir-ai refuses to plan over a TARGET repository that has no usable code graph —
// `read_file` verifies a path a session already knows and discovers nothing — and
// reports the stop two ways, both carrying the same list:
//
//   * a mid-walk RUN PAUSE of kind `code_unsearchable` (`planChangeRunPauseService`);
//   * a conversation job that ENDED without opening a planning job, whose result
//     carries `codeUnsearchable: { repos }` (read here, stored on the assistant turn).
//
// The states are the closed vocabulary motir-ai's `codeSearchGate` and this repo
// share. A graph that EXISTS but trails the default branch is NOT one of them:
// planning goes on over a stale graph.

export const CODE_UNSEARCHABLE_STATES = [
  'never_indexed',
  'indexing',
  'refresh_failing',
  'paused',
  'provider_unsupported',
  'unavailable',
] as const;

export type CodeUnsearchableState = (typeof CODE_UNSEARCHABLE_STATES)[number];

/** One blocked target repository: its `owner/name` ref and why its code cannot be searched. */
export interface CodeUnsearchableRepo {
  repoRef: string;
  state: CodeUnsearchableState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCodeUnsearchableState(value: unknown): value is CodeUnsearchableState {
  return (
    typeof value === 'string' && (CODE_UNSEARCHABLE_STATES as readonly string[]).includes(value)
  );
}

/**
 * Validate a blocked-repository list. Returns the typed list, or `null` when it is
 * not a non-empty array of `{ repoRef, state }` with a known state. TOTAL over any
 * input: an arbitrary JSON value is a legitimate argument and yields `null`.
 */
export function parseCodeUnsearchableRepos(value: unknown): CodeUnsearchableRepo[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: CodeUnsearchableRepo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const repoRef = entry['repoRef'];
    const state = entry['state'];
    if (typeof repoRef !== 'string' || repoRef.trim().length === 0) return null;
    if (!isCodeUnsearchableState(state)) return null;
    out.push({ repoRef: repoRef.trim(), state });
  }
  return out;
}

/**
 * The blocked list a conversation job's result carries (`codeUnsearchable: { repos }`),
 * or `null` for any result without one. Total, like `readCodeUnreadable`: a result
 * that carries nothing readable is an ordinary job, never an error.
 */
export function readCodeUnsearchable(result: unknown): CodeUnsearchableRepo[] | null {
  if (!isRecord(result)) return null;
  const signal = result['codeUnsearchable'];
  if (!isRecord(signal)) return null;
  return parseCodeUnsearchableRepos(signal['repos']);
}
