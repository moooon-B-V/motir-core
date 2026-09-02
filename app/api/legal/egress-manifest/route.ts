import { NextResponse } from 'next/server';
import { EGRESS_MANIFEST } from '@/lib/legal/egressManifest';

// GET /api/legal/egress-manifest (Story MOTIR-3909 · MOTIR-4008) — the vendor set
// THIS SOFTWARE's own tree proves it reaches, served so the repository that
// publishes the subprocessor page can assert against it.
//
// ⚠️ THE TRANSPORT IS DECIDED, AND IT IS THE SAME ONE `/docs` TOOK.
// `docs/decisions/public-surface-hosts.md` AMENDMENT 2 §E requires a SERVED,
// VERSIONED artifact the consumer FETCHES — never a committed copy — because
// §8's cost 3 already settled that shape for the other cross-repository artifact
// in this epic: *"a published artifact `motir-core` emits and the consumer
// installs does not rot; a copied spec does"*. MOTIR-4046 implemented it for the
// OpenAPI document (`motir-marketing` `lib/docs.ts` fetches
// `${APP_ORIGIN}/api/openapi/v1.json` and its own test asserts no copy is
// committed). This is that arrangement, for the second artifact.
//
// ⚠️ AND IT IS DELIBERATELY *NOT* UNDER `/api/public/*`. That surface is a
// versioned CONTRACT with a deprecation policy, generated from an operation
// registry, addressed to third-party readers (AMENDMENT 1). This is an internal
// artifact between two repositories under one owner — AMENDMENT 2 §G says so in
// as many words — so it carries its own integer `version` in the body and takes
// on none of that contract's obligations.
//
// ⚠️ UNAUTHENTICATED, on the same argument as `/api/health/{queue,release,legal}`
// (`permission-inventory.md` R57 / R58 / R59, and R60 for this route). What
// makes it safe is the PAYLOAD: every company named here is one we are legally
// obliged to DISCLOSE PUBLICLY on a subprocessor page, so the document exists to
// be read by strangers. It identifies no tenant, no workspace and no person, and
// the "evidence" strings are dependency names and hostnames already visible in a
// public GPL-3.0 repository.
//
// ⚠️ IT IS NOT THE DISCLOSURE. It carries no transfer basis, no region and no
// processing purpose — those are judgements about a legal relationship that no
// repository fact settles, and `motir-marketing`'s page holds them.
//
// Thin transport per `CLAUDE.md`: ONE import, serialized.

/** Never cached. A stale answer about what this build reaches is worse than none. */
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(EGRESS_MANIFEST);
}
