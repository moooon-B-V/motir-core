/**
 * The console's PLANNING LESSONS page — what crosses from
 * `platformLessonsService` to `/admin/planning-lessons` (Story MOTIR-1408 ·
 * MOTIR-1411, design `platform-admin/design-notes.md` § AMENDMENT 2026-10-02 —
 * Planning lessons).
 */

export type PlatformLessonMistakeType =
  | 'regular_planning'
  | 'onboarding_planning'
  | 'planning_craft'
  | 'coding';

export const PLATFORM_LESSON_MISTAKE_TYPES: readonly PlatformLessonMistakeType[] = [
  'regular_planning',
  'onboarding_planning',
  'planning_craft',
  'coding',
];

/** `injected` → Injected · `disabled` → Off · `not_recurred` → Resting. */
export type PlatformLessonInjectionState = 'injected' | 'off' | 'resting';

/** A tenant lesson's owner, its names resolved in core. Null on a global lesson. */
export interface PlatformLessonOwnerDTO {
  organizationId: string;
  /** Null when the id names no organization core still has. */
  organizationName: string | null;
  workspaceName: string | null;
  projectName: string | null;
}

export interface PlatformLessonRowDTO {
  id: string;
  title: string;
  /** The raw value; the page labels the four it knows and shows anything else as it came. */
  mistakeType: string;
  categories: string[];
  scope: 'global' | 'tenant';
  enabled: boolean;
  injection: PlatformLessonInjectionState;
  recurrenceCount: number;
  lastOccurredAt: string;
  createdAt: string;
  owner: PlatformLessonOwnerDTO | null;
}

export interface PlatformLessonListFilters {
  q?: string;
  scope?: 'global' | 'tenant';
  mistakeType?: string;
  category?: string;
  enabled?: boolean;
  organizationId?: string;
  cursor?: string;
}

export interface PlatformLessonListDTO {
  rows: PlatformLessonRowDTO[];
  nextCursor: string | null;
  retentionDays: number;
  /** The Organisation filter's options. */
  organizations: { id: string; name: string }[];
  /** The Category filter's options — the categories this page's rows carry, plus the set one. */
  categories: string[];
}

export interface PlatformLessonOccurrenceDTO {
  at: string;
  source: string;
  occurrenceRef: string;
}

/** One field a staff change moved, as the audit row's metadata records it. */
export interface PlatformLessonChangeDTO {
  field: string;
  before: unknown;
  after: unknown;
}

export interface PlatformLessonHistoryEntryDTO {
  id: string;
  action: 'edit' | 'enable' | 'disable' | 'promote';
  /** Null when the actor's account is gone. */
  actorName: string | null;
  at: string;
  reason: string | null;
  changes: PlatformLessonChangeDTO[];
}

export interface PlatformLessonDetailDTO extends PlatformLessonRowDTO {
  body: string;
  why: string;
  howToApply: string;
  sourceRef: string | null;
  retentionDays: number;
  occurrences: PlatformLessonOccurrenceDTO[];
  history: PlatformLessonHistoryEntryDTO[];
  /** `operator`+: edit and the switch. */
  canEdit: boolean;
  /** `superadmin`: promote — and only to the targets this lesson can still take. */
  promoteTargets: ('global' | 'planning_craft')[];
}

export interface PlatformLessonEditInput {
  title?: string;
  why?: string;
  howToApply?: string;
  categories?: string[];
}
