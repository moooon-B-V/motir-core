import { NextResponse } from 'next/server';
import { cliCommandsDocument } from '@/lib/apiDocs/cli';

// GET /api/docs/cli-commands.json — the PUBLISHED CLI command catalogue
// (Story MOTIR-3875 · Subtask MOTIR-4390; `docs/decisions/public-surface-hosts.md`
// AMENDMENT 5, the same door `/api/docs/mcp-tools.json` came through).
//
// ── What it is ──────────────────────────────────────────────────────────────
// Every command `@motir/cli` registers, with its argument signature, its
// description, its help group and every published flag — plus the package name,
// the version this document describes, the install line, the node requirement
// and the default server. It is the artifact `motir.co/docs/cli` renders at
// request time, the way `/docs/api` renders `/api/openapi/v1.json`, so that a
// second repository never keeps a copy of a record only this one can hold true.
//
// ── Why it exists at all: there was NO door ─────────────────────────────────
// `motir.co/docs/cli` was five sentences of positioning with no install line, no
// authentication, no command list and no flags — and it could not do better,
// because `@motir/cli@0.4.0` publishes `exports: { "./package.json": … }` and
// nothing else. `COMMAND_CATALOG` sits inside `dist/index.js`, reachable by no
// import. MOTIR-4390's own header in `lib/apiDocs/cli.ts` carries the two
// mechanisms that were weighed, the one chosen, and why — including the answer
// to *"does the page document the published CLI or the CLI at `main`?"*, which
// is why `packageVersion` is in the body.
//
// ── The four properties that make an unauthenticated handler safe here ──────
// Identical to the MCP catalogue's, and asserted the same way. It authenticates
// nothing, reads no database, takes no user input (the handler has no request
// parameter at all) and spends no rate-limit budget — it serializes a value
// assembled from compile-time declarations. `tests/api/docs/cli-commands-route.test.ts`
// asserts each against this file's source rather than trusting this comment, and
// asserts TOTALITY: every entry of `COMMAND_CATALOG` reaches the served
// document, which typecheck cannot see.
//
// ── UNVERSIONED, deliberately ───────────────────────────────────────────────
// Not part of the `v1` contract. The CLI versions itself through npm, and this
// document DESCRIBES that surface for a reader. What a consumer may rely on:
// this path, and the field names (`packageName`, `packageVersion`,
// `installCommand`, `nodeRequirement`, `defaultServer`, `commandCount`,
// `commands[]` with `path` / `signature` / `invocation` / `description` /
// `helpGroup` / `options[]`). What may change without notice: the command set,
// every description, every flag and the count — and new fields may appear, which
// the consumer must tolerate.

/** Assembled from compile-time declarations; nothing per-request. */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return NextResponse.json(cliCommandsDocument(), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cacheable because it changes only when the code does; `must-revalidate`
      // keeps a stale copy from outliving a deploy silently — `v1.json`'s rule.
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
}
