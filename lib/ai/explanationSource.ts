import type { WorkItemExplanationSourceDto } from '@/lib/dto/workItems';
import { isLocale, type Locale } from '@/lib/i18n/locales';

// The "Draft with AI" provenance rule (8.8.12), shared by the create modal and
// the edit form so both classify a drafted explanation identically. It is a
// PURE function (no React, no I/O) — safe to import into a Client Component.
//
// `draftBaseline` is the exact text the AI streamed this session (null when the
// user never drafted). Given the editor's CURRENT value, the source to PERSIST
// on save is:
//   - no draft this session → `undefined` — the caller omits the field, so the
//     service keeps its own rule (a hand-typed explanation defaults to
//     `user_authored` on create; the edit form's auto-flip rule applies on
//     update).
//   - the value still EQUALS the AI draft (untouched) → `ai_draft`.
//   - the value DIFFERS from the AI draft (the user edited it) → `user_edited`.
//   - the value was cleared to empty → `undefined` (no explanation, no source
//     claim).
// Comparison is trim-insensitive so trailing-whitespace noise doesn't flip an
// untouched draft to `user_edited`.
export function explanationSourceForSave(
  currentValue: string,
  draftBaseline: string | null,
): WorkItemExplanationSourceDto | undefined {
  if (draftBaseline === null) return undefined;
  const current = currentValue.trim();
  if (current.length === 0) return undefined;
  return current === draftBaseline.trim() ? 'ai_draft' : 'user_edited';
}

// Should the "AI-drafted" badge show RIGHT NOW (before save)? True only while the
// editor still holds the untouched AI draft — the same condition that makes
// `explanationSourceForSave` return `ai_draft`. The forms also OR this with the
// already-persisted server source for a value that was an `ai_draft` before this
// session and hasn't been edited.
export function isUntouchedAiDraft(currentValue: string, draftBaseline: string | null): boolean {
  return explanationSourceForSave(currentValue, draftBaseline) === 'ai_draft';
}

// The LANGUAGE to persist with the explanation (Story MOTIR-7734 · MOTIR-8744) —
// the draft's own, on the same rule as the source above: only when there is a
// draft this session, the editor still holds text, and the draft's frame named a
// language. An edited draft keeps the draft's language (a human edit's language
// is not detected). Otherwise `undefined`: the caller omits it, and the write
// door records the organisation's content language.
export function explanationLanguageForSave(
  currentValue: string,
  draftBaseline: string | null,
  draftLanguage: Locale | null,
): Locale | undefined {
  if (draftBaseline === null) return undefined;
  if (currentValue.trim().length === 0) return undefined;
  return draftLanguage ?? undefined;
}

// The SERVER ACTIONS' whitelist for that language (MOTIR-8744): the one key the
// browser may send is `languages.explanation`, kept only when it is one of the
// eleven locales and the explanation holds text. A forged `title` or
// `description` language, or any other value, never reaches the write door.
export function explanationLanguageFromClient(
  languages: { explanation?: unknown } | undefined,
  explanationMd: string | null | undefined,
): { languages: { explanation: Locale } } | Record<string, never> {
  const explanation = languages?.explanation;
  if (typeof explanation !== 'string' || !isLocale(explanation)) return {};
  if (!explanationMd?.trim()) return {};
  return { languages: { explanation } };
}
