// The account-erasure IMPACT PREVIEW (Story 8.4 · Subtask MOTIR-3699) — the
// read half of the destructive flow the `Data › Data & privacy` pane drives.
//
// `design/settings/design-notes.md` → `Data & privacy` → DECISION 3 is the
// source of the three groups, and each group's membership follows from a SOURCE
// rather than from taste:
//
//   deleted    — what is the reader's ALONE: their identity rows, and every
//                workspace where they are the only member (with the projects and
//                work items inside).
//   anonymised — what is part of someone ELSE'S project: comments they wrote and
//                work items they reported or were assigned in a SHARED
//                workspace. The name comes off; the row stays.
//   kept       — what erasure does not reach. NOT counted from the database:
//                `content/legal/privacy.md` §6 states these as exceptions
//                ("generally seven years", "data present only in a backup"), so
//                the preview NAMES them and the copy renders them.
//
// The verdict (`blocked`) is the ORGANIZATION tier, and it is a READ — DECISION
// 5's table: an organization guard (`assertNotLastOwner`) is a HARD BLOCK, a
// workspace guard (`LastMemberError`) is not a block at all but the CHOICE the
// `deleted` group's `soleMemberWorkspaces` presents.

/**
 * The stated retention exceptions the `kept` group names. A CLOSED set, and the
 * preview returns keys rather than prose so the pane's copy and the Privacy
 * Policy cannot drift into two different lists of exceptions.
 *
 * - `billing_records` — invoices and tax records, for as long as Dutch tax and
 *   accounting law requires (§6: *"generally seven years"*).
 * - `backups` — data still present in a backup, until the backup rotates (§6:
 *   *"Data present only in a backup is not restored to active use"*).
 */
export const ACCOUNT_ERASURE_KEPT_EXCEPTIONS = ['billing_records', 'backups'] as const;

export type AccountErasureKeptException = (typeof ACCOUNT_ERASURE_KEPT_EXCEPTIONS)[number];

/** A workspace named in the ledger — BY NAME, never only as a count. */
export interface ErasureWorkspaceDTO {
  id: string;
  name: string;
}

/**
 * The `deleted` group — what is the reader's alone.
 *
 * `soleMemberWorkspaces` carries NAMES because the design's ledger names them
 * and states the escape (*"To keep one, invite somebody to it first"*): a
 * sole-membership workspace has exactly two futures, and the reader should meet
 * that choice in the ledger rather than discover it at submit.
 */
export interface ErasureDeletedGroupDTO {
  /** Credential + OAuth linkage rows — "how you sign in". */
  credentials: number;
  passkeys: number;
  /** `1` when the reader holds a two-factor enrolment row, else `0`. */
  twoFactorEnrolments: number;
  apiTokens: number;
  /** Every workspace where the reader is the ONLY member, by name. */
  soleMemberWorkspaces: ErasureWorkspaceDTO[];
  /** Projects inside those workspaces. */
  projects: number;
  /** Work items inside those workspaces. */
  workItems: number;
}

/** The `anonymised` group — the reader's contributions to shared workspaces. */
export interface ErasureAnonymisedGroupDTO {
  /** Comments the reader wrote in workspaces other people are also in. */
  comments: number;
  /**
   * Work items in those workspaces the reader REPORTED or was ASSIGNED. An item
   * that is both counts ONCE — the ledger renders one number for one row set.
   */
  workItems: number;
}

/** The organization whose last-owner guard blocks the erasure, when one does. */
export interface ErasureBlockingOrganizationDTO {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * What the confirmation modal renders, and what the pane renders at rest.
 *
 * Everything here is scoped to what the READER can already see: the preview is
 * not a privilege escalation, and a member of a shared workspace does not learn
 * counts they could not already read.
 */
export interface AccountErasurePreviewDTO {
  /**
   * `true` exactly when the reader is the last owner of an organization that
   * OTHER people belong to — the condition `assertNotLastOwner` asserts
   * (`lib/services/organizationsService.ts`, owner count ≤ 1), evaluated as a
   * read. The delete path is never called to produce it.
   */
  blocked: boolean;
  /** The blocking organization when `blocked`, else `null`. */
  blockingOrganization: ErasureBlockingOrganizationDTO | null;
  deleted: ErasureDeletedGroupDTO;
  anonymised: ErasureAnonymisedGroupDTO;
  /** The stated exceptions, not counted from the database. */
  kept: AccountErasureKeptException[];
}
