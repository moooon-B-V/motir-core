import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UNTRACKED_BY_DESIGN,
  describeFinding,
  exemptionKey,
  scanSource,
  scanTests,
} from './mcpRouteCallScan';

// MOTIR-6408 — no test calls an `/api/mcp` route handler in-process without
// registering the call with `trackServerWork`. The why, and what counts as a
// call, is in `mcpRouteCallScan.ts`; this file holds the verdict and the proof
// that the verdict can go red.
//
// It reads the tree as data and opens no database, so it runs in the
// structural-guard lane (`tests/helpers/structuralGuardLane.ts`).

const ROOT = resolve(__dirname, '..', '..');

describe('every in-process /api/mcp handler call in tests/ is tracked (MOTIR-6408)', () => {
  const findings = scanTests(ROOT);

  it('finds no untracked call outside the reviewed register', () => {
    const unexpected = findings.filter((f) => !(exemptionKey(f) in UNTRACKED_BY_DESIGN));
    expect(
      unexpected.map(describeFinding),
      `These call an /api/mcp route handler in-process without trackServerWork. The MCP SDK ` +
        `starts an SSE-stream GET it never awaits, so an untracked handler can still be inside ` +
        `its auth or rate-limit transaction when the test ends, and the in-flight probe then ` +
        `fails whichever test it lands in (MOTIR-6324). Drive the route through ` +
        `mcpRouteFetch(token) from tests/helpers/mcpRouteFetch.ts, or wrap the call in ` +
        `trackServerWork(...) from tests/helpers/serverWork.ts.`,
    ).toEqual([]);
  });

  it('every register entry still matches a real call — none outlives its call site', () => {
    const matched = new Set(findings.map(exemptionKey));
    for (const [key, reason] of Object.entries(UNTRACKED_BY_DESIGN)) {
      expect(matched.has(key), `${key} matches nothing; delete the entry`).toBe(true);
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it('reads the tree it guards — the shared helper and the dispatcher are seen, and pass', () => {
    // Without this every assertion above passes on a scan that parsed nothing.
    for (const file of [
      'tests/helpers/mcpRouteFetch.ts',
      'tests/helpers/mcpHttpServer.ts',
      'tests/mcp/route.test.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source).toMatch(/app\/api\/mcp\/route/);
      expect(scanSource(file, source).map(describeFinding)).toEqual([]);
    }
  });
});

describe('the scan goes RED on the shapes that leak — demonstrated, not assumed', () => {
  // The exact private copy MOTIR-6408 removed from two files, verbatim.
  const PLANTED_ROUTE_FETCH = `import * as route from '@/app/api/mcp/route';

function routeFetch(token: string): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', \`Bearer \${token}\`);
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
    return handler(new Request(url, { ...init, headers }) as never);
  }) as unknown as typeof fetch;
}
`;

  it('a planted private routeFetch — named by file and line', () => {
    const found = scanSource('tests/planted/leak.test.ts', PLANTED_ROUTE_FETCH);
    expect(found.map(describeFinding)).toEqual([
      'tests/planted/leak.test.ts:10:12 [call] handler(new Request(url, { ...init, headers }) as never)',
    ]);
    expect(found[0]!.enclosing).toBe('routeFetch');
  });

  it('the same copy, tracked, passes', () => {
    const tracked = PLANTED_ROUTE_FETCH.replace(
      'return handler(new Request(url, { ...init, headers }) as never);',
      'return trackServerWork(handler(new Request(url, { ...init, headers }) as never));',
    );
    expect(tracked).not.toBe(PLANTED_ROUTE_FETCH);
    expect(scanSource('tests/planted/tracked.test.ts', tracked)).toEqual([]);
  });

  it.each([
    [
      'a direct call, even awaited',
      `import * as mcp from '@/app/api/mcp/route';\nasync function t(req: Request) {\n  return await mcp.POST(req as never);\n}\n`,
      ['tests/x.test.ts:3:16 [call] mcp.POST(req as never)'],
    ],
    [
      'a named import, called',
      `import { GET as get } from '../../app/api/mcp/route';\nget(new Request('http://x'));\n`,
      ["tests/x.test.ts:2:1 [call] get(new Request('http://x'))"],
    ],
    [
      'a dynamic import bound to a name',
      `async function t() {\n  const r = await import('@/app/api/mcp/route');\n  r['DELETE'](new Request('http://x'));\n}\n`,
      ["tests/x.test.ts:3:3 [call] r['DELETE'](new Request('http://x'))"],
    ],
    [
      'a dynamic import the scan cannot follow',
      `void import('@/app/api/mcp/route').then((m) => m.GET);\n`,
      ["tests/x.test.ts:1:6 [unbound] import('@/app/api/mcp/route')"],
    ],
    [
      'a handler handed on to be called elsewhere',
      `import * as route from '@/app/api/mcp/route';\nconst handlers = [route.GET];\n`,
      ['tests/x.test.ts:2:19 [escape] route.GET'],
    ],
    [
      'the module handed on by a file that tracks nothing',
      `import * as route from '@/app/api/mcp/route';\nconst routes = new Map([['/api/mcp', route]]);\n`,
      ['tests/x.test.ts:2:38 [escape] route'],
    ],
  ])('%s', (_label, source, expected) => {
    expect(scanSource('tests/x.test.ts', source).map(describeFinding)).toEqual(expected);
  });

  it.each([
    [
      'identity and type checks',
      `import * as route from '@/app/api/mcp/route';\nexpect(typeof route.GET).toBe('function');\nexpect(route.GET).toBe(route.POST);\ntype R = typeof route;\nexpect(route.runtime).toBe('nodejs');\n`,
    ],
    [
      'a direct call inside trackServerWork',
      `import { POST } from '@/app/api/mcp/route';\nvoid trackServerWork(POST(new Request('http://x') as never));\n`,
    ],
    ['a file that does not touch the route', `import { db } from '@/lib/db';\nvoid db;\n`],
  ])('%s passes', (_label, source) => {
    expect(scanSource('tests/x.test.ts', source)).toEqual([]);
  });
});
