// The property NAMES a payload carries on the wire, at every depth, and the
// ones a forbidden-field pattern matches (MOTIR-7349).
//
// A "nothing of X crosses the boundary" assertion is about FIELDS. Written as a
// regex over `JSON.stringify(payload)` it scans the VALUES too, and a payload
// that carries generated ids then fails at random: a cuid is random base-36
// text, so `/cost/i` matches one now and then. `hostedRunCharge.test.ts` did
// exactly that and ejected unrelated pull requests from the merge queue.
//
// The value is round-tripped through JSON first, so the keys are the ones the
// wire carries (`toJSON`, dropped `undefined`s), not the in-memory object's.

export function payloadKeys(value: unknown): string[] {
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  const json = JSON.stringify(value);
  if (json !== undefined) walk(JSON.parse(json));
  return keys;
}

export function leakedKeys(value: unknown, forbidden: RegExp): string[] {
  return payloadKeys(value).filter((key) => forbidden.test(key));
}
