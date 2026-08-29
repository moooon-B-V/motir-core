import 'server-only';

import { type Prisma } from '@/generated/prisma/client';

// WHAT IS IN A PERSONAL-DATA EXPORT (Story 8.4 · Subtask MOTIR-3701 · design of
// record `design/settings/design-notes.md` → `Data & privacy` → DECISION 1).
//
// The design fixes the FORMAT (JSON per record + the original uploaded files in
// a zip) and the SCOPE RULE ("as far as their access reaches"), and says in its
// own words that "which tables are in it is [this feature]'s to enumerate".
// This file IS that enumeration, and it is data rather than prose so that the
// archive, the card's table list and the totality guard all read one source.
//
// ── THE TWO TIERS ARE AN RLS FACT, NOT A TAXONOMY ──────────────────────────
// The scope rule is enforced by the DATABASE, not by the `where` clauses below.
// Every read runs inside the exporting user's OWN Postgres context, so a row the
// reader could not read in the product cannot enter their archive — which is the
// property "an export is not a privilege escalation" needs, and the one a
// hand-written filter can only approximate. The tiers name which context admits
// which table (measured against `pg_policies`, not assumed — a table with no arm
// for the bound context returns ZERO ROWS and raises nothing, so an unarmed read
// would silently ship an EMPTY section that looks exactly like "you have none"):
//
//   - `identity` — the table has no RLS, or an `app.user_id` arm. Read once,
//     under `withUserContext`.
//   - `tenant`   — the table's policy keys on `app.workspace_id`. Read ONCE PER
//     WORKSPACE the user is a member of, under `withWorkspaceContext`, and the
//     union is the section. A workspace they are not in is never bound, so its
//     rows are unreachable rather than filtered out.
//
// ⚠️ A TIER IS A CLAIM ABOUT A POLICY. Before adding a section, check
// `pg_policies` for an arm that admits the tier's context — `tests/export/
// personalDataSections.test.ts` asserts every section is non-empty for a
// fully-populated fixture user, which is what makes a wrong tier fail loudly
// instead of exporting nothing.
//
// ── WHAT IS DELIBERATELY NOT IN IT ─────────────────────────────────────────
// `EXCLUDED_FROM_EXPORT` is the other half of the enumeration and is not an
// afterthought: an omission nobody wrote down is indistinguishable from an
// omission nobody noticed. The totality guard requires every model carrying a
// `User` foreign key to appear in exactly one of the two lists, so a table added
// next year fails the build until somebody decides which it is.

/** Which Postgres context admits this table — see the tier note above. */
export type PersonalDataTier = 'identity' | 'tenant';

export interface PersonalDataSection {
  /** The physical table name. This is the enumeration's key and the archive's
   *  filename stem (`<table>.json`), so it is what the card's list names. */
  table: string;
  /** The Prisma delegate the read goes through. */
  model: PersonalDataDelegate;
  tier: PersonalDataTier;
  /** Why these rows are THIS person's data — the sentence a reviewer checks. */
  basis: string;
  /**
   * Columns that never leave the database. Applied as a Prisma `omit`, so the
   * value is not selected rather than selected and then stripped: a secret that
   * is never read cannot be logged, serialized by mistake, or left in a heap
   * dump. Art. 15 is a right to one's own data, not to the credentials that
   * protect it — a password hash or a TOTP secret in a downloadable file is a
   * new attack surface handed out on request.
   */
  redact?: readonly string[];
  /** The attribution filter, on top of whatever RLS already admits. */
  where: (userId: string) => Record<string, unknown>;
}

/** The Prisma delegates this file reads — narrowed so a typo is a type error. */
export type PersonalDataDelegate =
  | 'user'
  | 'account'
  | 'session'
  | 'passkey'
  | 'twoFactor'
  | 'apiToken'
  | 'deviceCode'
  | 'emailChangeRequest'
  | 'legalAcceptance'
  | 'workspaceMembership'
  | 'organizationMembership'
  | 'notificationPreference'
  | 'userAppearancePreference'
  | 'canvasNodePosition'
  | 'projectRepoCollaborator'
  | 'githubIdentity'
  | 'importSourceIdentity'
  | 'publicRequestVote'
  | 'accountDeletionRequest'
  | 'dataExportRequest'
  | 'projectMembership'
  | 'notification'
  | 'savedFilter'
  | 'savedFilterStar'
  | 'savedFilterSubscription'
  | 'automationRule'
  | 'dashboard'
  | 'watcher'
  | 'commentMention'
  | 'publicFollow'
  | 'comment'
  | 'workItem'
  | 'workItemRevision'
  | 'workItemLink'
  | 'attachment'
  | 'component'
  | 'customFieldValue'
  | 'acceptanceEvidence'
  | 'designEvidence'
  | 'import'
  | 'plan'
  | 'planChangeSession'
  | 'planChangeTurn'
  | 'workItemTodo'
  | 'planRevision';

const byUserId = (userId: string) => ({ userId });

export const PERSONAL_DATA_SECTIONS: readonly PersonalDataSection[] = [
  // ── IDENTITY TIER — the account itself ────────────────────────────────────
  {
    table: 'user',
    model: 'user',
    tier: 'identity',
    basis: 'The account and profile — the row this whole export is about.',
    where: (userId) => ({ id: userId }),
  },
  {
    table: 'account',
    model: 'account',
    tier: 'identity',
    basis: 'Linked sign-in providers (password, Google) — which identities open this account.',
    // The password HASH and every OAuth token. `scope` and `providerId` stay:
    // knowing you signed in with Google is the reader's data, the bearer token
    // that acts as them is not.
    redact: ['password', 'accessToken', 'refreshToken', 'idToken'],
    where: byUserId,
  },
  {
    table: 'session',
    model: 'session',
    tier: 'identity',
    basis: 'Sign-in sessions, with the IP and user-agent recorded against each.',
    // The session token is a live credential — anyone holding it IS the user
    // until it expires. The IP/user-agent stay: they are exactly the "who has
    // been using my account" question Art. 15 exists to answer.
    redact: ['token'],
    where: byUserId,
  },
  {
    table: 'passkey',
    model: 'passkey',
    tier: 'identity',
    basis: 'Registered passkeys — one per device the reader enrolled.',
    redact: ['publicKey', 'credentialID'],
    where: byUserId,
  },
  {
    table: 'two_factor',
    model: 'twoFactor',
    tier: 'identity',
    basis: 'Two-factor enrolment — that it exists, and when it was set up.',
    // The TOTP secret and the backup codes ARE the second factor. Exporting
    // them would make a downloaded archive a complete bypass of it.
    redact: ['secret', 'backupCodes'],
    where: byUserId,
  },
  {
    table: 'api_token',
    model: 'apiToken',
    tier: 'identity',
    basis: 'Personal access tokens the reader minted, with their scopes and last use.',
    redact: ['tokenHash'],
    where: byUserId,
  },
  {
    table: 'device_code',
    model: 'deviceCode',
    tier: 'identity',
    basis: '`motir login` device grants this account claimed.',
    redact: ['deviceCode', 'userCode'],
    where: byUserId,
  },
  {
    table: 'email_change_request',
    model: 'emailChangeRequest',
    tier: 'identity',
    basis: 'Pending verified email changes.',
    redact: ['token'],
    where: byUserId,
  },
  {
    table: 'legal_acceptance',
    model: 'legalAcceptance',
    tier: 'identity',
    basis: 'What this account agreed to, and when — the append-only consent record.',
    where: byUserId,
  },
  {
    table: 'workspace_membership',
    model: 'workspaceMembership',
    tier: 'identity',
    basis: 'Which workspaces the reader belongs to, and in what role.',
    where: byUserId,
  },
  {
    table: 'organization_membership',
    model: 'organizationMembership',
    tier: 'identity',
    basis: 'Which organizations the reader belongs to, and in what role.',
    where: byUserId,
  },
  {
    table: 'notification_preference',
    model: 'notificationPreference',
    tier: 'identity',
    basis: 'The per-event, per-channel notification toggles the reader set.',
    where: byUserId,
  },
  {
    table: 'user_appearance_preference',
    model: 'userAppearancePreference',
    tier: 'identity',
    basis: 'The cross-device appearance preference (theme, density, typeface).',
    where: byUserId,
  },
  {
    table: 'canvas_node_position',
    model: 'canvasNodePosition',
    tier: 'identity',
    basis: 'Where the reader dragged each node on a planning canvas.',
    where: byUserId,
  },
  {
    table: 'project_repository_collaborator',
    model: 'projectRepoCollaborator',
    tier: 'identity',
    basis: 'Repository collaborator invitations issued to the reader.',
    where: byUserId,
  },
  {
    table: 'github_identity',
    model: 'githubIdentity',
    tier: 'identity',
    basis: 'The linked GitHub identity (login and account id).',
    redact: ['accessTokenEncrypted'],
    where: byUserId,
  },
  {
    table: 'import_source_identity',
    model: 'importSourceIdentity',
    tier: 'identity',
    basis: 'Linked import-source identities (Jira, Linear, …) per workspace.',
    redact: ['accessTokenEncrypted', 'refreshTokenEncrypted'],
    where: byUserId,
  },
  {
    table: 'public_request_vote',
    model: 'publicRequestVote',
    tier: 'identity',
    basis: 'Upvotes the reader cast on public requests.',
    where: byUserId,
  },
  {
    table: 'account_deletion_request',
    model: 'accountDeletionRequest',
    tier: 'identity',
    basis: 'Account-erasure requests the reader has raised.',
    where: byUserId,
  },
  {
    table: 'data_export_request',
    model: 'dataExportRequest',
    tier: 'identity',
    basis: 'Personal-data export requests the reader has raised — this one included.',
    where: byUserId,
  },

  // ── TENANT TIER — the reader's own rows inside workspaces they belong to ──
  // Each is filtered to the reader's OWN attribution. A workspace's other
  // content is not the reader's personal data and is not theirs to receive,
  // even where they can read it in the product.
  {
    table: 'project_membership',
    model: 'projectMembership',
    tier: 'tenant',
    basis: 'Explicit project memberships the reader holds.',
    where: byUserId,
  },
  {
    table: 'notification',
    model: 'notification',
    tier: 'tenant',
    basis: "Notifications delivered to the reader's inbox.",
    // RECIPIENT only. A row where the reader is the ACTOR is somebody else's
    // inbox item; that it names them does not make it their record.
    where: (userId) => ({ recipientUserId: userId }),
  },
  {
    table: 'saved_filter',
    model: 'savedFilter',
    tier: 'tenant',
    basis: 'Saved filters the reader owns.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    table: 'saved_filter_star',
    model: 'savedFilterStar',
    tier: 'tenant',
    basis: 'Saved filters the reader starred.',
    where: byUserId,
  },
  {
    table: 'saved_filter_subscription',
    model: 'savedFilterSubscription',
    tier: 'tenant',
    basis: 'The reader’s emailed-results subscriptions.',
    where: byUserId,
  },
  {
    table: 'automation_rule',
    model: 'automationRule',
    tier: 'tenant',
    basis: 'Automation rules the reader owns.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    table: 'dashboard',
    model: 'dashboard',
    tier: 'tenant',
    basis: 'Dashboards the reader owns.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    table: 'watcher',
    model: 'watcher',
    tier: 'tenant',
    basis: 'Work items the reader watches.',
    where: byUserId,
  },
  {
    table: 'comment_mention',
    model: 'commentMention',
    tier: 'tenant',
    basis: 'Comments in which the reader was mentioned.',
    where: (userId) => ({ mentionedUserId: userId }),
  },
  {
    table: 'public_follow',
    model: 'publicFollow',
    tier: 'tenant',
    basis: 'Public projects this account follows.',
    where: byUserId,
  },
  {
    table: 'comment',
    model: 'comment',
    tier: 'tenant',
    basis: 'Comments the reader wrote.',
    where: (userId) => ({ authorId: userId }),
  },
  {
    table: 'work_item',
    model: 'workItem',
    tier: 'tenant',
    basis: 'Work items the reader reported, is assigned, or submitted to triage.',
    where: (userId) => ({
      OR: [{ reporterId: userId }, { assigneeId: userId }, { submittedByUserId: userId }],
    }),
  },
  {
    table: 'work_item_revision',
    model: 'workItemRevision',
    tier: 'tenant',
    basis: 'Work-item field changes the reader made.',
    where: (userId) => ({ changedById: userId }),
  },
  {
    table: 'work_item_link',
    model: 'workItemLink',
    tier: 'tenant',
    basis: 'Work-item links the reader created.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    table: 'attachment',
    model: 'attachment',
    tier: 'tenant',
    basis: 'Files the reader uploaded — the rows whose bytes ride in `files/`.',
    where: (userId) => ({ uploaderUserId: userId }),
  },
  {
    table: 'component',
    model: 'component',
    tier: 'tenant',
    basis: 'Components for which the reader is the default assignee.',
    where: (userId) => ({ defaultAssigneeId: userId }),
  },
  {
    table: 'custom_field_value',
    model: 'customFieldValue',
    tier: 'tenant',
    basis: 'Custom-field values naming the reader.',
    where: (userId) => ({ valueUserId: userId }),
  },
  {
    table: 'acceptance_evidence',
    model: 'acceptanceEvidence',
    tier: 'tenant',
    basis: 'Story-acceptance videos the reader approved.',
    where: (userId) => ({ approvedById: userId }),
  },
  {
    table: 'design_evidence',
    model: 'designEvidence',
    tier: 'tenant',
    basis: 'Design results the reader withdrew.',
    where: (userId) => ({ withdrawnById: userId }),
  },
  {
    table: 'import',
    model: 'import',
    tier: 'tenant',
    basis: 'Issue-import runs the reader started.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    table: 'plan',
    model: 'plan',
    tier: 'tenant',
    basis: 'Plans the reader requested or decided.',
    where: (userId) => ({ OR: [{ createdById: userId }, { decidedById: userId }] }),
  },
  {
    table: 'plan_change_session',
    model: 'planChangeSession',
    tier: 'tenant',
    basis: 'Plan-change conversations the reader opened.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    table: 'plan_change_turn',
    model: 'planChangeTurn',
    tier: 'tenant',
    basis: 'Turns the reader wrote in a plan-change conversation.',
    where: (userId) => ({ authorId: userId }),
  },
  {
    table: 'work_item_todo',
    model: 'workItemTodo',
    tier: 'tenant',
    // `done_by_id` records WHO ticked a step, which is an attribution of an act
    // to a person — the same shape as `plan_revision.changedById` and
    // `design_evidence.withdrawnById`, both of which are exported. So this is
    // EXPORTED rather than excluded: a table carrying "this person did this" is
    // personal data whatever the row is otherwise about.
    basis: 'To-do steps the reader ticked off.',
    where: (userId) => ({ doneById: userId }),
  },
  {
    table: 'plan_revision',
    model: 'planRevision',
    tier: 'tenant',
    basis: 'Plan content changes the reader made.',
    where: (userId) => ({ changedById: userId }),
  },
];

/**
 * Models carrying a `User` foreign key that are deliberately NOT exported, each
 * with the reason. The totality guard reads this list, so an exclusion is a
 * decision on the record rather than a gap — which is the whole difference
 * between a table nobody exported and a table nobody noticed.
 */
export const EXCLUDED_FROM_EXPORT: Readonly<Record<string, string>> = {
  PlatformAuditLog:
    'The controller’s own audit of moooon B.V. operator actions across the estate. ' +
    'Its rows name OTHER tenants (`targetLabel`, `organizationId`), so exporting them ' +
    'to the operator as a data subject would hand one person a machine-readable ' +
    'record about customers they administer — the exact privilege escalation ' +
    'DECISION 1’s scope clause forbids. It is also outside every workspace, so no ' +
    'reader’s access reaches it.',
  PlanTargetLock:
    'A planning lease measured in minutes, held by a session and released by a sweep. ' +
    'It carries no fact about the person beyond "a lock existed", and is gone before ' +
    'an export could describe it — transient operational substrate, not a record.',
  Project:
    'Not a user-keyed row. `Project` appears in the User relation graph only as the ' +
    'back-relation of `user.lastActiveProjectId`; that pointer is a COLUMN on `user` ' +
    'and ships in the `user` section. The project itself belongs to the workspace.',
};

/** Sections in the tier the given context can read. */
export function sectionsForTier(tier: PersonalDataTier): readonly PersonalDataSection[] {
  return PERSONAL_DATA_SECTIONS.filter((s) => s.tier === tier);
}

/**
 * Read one section. `omit` is what applies the redaction — the column is never
 * selected, so the secret does not enter the process.
 */
export async function readSection(
  section: PersonalDataSection,
  userId: string,
  tx: Prisma.TransactionClient,
): Promise<unknown[]> {
  // The registry is deliberately DATA — one loop reads every section — so the
  // delegate is resolved by name and its args are built at runtime. Prisma's
  // per-model `findMany` overloads cannot type that; the narrowing that matters
  // (the model name is real, the redacted columns exist) is enforced by
  // `PersonalDataDelegate` and by the totality test, not here.
  const delegate = tx[section.model] as unknown as {
    findMany: (args: Record<string, unknown>) => Promise<unknown[]>;
  };
  const args: Record<string, unknown> = { where: section.where(userId) };
  if (section.redact?.length) {
    args.omit = Object.fromEntries(section.redact.map((f) => [f, true]));
  }
  return delegate.findMany(args);
}
