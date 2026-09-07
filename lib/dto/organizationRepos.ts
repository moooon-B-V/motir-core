import type { CodeGraphIndexState } from '@/lib/codeGraph/indexState';

// DTO types for the ORGANISATION's repository inventory (Story MOTIR-4669 ·
// MOTIR-4678) — the shape the `Add repository` picker's first segment binds to.
// No Prisma row leaks; every `Date` is an ISO string.

/** Wire form of the Prisma `GitProvider` enum, as the picker renders it. */
export type OrgRepoProviderDto = 'github' | 'gitlab';

/**
 * ONE ROW OF THE PICKER'S FIRST SEGMENT — a repository the organisation is
 * already connected to, offered for a project to pick.
 *
 * ⚠️ EVERY ROW OF THIS LIST IS FREE TO PICK, and that is the DTO's whole
 * contract rather than a property of one field. It carries no index state, no
 * cost hint and no "will this re-index?" flag, because the answer is always no —
 * the repository is connected, the graph exists, and linking it is one row.
 * Nothing here should grow a field that implies otherwise.
 */
export interface OrgRepoOptionDto {
  /** The internal `GithubRepo.id` — what a link write names. */
  id: string;
  owner: string;
  name: string;
  /** `owner/name`, precomputed so three consumers do not each join it. */
  fullName: string;
  defaultBranch: string;
  provider: OrgRepoProviderDto;
  archived: boolean;
  /**
   * The workspace the repository was connected FROM. Present because the
   * organisation spans workspaces and a person picking from a long list needs to
   * know where a name came from — NOT because it scopes anything. Tenancy is the
   * organisation; this is provenance.
   */
  connectedFromWorkspaceId: string | null;
}

/**
 * A project holding a repository, as the `Used by N projects` expansion names it.
 *
 * ⚠️ THE LIST IS ACCESS-FILTERED, AND THE COUNT IS ITS LENGTH — never a separate
 * number. An org member reads this inventory (the row gate is org membership, per
 * `organization-tier.md` §6), and the organisation contains projects they may not
 * browse. A count of 4 beside a list of 2 tells them a private project exists and
 * is exactly the leak the expansion was drawn to avoid.
 */
export interface UsingProjectDto {
  id: string;
  name: string;
  /** The project's key ("MOTIR"), so a consumer can link without a second read. */
  identifier: string;
  workspaceId: string;
}

/**
 * ONE REPOSITORY'S USAGE — the disclosure mechanism (`design/github` panel 6
 * draws it on the row AT REST) and the same data the org-level disconnect dialog
 * enumerates. ONE read, both consumers, so the count on the row and the names in
 * the dialog cannot disagree.
 */
export interface OrgRepoUsageDto {
  /** The internal `GithubRepo.id`. */
  githubRepoId: string;
  /** `owner/name` — what a dialog headline says. */
  repoRef: string;
  /** The projects the VIEWER may browse that hold this repository. */
  projects: UsingProjectDto[];
}

/**
 * WHAT MOTIR KNOWS ABOUT A REPOSITORY'S CODE INDEX (Story MOTIR-4669).
 *
 * ⚠️ THIS WAS TWO VALUES AND IS NOW FOUR (MOTIR-4680 → MOTIR-4724), and the
 * history is worth keeping because it is the argument for the shape.
 *
 * MOTIR-4680 shipped `indexed | never` and asserted the absence of the other two,
 * because both were blocked by properties the owning code documents about itself:
 * `stale` needed an indexed commit and a default-branch head and the schema
 * carried NEITHER column, and `indexing` was not attributable at all, because the
 * job ledger writes `output.repoRef` only on success. Rendering `Current` under
 * those conditions would have told a person their index matched their code at the
 * exact moment they were deciding whether to trust a plan built from it — a wrong
 * answer, not a missing feature.
 *
 * MOTIR-4724 built the substrate rather than the appearance of it: two shas, an
 * in-flight pointer, and ONE derivation (`lib/codeGraph/indexState.ts`) that every
 * surface reads. The union is that function's return type, re-exported here so a
 * DTO consumer binds to the same four names the derivation produces.
 */
export type OrgRepoIndexStateDto = CodeGraphIndexState;

/** One row of the organisation's repository inventory (MOTIR-4680). */
export interface OrgRepoInventoryRowDto {
  repo: OrgRepoOptionDto;
  /** The projects the VIEWER may browse that hold it — count IS the list length. */
  projects: UsingProjectDto[];
  indexState: OrgRepoIndexStateDto;
}
