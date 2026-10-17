// The project's AUTO-TRANSLATE switch and its change trail (Story MOTIR-7738 ·
// MOTIR-8826) — what the Translation settings room reads and what the flip
// returns. One boolean per project, covering WORK CONTENT only; the product's
// interface strings stay on the reader's locale path and never touch this switch.

/** One recorded flip: who, from what, to what, when — and nothing else. */
export interface ProjectAutoTranslateChangeDTO {
  id: string;
  /**
   * The person who flipped it, or `null` once their account is gone (the actor
   * foreign key is SET NULL so the record outlives the person).
   */
  changedByUserId: string | null;
  /** Their display name, resolved when the trail is read; `null` when unresolved. */
  changedByName: string | null;
  fromEnabled: boolean;
  toEnabled: boolean;
  /** ISO-8601 instant. */
  changedAt: string;
}

export interface ProjectAutoTranslateSettingsDTO {
  /** The STORED value of `Project.autoTranslateWorkContent`, never a computed default. */
  autoTranslateWorkContent: boolean;
  /** The most recent changes, newest first, at most {@link RECENT_CHANGE_LIMIT}. */
  changes: ProjectAutoTranslateChangeDTO[];
  /** Every change on the project — larger than `changes.length` when the list is capped. */
  totalChanges: number;
}

/** The PATCH body: an absent key means unchanged. */
export interface UpdateProjectAutoTranslateSettingsInput {
  autoTranslateWorkContent?: boolean;
}

/** The bound on the read-back. A display decision a surface may lower, never raise. */
export const RECENT_CHANGE_LIMIT = 50;
