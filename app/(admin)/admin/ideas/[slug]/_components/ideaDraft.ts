import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import type { IdeaEvidenceInput, IdeaPatch } from '@/lib/ideas/types';
import type { IdeaFieldIssue } from '../../actions';

/**
 * The EDIT FORM's draft model — design `platform-admin` § Ideas, Panels 6–7,
 * card MOTIR-7681. A plain module so the form, its tests and the field-message
 * map share one definition of "what changed" and "which control a refusal
 * belongs to".
 *
 * The save sends ONLY the changed fields (design § Data: "sends only the
 * changed fields"); `evidence`, `capabilities` and `tags` replace their lists
 * wholesale when they changed at all, which is the service's own contract.
 */

export interface EvidenceDraft {
  /** A stable React key for a row that moves; never sent. */
  key: number;
  claim: string;
  sourceName: string;
  url: string;
  sourceDate: string;
}

export interface LineDraft {
  key: number;
  text: string;
}

export interface IdeaDraft {
  title: string;
  pitch: string;
  kind: IdeaKind;
  category: IdeaCategory;
  tags: string[];
  capabilities: LineDraft[];
  evidence: EvidenceDraft[];
  gap: string;
  whyNow: string;
  whyMotir: string;
  whoElse: string;
  reviewed: boolean;
}

let nextKey = 0;
/** A fresh row key. Module-scoped, so two rows never share one in a session. */
export function draftKey(): number {
  nextKey += 1;
  return nextKey;
}

export function toDraft(idea: StaffIdeaDto): IdeaDraft {
  return {
    title: idea.title,
    pitch: idea.pitch,
    kind: idea.kind,
    category: idea.category.slug,
    tags: idea.tags.map((t) => t.slug),
    capabilities: idea.capabilities.map((text) => ({ key: draftKey(), text })),
    evidence: idea.evidence.map((e) => ({
      key: draftKey(),
      claim: e.claim,
      sourceName: e.sourceName,
      url: e.url,
      sourceDate: e.sourceDate ?? '',
    })),
    gap: idea.gap ?? '',
    whyNow: idea.whyNow ?? '',
    whyMotir: idea.whyMotir ?? '',
    whoElse: idea.whoElse ?? '',
    reviewed: false,
  };
}

function evidenceOf(draft: IdeaDraft): IdeaEvidenceInput[] {
  return draft.evidence.map((e) => ({
    claim: e.claim.trim(),
    sourceName: e.sourceName.trim(),
    url: e.url.trim(),
    sourceDate: e.sourceDate.trim() || null,
  }));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An empty optional text is `null` on the wire — the service's "not written". */
function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The patch the save sends: the changed fields only, `{}` when nothing changed. */
export function toPatch(idea: StaffIdeaDto, draft: IdeaDraft): IdeaPatch {
  const patch: IdeaPatch = {};
  if (draft.title.trim() !== idea.title) patch.title = draft.title.trim();
  if (draft.pitch.trim() !== idea.pitch) patch.pitch = draft.pitch.trim();
  if (draft.kind !== idea.kind) patch.kind = draft.kind;
  if (draft.category !== idea.category.slug) patch.category = draft.category;
  if (
    !same(
      draft.tags,
      idea.tags.map((t) => t.slug),
    )
  )
    patch.tags = [...draft.tags];
  const capabilities = draft.capabilities.map((c) => c.text.trim());
  if (!same(capabilities, idea.capabilities)) patch.capabilities = capabilities;
  const evidence = evidenceOf(draft);
  const stored = idea.evidence.map((e) => ({
    claim: e.claim,
    sourceName: e.sourceName,
    url: e.url,
    sourceDate: e.sourceDate ?? null,
  }));
  if (!same(evidence, stored)) patch.evidence = evidence;
  for (const field of ['gap', 'whyNow', 'whyMotir', 'whoElse'] as const) {
    const next = optional(draft[field]);
    if (next !== (idea[field] ?? null)) patch[field] = next;
  }
  if (draft.reviewed) patch.reviewed = true;
  return patch;
}

/** Switching to Direction clears the two Motir-would-buy fields: the service refuses them there. */
export function withKind(draft: IdeaDraft, kind: IdeaKind): IdeaDraft {
  return kind === 'direction' ? { ...draft, kind, whyMotir: '', whoElse: '' } : { ...draft, kind };
}

/** Move one row of a list up (-1) or down (+1); out of range is a no-op. */
export function moveRow<T>(rows: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** The `fieldError.*` message for one refused field, with its ICU values. */
export type FieldMessageKey =
  | 'title'
  | 'pitch'
  | 'long'
  | 'motirOnly'
  | 'evidenceRequired'
  | 'evidenceMax'
  | 'claim'
  | 'sourceName'
  | 'url'
  | 'sourceDate'
  | 'capability'
  | 'capabilities'
  | 'tags'
  | 'unknownTag'
  | 'reason'
  | 'generic';

export interface FieldMessage {
  key: FieldMessageKey;
  values?: Record<string, string>;
}

/**
 * Which sentence a refusal shows — design § Ideas "Field messages". The page
 * maps the service's field PATH to its own words and never shows the raw
 * English `message`, which was written for API callers.
 */
export function fieldMessage(issue: IdeaFieldIssue, draft: IdeaDraft): FieldMessage {
  const { field } = issue;
  if (field === 'tags') {
    if (issue.tag) return { key: 'unknownTag', values: { tag: issue.tag } };
    return { key: 'tags' };
  }
  if (field === 'title' || field === 'pitch') return { key: field };
  if (field === 'gap' || field === 'whyNow') return { key: 'long' };
  if (field === 'whyMotir' || field === 'whoElse') {
    return draft.kind === 'direction' ? { key: 'motirOnly' } : { key: 'long' };
  }
  if (field === 'evidence') {
    return draft.kind === 'direction' && draft.evidence.length === 0
      ? { key: 'evidenceRequired' }
      : { key: 'evidenceMax' };
  }
  if (field === 'capabilities') return { key: 'capabilities' };
  if (/^capabilities\[\d+\]$/.test(field)) return { key: 'capability' };
  const row = /^evidence\[\d+\]\.(claim|sourceName|url|sourceDate)$/.exec(field);
  if (row) return { key: row[1] as 'claim' | 'sourceName' | 'url' | 'sourceDate' };
  if (field === 'reason') return { key: 'reason' };
  return { key: 'generic' };
}
