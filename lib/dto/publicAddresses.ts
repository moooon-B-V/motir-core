// The DTOs the public-address surfaces return — Story MOTIR-3878 · MOTIR-4215.
// Services return these, never raw Prisma rows (`CLAUDE.md`'s 4-layer rule).

/** One retired subdomain, kept for ever as a redirect (ADR §8). */
export interface RetiredSubdomainDto {
  readonly hostname: string;
  readonly retiredAt: string;
}

/**
 * A workspace's tenant subdomain, or the shape a workspace that has none reads
 * as (`null` from the service).
 */
export interface PublicSubdomainDto {
  /** The label alone, e.g. `acme` — what the settings field edits. */
  readonly label: string;
  /** The full hostname, e.g. `acme.motir.site`. */
  readonly hostname: string;
  /** The absolute URL a reader opens. */
  readonly url: string;
  readonly claimedAt: string;
  /**
   * Every previous label, still redirecting. Present even when empty, so the
   * pane renders the same shape before and after a first rename.
   */
  readonly aliases: readonly RetiredSubdomainDto[];
  /**
   * How many renames remain (ADR §8's cap minus those used).
   *
   * Sent because a cap the customer cannot see is a cap they meet as a refusal.
   * Derived rather than stored: the alias rows ARE the count.
   */
  readonly renamesLeft: number;
}

// ── Host resolution (MOTIR-4217) ───────────────────────────────────────────
//
// What `GET /api/public/hosts/{host}` answers. A DISCRIMINATED UNION rather
// than one shape with nullable halves: the three cases have nothing in common
// beyond the discriminator, and a router that has to check which fields are
// present is a router that will one day check the wrong one.

/** A workspace subdomain — the host lists that workspace's public projects. */
export interface PublicHostWorkspaceDto {
  readonly kind: 'workspace';
  readonly workspace: { readonly name: string };
  /** Every public project under it, freshest first. May be empty. */
  readonly projects: ReadonlyArray<{ readonly identifier: string; readonly name: string }>;
}

/**
 * A RETIRED subdomain. The router 301s to `redirectTo` — this is the shape that
 * makes the ADR §8 never-released promise observable to a visitor rather than
 * merely true in the database.
 */
export interface PublicHostAliasDto {
  readonly kind: 'alias';
  /** The live hostname to redirect to. */
  readonly redirectTo: string;
}

/** A customer domain with an issued certificate — it serves ONE project at its root. */
export interface PublicHostProjectDto {
  readonly kind: 'project';
  readonly project: { readonly identifier: string; readonly name: string };
  /** Whether this address is the project's CANONICAL one (ADR §7). */
  readonly primary: boolean;
}

export type PublicHostResolutionDto =
  | PublicHostWorkspaceDto
  | PublicHostAliasDto
  | PublicHostProjectDto;

/**
 * A project's addresses, as the renderer needs them (ADR §7).
 *
 * `primary` is the one canonical URL — what `<link rel="canonical">`, `og:url`,
 * the JSON-LD `@id`, the sitemap entry and the feed all name. `alternates` is
 * every OTHER live address for the same project, which the router 301s to the
 * primary.
 */
export interface PublicProjectAddressesDto {
  readonly primary: string;
  readonly alternates: readonly string[];
}
