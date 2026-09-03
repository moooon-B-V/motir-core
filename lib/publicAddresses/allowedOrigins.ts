import { publicSiteOrigin } from '@/lib/publicProjects/urls';

// WHICH ORIGINS MAY ACT ON THE PUBLIC SURFACE — Story MOTIR-3878 · MOTIR-4218.
//
// Two shipped modules assumed the public site had exactly ONE origin
// (`cors.ts`, `returnTarget.ts`). After this story it has many, and both need
// the same question answered: is this origin a REGISTERED public address?
//
// ── What counts, and what deliberately does NOT ───────────────────────────
//
//   ✓ `publicSiteOrigin()`            — the configured public site, always
//   ✓ `https://<live subdomain>`      — a workspace's claimed address
//   ✓ `https://<ISSUED custom domain>`— a customer domain that actually serves
//
//   ✗ an ALIAS. A retired subdomain is a REDIRECT, not an origin: a browser
//     that follows it arrives on the live address and acts from there. Treating
//     it as an origin would let a name nobody uses any more carry a CORS grant.
//   ✗ a custom domain in any other status. It does not serve, so nothing can be
//     acting from it — and if something is, that is precisely the case to refuse.
//
// ── ⚠️ THE CACHE IS A SECURITY CONTROL, NOT A PERFORMANCE ONE ─────────────
//
// It caches NEGATIVES as well as positives, and the negative half is the half
// that matters. `Origin` is attacker-controlled and arrives on every
// cross-origin request, so without a negative cache a bot spraying random
// origins turns this check into one database read per request — a
// denial-of-service with no authentication needed, reached through a header.
// Sixty seconds is short enough that a newly-claimed address starts working
// while a customer is still looking at the settings pane.

/** How long a verdict is reused. Short: a claim should take effect quickly. */
const TTL_MS = 60_000;

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

/**
 * In-process only, and that is a decision rather than a limitation. A shared
 * cache would need invalidation across machines for a value that is already
 * cheap to recompute and correct within a minute; the cost of getting that
 * wrong (an address that works on one machine and not another) is worse than
 * the read it saves.
 */
const cache = new Map<string, CacheEntry>();

/** Exported for tests — a cache with no reset is a test-ordering dependency. */
export function resetAllowedOriginCache(): void {
  cache.clear();
}

/**
 * Is `origin` a registered public address that may act on this surface?
 *
 * Compares ORIGINS, never hostnames or prefixes — the positive-comparison
 * posture `returnTarget.ts`'s header argues for at length. `https://acme.x`,
 * `https://acme.x:8443` and `http://acme.x` are three different origins and only
 * one of them is registered.
 */
export async function isRegisteredPublicOrigin(origin: string): Promise<boolean> {
  if (!origin) return false;
  // The configured site is always allowed and costs no read. It is also the
  // answer while nothing else is configured, which keeps the pre-cutover
  // behaviour byte-identical.
  if (origin === publicSiteOrigin()) return true;

  const now = Date.now();
  const hit = cache.get(origin);
  if (hit && hit.expiresAt > now) return hit.allowed;

  const allowed = await computeAllowed(origin);
  cache.set(origin, { allowed, expiresAt: now + TTL_MS });
  return allowed;
}

async function computeAllowed(origin: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Only `https` and only a bare origin. A port, a path, credentials or a
  // non-https scheme all mean this is not one of our addresses — every address
  // this story mints is `https://<host>` and nothing else.
  if (parsed.protocol !== 'https:') return false;
  if (parsed.port !== '') return false;
  if (parsed.origin !== origin) return false;

  // ⚠️ IMPORTED LAZILY, AND THIS IS A DESIGN CONSTRAINT RATHER THAN A STYLE
  // CHOICE. The only caller of `publicCorsHeaders` is `proxy.ts` — Next's
  // proxy, which runs on EVERY request the matcher covers. A static import of
  // the repository puts the Prisma client in the proxy's import graph, so it is
  // loaded on the hot path whether or not any origin is ever checked, and a
  // process with no `DATABASE_URL` cannot even IMPORT the proxy.
  //
  // That is not hypothetical: `vitest.guards.config.ts` runs the matcher guard
  // with no database on purpose, and a static import turned it from a passing
  // structural check into `DATABASE_URL is not set` at import time. The lane
  // caught the coupling before production did.
  //
  // Deferring it here costs one dynamic import on a CACHE MISS — the cold path,
  // at most once per origin per minute — and keeps the database out of the
  // proxy entirely for the configured-site case, which is every request today.
  const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
  const address = await publicAddressRepository.findByHostname(parsed.hostname);
  if (!address) return false;
  if (address.kind === 'workspace_subdomain') return true;
  if (address.kind === 'custom_domain') return address.status === 'issued';
  // `workspace_subdomain_alias` — a redirect, never an actor. See the header.
  return false;
}
