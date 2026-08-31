import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ONE slug NAME per dynamic position (MOTIR-1789).
//
// Next.js resolves a dynamic segment by position, not by name, so two siblings
// at the same URL position with different names — `work-items/[id]` beside
// `work-items/[key]` — are a contradiction it refuses at runtime:
//
//     Error: You cannot use different slug names for the same dynamic path
//     ('id' !== 'key').
//
// ⚠️ THE BUILD DOES NOT CATCH THIS, which is the whole reason the guard exists.
// `next build` compiled and exited 0 with the conflict live — twice, once
// locally and once on CI — and the type check passed too, because nothing about
// it is a type error. What caught it was the E2E lane's webServer refusing to
// come up, and it does not fail with a route name: it throws on EVERY request,
// so all 14 Playwright shards time out together after ten minutes each and read
// like an infrastructure outage. This file turns twelve minutes of uniform red
// into one named assertion.
//
// ⚠️ IT COMPARES URL PATHS, NOT PARENT DIRECTORIES. Route groups (`(authed)`)
// and parallel-route slots (`@modal`) add no URL segment, so two dynamic
// directories in different groups can still collide at the same position while
// living in unrelated folders. Grouping by the resolved path is what sees that;
// grouping by filesystem parent would not.

const APP = join(process.cwd(), 'app');

/** A directory that contributes no URL segment: a route group or a slot. */
const isTransparent = (name: string): boolean => /^\(.*\)$/.test(name) || name.startsWith('@');

/** `[id]`, `[...rest]`, `[[...rest]]` — anything Next resolves positionally. */
const isDynamic = (name: string): boolean => name.startsWith('[') && name.endsWith(']');

/** URL path → the distinct dynamic segment names declared at that position. */
function slugNamesByPath(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const walk = (dir: string, urlPath: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      if (isDynamic(entry.name)) {
        const at = found.get(urlPath) ?? new Set<string>();
        at.add(entry.name);
        found.set(urlPath, at);
        walk(join(dir, entry.name), `${urlPath}/${entry.name}`);
        continue;
      }
      walk(join(dir, entry.name), isTransparent(entry.name) ? urlPath : `${urlPath}/${entry.name}`);
    }
  };
  walk(APP, '');
  return found;
}

describe('no URL position declares two different dynamic slug names', () => {
  it('finds dynamic segments at all — the scan is asserted before it is trusted', () => {
    // A walk that silently returned nothing would pass the real assertion for
    // the wrong reason, the trap every structural guard in this tree opens with.
    const positions = slugNamesByPath();
    expect(positions.size).toBeGreaterThan(20);
    expect([...positions.values()].every((names) => names.size >= 1)).toBe(true);
  });

  it('⚠️ every position resolves to exactly ONE name', () => {
    const conflicts = [...slugNamesByPath()]
      .filter(([, names]) => names.size > 1)
      .map(([path, names]) => `${path || '/'} → ${[...names].sort().join(' vs ')}`);
    // Named in the message rather than counted: the fix is to rename the newer
    // directory to the name its siblings already use, and the reader needs to
    // know which position and which two names.
    expect(conflicts).toEqual([]);
  });
});
