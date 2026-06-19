// Direction-doc view model — the consumer-side (motir-core) contract the
// read-only render component (`DirectionDocView`, subtask 7.3.6 / MOTIR-834)
// renders. The authoritative store lives in motir-ai (subtasks 7.3.2 / 7.3.15);
// these types MIRROR its `DirectionDocDto` / `FeatureCatalogDto` shapes so the
// gate flow (7.3.5 / MOTIR-833) and the planning canvas (MOTIR-1008) — which
// fetch through the motir-ai client (7.1.5) — can map their results straight
// into this presentational component without re-deriving a shape.
//
// A direction doc's body is a SINGLE Markdown string (`contentMd`): the four
// tiers each serialize to `# Title (Tier N)` + `## N. Section` Markdown (see
// motir-ai `src/llm/exemplars.ts`). The render component supplies the editorial
// chrome (plain-language tier label, kicker, tier colour, read-only hint) and
// renders the Markdown body through the shared `renderMarkdown` pipeline. The
// feature catalog is STRUCTURED (not Markdown) and folds into the vision tier.

/** The four pre-plan direction tiers (mirrors motir-ai `DirectionDocKind`). */
export type DirectionDocKind = 'discovery' | 'vision' | 'feasibility' | 'validation';

/** The journey order the tiers are produced + reviewed in. */
export const DIRECTION_DOC_ORDER: readonly DirectionDocKind[] = [
  'discovery',
  'vision',
  'feasibility',
  'validation',
];

/** A produced tier doc — its kind + the persisted Markdown body. */
export interface DirectionDocView {
  kind: DirectionDocKind;
  /** The full tier write-up as Markdown (the motir-ai `contentMd` field). */
  contentMd: string;
  /** Monotonic save version (motir-ai never clobbers); optional for display. */
  version?: number;
}

// ── Feature catalog (structured; folded into the vision tier) ────────────────
// Mirrors motir-ai `FeatureCatalogDto` and its children. The phase/status enums
// match motir-ai's `FeaturePhase` / `FeatureStatus` exactly.

export type FeaturePhase = 'mvp' | 'v1' | 'v2' | 'ai';
export type FeatureStatus = 'todo' | 'in_progress' | 'done';

export interface CatalogFeatureView {
  id: string;
  name: string;
  descriptionMd: string;
  phase: FeaturePhase;
  status: FeatureStatus;
}

export interface FeatureCategoryView {
  id: string;
  title: string;
  features: CatalogFeatureView[];
}

export interface GlossaryConceptView {
  id: string;
  term: string;
  aka: string | null;
  descriptionMd: string;
  example: string | null;
}

export interface GlossaryGroupView {
  id: string;
  title: string;
  concepts: GlossaryConceptView[];
}

export interface FeatureCatalogView {
  categories: FeatureCategoryView[];
  glossary: GlossaryGroupView[];
}

// ── Tier presentation metadata ───────────────────────────────────────────────
// PLAIN-LANGUAGE labels + kickers (a founder won't know "Feasibility" /
// "Validation") and the tier COLOUR accent — both straight from the onboarding
// design (`design/ai-chat/design-notes.md`, screens D–G). Colour routes through
// the `--el-*` swap layer (never `--color-*`): discovery → info, vision → the
// brand accent, feasibility → success, validation → warning.

export interface TierMeta {
  /** The plain-language full-screen title (design screens D–G). */
  label: string;
  /** The mono kicker above the title (design `.doc-meta`). */
  kicker: string;
  /** Optional tiers (feasibility, validation) carry the "optional" tag. */
  optional: boolean;
  /** The tier accent `--el-*` token (the kicker dot + section accents). */
  accentVar: string;
}

export const TIER_META: Record<DirectionDocKind, TierMeta> = {
  discovery: {
    label: 'Understanding your idea',
    kicker: "What you're building & who for",
    optional: false,
    accentVar: '--el-info',
  },
  vision: {
    label: "What we'll build",
    kicker: 'The shape of v1',
    optional: false,
    accentVar: '--el-accent-on-surface',
  },
  feasibility: {
    label: 'Is it worth building?',
    kicker: 'A reality check',
    optional: true,
    accentVar: '--el-success',
  },
  validation: {
    label: 'Will people want it?',
    kicker: 'The market',
    optional: true,
    accentVar: '--el-warning',
  },
};

// ── Markdown helpers ─────────────────────────────────────────────────────────

/**
 * Strip a single leading top-level `# …` title line from a tier's `contentMd`.
 * The serialized docs open with `# Motir — Vision (Tier 2)` — internal/jargon
 * wording the render component REPLACES with the plain-language tier label, so
 * we drop it to avoid a redundant, jargon-y duplicate heading. Any `#` heading
 * deeper in the body is left untouched.
 */
export function stripLeadingTitle(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n+/, '');
}

const OPEN_QUESTIONS_HEADING = /^(#{1,6})\s+.*open\s+questions.*$/im;

/**
 * Split a tier's Markdown into its body and its "Open questions" section so the
 * render component can SURFACE the open questions as a distinct callout (an
 * acceptance criterion) rather than letting them read as just another section.
 *
 * The section runs from its heading up to the next heading of the SAME-or-higher
 * level (or end of doc). Returns `openQuestionsMd` as the section's inner
 * Markdown (heading removed); `null` when the doc has no such section.
 */
export function splitOpenQuestions(md: string): {
  body: string;
  openQuestionsMd: string | null;
} {
  const lines = md.split('\n');
  let startIdx = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(OPEN_QUESTIONS_HEADING);
    if (m) {
      startIdx = i;
      headingLevel = m[1]!.length;
      break;
    }
  }
  if (startIdx === -1) return { body: md, openQuestionsMd: null };

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const h = lines[i]?.match(/^(#{1,6})\s+/);
    if (h && h[1]!.length <= headingLevel) {
      endIdx = i;
      break;
    }
  }

  const section = lines
    .slice(startIdx + 1, endIdx)
    .join('\n')
    .trim();
  const body = [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join('\n').trim();
  return { body, openQuestionsMd: section.length > 0 ? section : null };
}

/** Human label for a catalog feature's build phase. */
export function phaseLabel(phase: FeaturePhase): string {
  switch (phase) {
    case 'mvp':
      return 'MVP';
    case 'v1':
      return 'v1';
    case 'v2':
      return 'v2';
    case 'ai':
      return 'AI';
  }
}

/** Map a catalog feature's status onto the `Pill` status variant. */
export function statusPillVariant(status: FeatureStatus): 'planned' | 'in-progress' | 'done' {
  switch (status) {
    case 'todo':
      return 'planned';
    case 'in_progress':
      return 'in-progress';
    case 'done':
      return 'done';
  }
}
