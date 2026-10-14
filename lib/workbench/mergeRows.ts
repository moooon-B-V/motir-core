// ROWS MERGED BY IDENTITY (Story MOTIR-8539 · Subtask MOTIR-8574) — what lets a
// re-read land without re-rendering what did not change.
//
// A re-read answers with fresh objects for every row, equal or not. Handing
// those straight to React re-renders every row and lets every memo miss, which
// is the cost the story exists to remove. So a row that is STRUCTURALLY equal to
// the one already on screen keeps the previous object, a changed row takes the
// incoming one, and when nothing changed at all the previous ARRAY comes back —
// so a state update with it is no update, and React renders nothing.
//
// ⚠️ IT NEVER REORDERS. The result is in the incoming order, always: the server
// decides the order, and the merge only decides which object stands for a row.
//
// Pure, no React — `useWorkbenchWindow` and the list components call it.

/** How a caller names a row — its identity across re-reads. */
export type RowIdOf<T> = (row: T) => string;

/**
 * Deep structural equality over JSON-shaped values: key order ignored, `null`
 * and an absent key are DIFFERENT (a field that disappeared is a change).
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!structurallyEqual(a[i], other[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!structurallyEqual(left[key], right[key])) return false;
  }
  return true;
}

/**
 * `next`, with every row structurally equal to its predecessor in `prev`
 * replaced by that predecessor — and `prev` itself when every row is equal and
 * the order is unchanged.
 */
export function mergeRowsByIdentity<A extends readonly unknown[]>(
  prev: A,
  next: A,
  idOf: RowIdOf<A[number]>,
): A {
  const previous = new Map(prev.map((row) => [idOf(row), row]));
  let unchanged = prev.length === next.length;
  const merged = next.map((row, index) => {
    const before = previous.get(idOf(row));
    const kept = before !== undefined && structurallyEqual(before, row) ? before : row;
    if (kept !== prev[index]) unchanged = false;
    return kept;
  });
  return unchanged ? prev : (merged as unknown as A);
}

/** `next` when it differs structurally from `prev`, else `prev` — for a single value. */
export function keepIfEqual<T>(prev: T, next: T): T {
  return structurallyEqual(prev, next) ? prev : next;
}
