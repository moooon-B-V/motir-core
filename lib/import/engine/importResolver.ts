// The import MAPPING RESOLVER (Story 7.16 · MOTIR-1504) — pure: it turns ONE
// normalised `SourceIssue` into a Motir work-item payload per the user-confirmed
// mapping + the project context, and NEVER persists. Grounded in the ADR
// (docs/decisions/issue-importer.md §2): kind (with the kind-parent matrix
// honoured — an illegal shape is legalised with a WARNING, never emitted for the
// DB trigger to reject), status → a valid project key (unmatched → default →
// initial), priority (unmatched → `medium`, since Motir has no `none`),
// assignee/reporter by email, labels/comments/attachments/parent/links/history.
//
// No DB, no Prisma, no writes — the caller (importEngineService) supplies the
// read context.

import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { SourceIssue } from '../connectors/types';
import type {
  ImportMapping,
  ImportResolveContext,
  ResolvedComment,
  ResolvedWorkItemPayload,
  UnmatchedUserPolicy,
} from './types';

const VALID_PRIORITIES: ReadonlySet<string> = new Set([
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
]);

/** Case-insensitive lookup in a token→value map. */
function lookupCI<V>(map: Record<string, V> | undefined, token: string): V | undefined {
  if (!map) return undefined;
  if (token in map) return map[token];
  const lower = token.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function resolveUser(
  email: string | null,
  role: 'assignee' | 'reporter',
  policy: UnmatchedUserPolicy,
  ctx: ImportResolveContext,
  warnings: string[],
): string | null {
  if (!email) return null;
  const matched = ctx.membersByEmail.get(email.toLowerCase());
  if (matched) return matched;
  switch (policy) {
    case 'importing_user':
      warnings.push(
        `no workspace member matches ${role} ${email} — assigned to the importing user`,
      );
      return ctx.importingUserId;
    case 'invite':
      warnings.push(
        `no workspace member matches ${role} ${email} — would be invited (left unset for now)`,
      );
      return null;
    case 'unassign':
    default:
      warnings.push(`no workspace member matches ${role} ${email} — left unset`);
      return null;
  }
}

/**
 * Resolve one `SourceIssue` to a Motir work-item payload + the warnings the
 * preview surfaces. Pure — the same computation the real run reuses.
 */
export function resolveIssue(
  source: SourceIssue,
  mapping: ImportMapping,
  ctx: ImportResolveContext,
): { payload: ResolvedWorkItemPayload; warnings: string[] } {
  const warnings: string[] = [];

  // ── kind (+ kind-parent normalisation) ───────────────────────────────────
  const defaultKind: WorkItemKindDto = mapping.defaultKind ?? 'task';
  let kind: WorkItemKindDto = defaultKind;
  if (source.type) {
    const mapped = lookupCI(mapping.typeToKind, source.type);
    if (mapped) kind = mapped;
    else warnings.push(`unmapped type "${source.type}" → imported as ${defaultKind}`);
  }

  let parentExternalId = source.parentExternalId;
  // A subtask MUST have a parent; a parentless one is legalised to a task (the
  // matrix's require-parent arm) rather than emitted for the trigger to reject.
  if (kind === 'subtask' && !parentExternalId) {
    warnings.push(`a subtask needs a parent — "${source.externalId}" imported as a task`);
    kind = 'task';
  }
  // An epic must be root; drop a parent edge rather than reject.
  if (kind === 'epic' && parentExternalId) {
    warnings.push(`an epic must be top-level — dropped the parent of "${source.externalId}"`);
    parentExternalId = null;
  }
  // (The cross-issue (parent-kind → child-kind) matrix check runs in MOTIR-941's
  // 2nd pass, where both resolved kinds are known; an illegal edge there is
  // dropped with a warning too.)

  // ── status → a VALID project key ─────────────────────────────────────────
  const statusKey = resolveStatus(source.status, mapping, ctx, warnings);

  // ── priority (unmatched → medium) ────────────────────────────────────────
  let priority: WorkItemPriorityDto = 'medium';
  if (source.priority) {
    const mapped = lookupCI(mapping.priorityToPriority, source.priority);
    if (mapped && VALID_PRIORITIES.has(mapped)) priority = mapped;
    else warnings.push(`unmapped priority "${source.priority}" → medium`);
  }

  // ── users ────────────────────────────────────────────────────────────────
  const policy = mapping.unmatchedUserPolicy ?? 'unassign';
  const assigneeId = resolveUser(source.assigneeEmail, 'assignee', policy, ctx, warnings);
  const reporterId = source.reporterEmail
    ? (ctx.membersByEmail.get(source.reporterEmail.toLowerCase()) ?? null)
    : null;
  if (source.reporterEmail && !reporterId) {
    warnings.push(
      `no workspace member matches reporter ${source.reporterEmail} — reporter falls to the importing user`,
    );
  }

  // ── comments (author email → member) ─────────────────────────────────────
  const comments: ResolvedComment[] = source.comments.map((c) => ({
    authorId: c.authorEmail ? (ctx.membersByEmail.get(c.authorEmail.toLowerCase()) ?? null) : null,
    authorEmail: c.authorEmail,
    authorName: c.authorName,
    body: c.body,
    createdAt: c.createdAt,
  }));

  const title = source.title.trim() !== '' ? source.title : `(untitled ${source.externalId})`;
  if (source.title.trim() === '')
    warnings.push(`"${source.externalId}" has no title — used a placeholder`);

  const payload: ResolvedWorkItemPayload = {
    kind,
    title,
    descriptionMd: source.descriptionMd,
    priority,
    statusKey,
    assigneeId,
    reporterId,
    reporterEmail: source.reporterEmail,
    labels: source.labels,
    comments,
    attachments: source.attachments,
    parentExternalId,
    links: source.links,
    createdAt: source.createdAt,
    closedAt: source.closedAt,
  };
  return { payload, warnings };
}

function resolveStatus(
  sourceStatus: string | null,
  mapping: ImportMapping,
  ctx: ImportResolveContext,
  warnings: string[],
): string {
  const mapped = sourceStatus ? lookupCI(mapping.statusToKey, sourceStatus) : undefined;
  if (mapped && ctx.statusKeys.has(mapped)) return mapped;
  if (mapped && !ctx.statusKeys.has(mapped)) {
    warnings.push(`mapped status key "${mapped}" is not a project status — falling back`);
  } else if (sourceStatus) {
    warnings.push(`unmapped status "${sourceStatus}" — falling back`);
  }
  if (mapping.defaultStatusKey && ctx.statusKeys.has(mapping.defaultStatusKey)) {
    return mapping.defaultStatusKey;
  }
  if (ctx.initialStatusKey) return ctx.initialStatusKey;
  // A project with zero statuses cannot happen (the default workflow seeds
  // them), but fail safe with an explicit warning rather than an empty key.
  warnings.push('the project has no workflow statuses — status left unresolved');
  return '';
}
