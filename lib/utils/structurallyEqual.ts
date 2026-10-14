/**
 * Deep structural equality over JSON-shaped values (objects, arrays, primitives,
 * `null`) — what decides, when a live surface re-reads, which previous objects
 * it may keep (Story MOTIR-8539).
 *
 * Key order is ignored. `null` and an absent key are DIFFERENT (a field that
 * disappeared is a change), and so are `[]` and `null`. Arrays compare by position.
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
