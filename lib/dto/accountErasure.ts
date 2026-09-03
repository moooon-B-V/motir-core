// The account-erasure IMPACT PREVIEW (Story 8.4 · Subtask MOTIR-3699) — the
// read half of the destructive flow the `Data › Data & privacy` pane drives.
//
// `design/settings/design-notes.md` → `Data & privacy` → DECISION 3 is the
// source of the three groups, and each group's membership follows from a SOURCE
// rather than from taste:
//
//   deleted    — what is the reader's ALONE: their identity rows, every personal-
//                data export they asked for (Bug MOTIR-3747), and every workspace
//                where they are the only member (with the projects and work items
//                inside).
//   anonymised — what is part of someone ELSE'S project: comments they wrote and
//                work items they reported or were assigned in a SHARED
//                workspace. The name comes off; the row stays.
//   kept       — what erasure does not reach. NOT counted from the database:
//                `motir.co/legal/privacy` §6 states these as exceptions
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
  /**
   * Every personal-data export the reader has asked for, whatever its status —
   * and, for the ones that built, the ARCHIVE each holds (Bug MOTIR-3747).
   *
   * ⚠️ IT IS A MEMBER OF THIS GROUP BECAUSE THE ERASURE DELETES IT. MOTIR-3732
   * widened the sweep to take every `data_export_request` and its blob, and the
   * ledger is the surface that tells a reader what deletion means: the design's
   * rule is that *each group's membership follows from a SOURCE rather than
   * from taste*, so a widening of what erasure DELETES is a widening of this
   * contract. Held as a FIELD rather than a sentence in the copy precisely so
   * the obligation is compile-time visible the next time the sweep grows.
   *
   * The archive is also the one member of this group that is a complete COPY of
   * everything the account held, and the same pane routes the reader past the
   * export on the way to the delete button — so a confirmation that omits it
   * leaves them guessing whether the copy they were just offered survives.
   *
   * Counted over EVERY status: a `preparing` / `failed` / `expired` row carries
   * no downloadable file, but it still names this person and the erasure still
   * takes it, so the copy describes what is deleted rather than promising a
   * download exists.
   */
  dataExports: number;
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

// ── The scheduled deletion itself (Story 8.4 · Subtask MOTIR-3700) ─────────
// The WRITE half's return shape. The preview above says what a deletion WOULD
// reach; this says that one has been asked for and when it falls due.

/** The three states a request can be in — mirrors the `AccountDeletionStatus`
 *  Postgres enum, restated here so a consumer of the DTO layer never has to
 *  import a Prisma type to render a state. */
export type AccountDeletionStatusDTO = 'scheduled' | 'cancelled' | 'completed';

/**
 * One account-deletion request, as the pane and the app-wide banner render it.
 *
 * ⚠️ `erasureDueAt` IS THE POINT OF THE SHAPE, not a timestamp that came along
 * for the ride. DECISION 4 makes the window a published promise
 * (`motir.co/legal/privacy` §6), and the copy that states it interpolates
 * THIS value rather than recomputing `now + 30 days` — a reader who scheduled
 * on Monday and opens the banner on Thursday must be told Monday's deadline.
 * Persisted at create for the same reason, so a later change to the constant
 * cannot move a deadline somebody has already been shown.
 *
 * ISO strings rather than `Date`s, the dominant convention in `lib/dto/`: this
 * shape crosses the API boundary to a route and to a client island unchanged.
 */
export interface AccountDeletionRequestDTO {
  id: string;
  status: AccountDeletionStatusDTO;
  /** When the reader asked. The window is measured from here. */
  requestedAt: string;
  /** When the erasure falls due — `requestedAt + ACCOUNT_ERASURE_WINDOW_DAYS`. */
  erasureDueAt: string;
  /** When the reader cancelled, if they did. */
  cancelledAt: string | null;
}
