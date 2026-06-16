// The CURATED project-topic vocabulary (Story 6.13 · Subtask 6.13.5) — the
// bounded set of categories a project may be tagged with, the GitHub-Topics /
// GitLab-Topics browse axis for the public-project square.
//
// DECISION sealed by this subtask (decision-authority rung 1 — GitHub/GitLab
// Topics): the vocabulary is CURATED, not free-text. An admin assigns tags from
// this fixed set; they cannot MINT a new topic per project. A curated set keeps
// the square's category axis a clean browse surface instead of a long tail of
// near-duplicate free-text tags ("ai" vs "AI" vs "artificial-intelligence").
// Growing the vocabulary is a deliberate edit to THIS list, never a per-project
// side effect. (Justified-deviation note: GitHub Topics are open free-text;
// Motir's square is a SHARED cross-org directory where a clean, normalized
// browse axis matters more than per-repo expressivity — so we mirror GitLab's
// "topics sorted by project count" browse over a normalized vocabulary, the
// recorded rung-1 deviation toward the curated shape.)
//
// `slug` is the stable, URL-safe handle the 6.13.3 category filter + the
// category-browse panel key off; `label` is the display name. The tagging
// service materializes each entry as a shared `ProjectTag` row (by slug) on
// first assignment, so the DB carries only the topics actually in use.

export interface ProjectTagVocabularyEntry {
  /** Stable URL-safe slug — the category-filter handle (6.13.3). */
  slug: string;
  /** Display name shown on the tag chips + the category-browse panel. */
  label: string;
}

/**
 * The curated topic set. Kept alphabetically by slug for review legibility; the
 * browse panel sorts by public-project count at read time, not by this order.
 */
export const PROJECT_TAG_VOCABULARY: readonly ProjectTagVocabularyEntry[] = [
  { slug: 'ai-ml', label: 'AI & Machine Learning' },
  { slug: 'analytics', label: 'Analytics' },
  { slug: 'automation', label: 'Automation' },
  { slug: 'collaboration', label: 'Collaboration' },
  { slug: 'communication', label: 'Communication' },
  { slug: 'content', label: 'Content' },
  { slug: 'data', label: 'Data' },
  { slug: 'design', label: 'Design' },
  { slug: 'developer-tools', label: 'Developer Tools' },
  { slug: 'devops', label: 'DevOps' },
  { slug: 'e-commerce', label: 'E-commerce' },
  { slug: 'education', label: 'Education' },
  { slug: 'finance', label: 'Finance' },
  { slug: 'gaming', label: 'Gaming' },
  { slug: 'healthcare', label: 'Healthcare' },
  { slug: 'infrastructure', label: 'Infrastructure' },
  { slug: 'marketing', label: 'Marketing' },
  { slug: 'mobile', label: 'Mobile' },
  { slug: 'open-source', label: 'Open Source' },
  { slug: 'productivity', label: 'Productivity' },
  { slug: 'security', label: 'Security' },
  { slug: 'social', label: 'Social' },
  { slug: 'sustainability', label: 'Sustainability' },
  { slug: 'web', label: 'Web' },
] as const;

/**
 * The most tags one project may carry — mirrors GitHub's 20-topics-per-repo cap
 * (decision-authority rung 1). Bounds the per-project chip row and keeps the tag
 * picker a finite choice.
 */
export const MAX_TAGS_PER_PROJECT = 20;

const BY_SLUG: ReadonlyMap<string, ProjectTagVocabularyEntry> = new Map(
  PROJECT_TAG_VOCABULARY.map((entry) => [entry.slug, entry]),
);

/** The vocabulary entry for a slug, or `undefined` when the slug is off-vocabulary. */
export function vocabularyEntry(slug: string): ProjectTagVocabularyEntry | undefined {
  return BY_SLUG.get(slug);
}

/** Whether `slug` is part of the curated vocabulary. */
export function isVocabularySlug(slug: string): boolean {
  return BY_SLUG.has(slug);
}
