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
