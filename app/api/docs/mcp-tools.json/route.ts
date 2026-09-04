import { NextResponse } from 'next/server';
import { mcpToolCatalogueDocument } from '@/lib/apiDocs/mcp';

// GET /api/docs/mcp-tools.json — the PUBLISHED MCP tool catalogue (MOTIR-4194;
// `docs/decisions/public-surface-hosts.md` AMENDMENT 5).
//
// ── What it is ──────────────────────────────────────────────────────────────
// Every tool the MCP server exposes, the permission that gates it, its authored
// one-line summary, and the grouping DERIVED from that permission — in the
// permission catalog's own order, which is the one authored fact in the
// document. It is the artifact `motir.co/docs/mcp/tools` renders at request
// time, the way `/docs/api` renders `/api/openapi/v1.json`, so that a second
// repository never keeps a copy of a registry only this one can hold true
// (MOTIR-4180 removed exactly such a copy; this is what lets the page come back).
//
// ── THE EMITTED SHAPE: each tool's FULL JSON Schema, verbatim (MOTIR-4389) ──
// A tool's `inputSchema` is the draft-07 JSON Schema the MCP protocol's own
// `tools/list` serves for it, copied without re-shaping: the same `properties`,
// the same `required`, the same `enum` members, the same `anyOf` arms, the same
// nested object and array schemas, `additionalProperties` and `$schema` included.
//
// The alternative was a FLATTENED parameter list — name, type, required, a
// description — which is what the one consumer renders and would be perhaps a
// third of the bytes. It is not what is served, for one reason: flattening
// DROPS something, and what it drops is invisible from here. `anyOf` (every
// nullable field), item schemas (`targetRepos`, `writes`), nested objects
// (`query.where`) and per-arm constraints all collapse to a type name, and the
// next consumer — an MCP client generator, an agent reading the surface, a
// second page — has no way to recover them and no signal that they were ever
// there. Carrying the schema whole makes the artifact a projection that loses
// nothing, and leaves the choice of how DEEP to render where it belongs: with
// the reader. The cost is measured and small — 55 schemas are ~70 KB, beside
// the 720 KB of `/api/openapi/v1.json`, which the same consumer already fetches
// per request.
//
// The VALUES are generated: `lib/apiDocs/mcpToolSchemas.ts`, written by
// `pnpm generate:mcp-tool-schemas` and pinned byte-for-byte against a live
// handshake by `tests/mcp/tool-schema-truth.test.ts`. That indirection exists so
// this handler keeps the four properties below — the registry cannot be
// imported here, and the schemas only the registry can produce still arrive.
//
// ── Why a PUBLISHED document, and not the live `tools/list` ─────────────────
// `app/api/mcp/route.ts` wraps every request in `withMcpAuth(…, { required:
// true })`, so `tools/list` is a 401 to an anonymous caller. A consumer reading
// it would need a workspace token in a marketing site's CI, with a rotation
// owner and a guard that goes red the day it expires. This route removes the
// credential from the seam entirely: it describes the SURFACE, not any tenant's
// data, so there is nothing to authenticate and nothing to personalise.
//
// ── Why HERE — `/api/docs/`, not `/api/openapi/`, `/api/mcp/` or `/api/v1/` ──
// `/api/v1` is authenticated by construction and audited (`v1RouteAudit`
// raises `bypasses-wrapper` for a handler not wrapped in `withV1Route`) — the
// reason both OpenAPI documents sit outside it, and it applies here unchanged.
// `/api/openapi/` names a FORMAT, and this document is not an OpenAPI document;
// a reader who finds it there would look for `paths` and `components`.
// `/api/mcp/` is the authenticated endpoint the catalogue describes, and a
// sibling under it would put an anonymous route beside the one path in the tree
// where every request must carry a token. `/api/docs/` is the neutral home for
// a documentation artifact that is neither an OpenAPI document nor part of any
// versioned contract; the totality guards walk none of `app/api/v1`,
// `app/api/public` or `app/api/public-requests`, so this needs no exemption
// from any of them.
//
// ── UNVERSIONED, deliberately (AMENDMENT 5 §C) ──────────────────────────────
// Not part of the `v1` contract and not part of the public read contract. The
// MCP surface already versions itself through `tools/list`, and Amendment 7 of
// `public-api-conventions.md` explicitly licenses it to churn — rewording a
// description is how an agent's behaviour is tuned. A documentation feed for
// that surface put under the published stability policy would buy a standing
// deprecation obligation without buying a reader. What a consumer may rely on:
// this path, and the field names (`endpoint`, `toolCount`, `groups[]` with
// `permission` / `label` / `gates` / `grantedByDefault` / `tools[]`, each tool
// with `name` / `permission` / `summary` / `inputSchema`). What may change
// without notice: the tool set, every summary, every label, group membership,
// the count, and every argument schema — and new fields may appear, which the
// consumer must tolerate. `inputSchema` was one such addition (MOTIR-4389), and
// the consumer that had to tolerate it did.
//
// ── It remains available on self-hosted builds — the SAME answer as ─────────
// `/api/openapi/public.json` (MOTIR-4042), and for the same reason: `MOTIR_CLOUD`
// makes the public-projects CAPABILITY absent, and this document is not that
// capability. It describes the MCP server every build ships, just as `/docs`
// does; serving it publishes nothing and makes no tool callable. It is
// `force-static`, so a gate in this handler would capture the BUILDER's flag
// rather than the deployment's, and making it dynamic would discard the cache
// for no exposure. `tests/api/public/cloud-gate-totality.test.ts` pins this
// exclusion beside the public contract's, so a route outside `app/api/public`
// cannot be mistaken for an omission.
//
// ── The four properties that make an unauthenticated handler safe here ──────
// It authenticates nothing, reads no database, takes no user input (the handler
// has no request parameter at all) and spends no rate-limit budget — it
// serializes a value assembled from compile-time declarations.
// `tests/api/docs/mcp-tools-route.test.ts` asserts each against this file's
// source rather than trusting this comment, and asserts TOTALITY: every key of
// `TOOL_PERMISSIONS` reaches the served document, which typecheck cannot see.

/** Assembled from compile-time declarations; nothing per-request. */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return NextResponse.json(mcpToolCatalogueDocument(), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cacheable because it changes only when the code does; `must-revalidate`
      // keeps a stale copy from outliving a deploy silently — `v1.json`'s rule.
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
}
