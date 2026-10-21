// ── Section findings — VALIDATE by parsing on read (Story MOTIR-9023 · MOTIR-9032)
//
// `validate_plan` / `validate_work_item` parse a card's free-text body against the
// section registry for its kind × type and report what a required section is
// missing BY NAME. The registry and the parser own every name: this module only
// reads `parseSections`' answer, so a section added to the registry is validated
// with no edit here. ADVISORY — a finding never changes a verdict.
//
// PURE: no DB, no `tx`. The caller supplies the body (stored, or projected from a
// plan) and the card's kind and type.

import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import type { SectionFindingDto } from '@/lib/dto/workItems';
import { parseSections } from '@/lib/workItems/sections/parse';
import type { SectionType } from '@/lib/workItems/sections/registry';

export interface SectionFindingInput {
  /** The card's identifier. */
  item: string;
  kind: string;
  type: string | null | undefined;
  descriptionMd: string | null | undefined;
}

/**
 * The finding for one card, or `null` when its body reads clean (nothing missing,
 * unreadable or undefined for its cell) — or when the
 * registry has no cell for its kind × type (nothing to judge it against).
 */
export function sectionFindingFor(card: SectionFindingInput): SectionFindingDto | null {
  if (!(ISSUE_TYPES as readonly string[]).includes(card.kind)) return null;
  const type = card.type ?? null;
  if (type !== null && !(WORK_ITEM_TYPES as readonly string[]).includes(type)) return null;

  const parsed = parseSections(card.descriptionMd, card.kind as IssueType, type as SectionType);
  const otherHeadings = (parsed.sections.otherSections ?? []).map((o) => o.heading);
  if (parsed.missing.length === 0 && parsed.invalid.length === 0 && otherHeadings.length === 0) {
    return null;
  }

  return {
    item: card.item,
    kind: card.kind,
    type,
    state:
      parsed.signals.includes('empty') || parsed.signals.includes('no-headings')
        ? 'unstructured'
        : 'incomplete',
    missing: [...parsed.missing],
    invalid: parsed.invalid.map((i) => ({ section: i.section, message: i.message })),
    otherHeadings,
    signals: [...parsed.signals],
  };
}

/** Findings for many cards, sorted by item. */
export function sectionFindingsFor(cards: readonly SectionFindingInput[]): SectionFindingDto[] {
  return cards
    .map(sectionFindingFor)
    .filter((f): f is SectionFindingDto => f !== null)
    .sort((a, b) => a.item.localeCompare(b.item));
}
