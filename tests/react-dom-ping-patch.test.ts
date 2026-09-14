import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The React that renders the App Router is PATCHED, and this file is what keeps
// the patch from quietly going away (Bug MOTIR-5255).
//
// ⚠️ WHAT THE PATCH FIXES. The App Router renders with the React that `next`
// VENDORS under `next/dist/compiled/react-dom` — not the `react-dom` in our own
// `package.json` — and `next@16.2.6` vendors `19.3.0-canary-3f0b9e61-20260317`.
// Its `pingSuspendedRoot` DROPS a ping that arrives during the render phase:
//
//     ? 0 === (executionContext & 2) && prepareFreshStack(root, 0)
//     : (workInProgressRootPingedLanes |= pingedLanes)
//
// A Flight chunk that lands while React has yielded on it pings synchronously
// from inside the render phase, the `&&` throws that ping away, and nothing ever
// re-renders the transition. On the item page that is a late `<Suspense>` section
// whose data has ARRIVED and never paints — the acceptance panel still reading
// State B twenty seconds after Turn on, with its switch stuck `disabled` because
// the transition never settles. React fixed it upstream by recording the lanes
// instead (`react-dom@19.3.0`; `next@16.3.x` vendors the fixed build), and the
// patch in `patches/next@16.2.6.patch` is that upstream change, verbatim, on the
// four client builds.
//
// ⚠️ HOW IT WAS IDENTIFIED — measured, not read. With render logs in the page's
// client components, a failing run rendered the eager rail and the LOWER late
// boundary with the post-press tree and never rendered the UPPER one, although
// both RSC responses had finished and carried State A. An unrelated state update
// pressed six seconds later painted State A at once, with no request: the data
// had been there all along and only the wake-up was missing. Removing either the
// action's `revalidatePath` or the panel's `router.refresh()` left the rate
// unchanged (2/24 each), so neither navigation is the cause.
//
// ⚠️ WHY A TEST. A dependency bump is exactly the change that removes a patch
// without anybody deciding to: pnpm refuses a patch whose version no longer
// matches, and the obvious repair is to delete the entry. That repair is right
// only when the new `next` vendors a React that already carries the fix — which
// is what the first test asks of the INSTALLED tree, whatever version it is.
// `tests/e2e/cloud-acceptance-toggle-repaint.spec.ts` is the behavioural detector;
// this is the one that runs on every pull request.

const ROOT = process.cwd();
const requireFromRoot = createRequire(join(ROOT, 'package.json'));
const nextDir = dirname(requireFromRoot.resolve('next/package.json'));
const nextVersion = (
  JSON.parse(readFileSync(join(nextDir, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** The four vendored client builds the App Router can load. */
const CLIENT_BUILDS = [
  'react-dom-client.production.js',
  'react-dom-client.development.js',
  'react-dom-profiling.profiling.js',
  'react-dom-profiling.development.js',
];

/** `pingSuspendedRoot`'s body, up to the function that follows it in every build. */
function pingSuspendedRoot(build: string): string {
  const source = readFileSync(join(nextDir, 'dist/compiled/react-dom/cjs', build), 'utf8');
  const start = source.indexOf('function pingSuspendedRoot(');
  const end = source.indexOf('function retryTimedOutBoundary(', start);
  expect(start, `${build}: pingSuspendedRoot not found — the vendored build moved`).toBeGreaterThan(
    -1,
  );
  expect(end, `${build}: pingSuspendedRoot's end not found`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('the vendored React records a ping that lands during render', () => {
  it.each(CLIENT_BUILDS)('%s', (build) => {
    const body = pingSuspendedRoot(build).replace(/\s+/g, ' ');
    // The dropped-ping shape, in either the minified-constant or the named form.
    expect(body).not.toMatch(/=== ?(?:0|NoContext) ?&& ?prepareFreshStack\(root, 0\)/);
    expect(body).not.toMatch(/0 === \(executionContext & 2\) && prepareFreshStack\(root, 0\)/);
    // The fixed shape: outside render it restarts, inside render it records the lanes.
    expect(body).toMatch(
      /(?:0 === \(executionContext & 2\)|\(executionContext & RenderContext\) === NoContext) \? prepareFreshStack\(root, 0\) : \(workInProgressRootPingedLanes \|= pingedLanes\)/,
    );
  });
});

describe('the patch is wired where every install reads it', () => {
  const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const patched = /^patchedDependencies:\n((?: {2}.+\n?)+)/m.exec(workspace)?.[1] ?? '';

  it('names the installed next, or is gone because that next no longer needs it', () => {
    const entry = /next@([^:]+): patches\/next@[^\s]+\.patch/.exec(patched);
    // No entry is legal ONLY because the `it.each` above passed on an unpatched
    // tree — i.e. the installed `next` vendors a fixed React.
    if (entry)
      expect(entry[1], 'the next patch targets a version that is not installed').toBe(nextVersion);
  });

  it("the image's install stage copies the patch before `pnpm install`", () => {
    if (!/next@/.test(patched)) return;
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const deps = dockerfile.slice(dockerfile.indexOf('AS deps'), dockerfile.indexOf('AS builder'));
    const copy = deps.indexOf('COPY patches ./patches');
    expect(
      copy,
      'the deps stage installs without patches/ — the image would ship unpatched or fail',
    ).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(deps.indexOf('pnpm install'));
  });
});
