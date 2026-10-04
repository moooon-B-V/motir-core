// The DECISION-PAGE publication as it crosses the API boundary (Story
// MOTIR-5761 · MOTIR-7432; `approval-gates.md` §8 NINTH AMENDMENT).

export interface PublishDecisionPageInput {
  workItemId: string;
  pageId: string;
}

/** One publication: which version of which page is the card's decision. */
export interface DecisionPagePublicationDto {
  id: string;
  workItemId: string;
  workItemKey: string;
  pageId: string;
  pageTitle: string;
  versionId: string;
  versionNumber: number;
  /** ISO-8601 — when the version was SEALED (the first publish of it). */
  sealedAt: string;
  /** ISO-8601. */
  publishedAt: string;
  publishedById: string;
  /** The publisher's display name; `''` only if the batch read did not return them. */
  publishedByName: string;
  /** The awaiting `decision_approval` this publish raised; `null` on a human card or a replay. */
  gateId: string | null;
  /** `true` when the same version was already this card's publication: nothing was written. */
  replayed: boolean;
}
