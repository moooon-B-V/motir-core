import type { AiInFlightCodeFields, InFlightCodeDto } from '@/lib/dto/ai';

// The IN-FLIGHT CODE derivation (MOTIR-6618) — where a card's unmerged code lives,
// one entry per repository, from delivery rows already read. PURE: no query, no
// provider call. The service (`aiBoundaryService.getItem`) does the ONE batched
// read of the card's and its ancestors' deliveries and hands the rows here.
//
// The rule, per repository:
//   1. OWN FIRST — the card's own delivery whose pull request is OPEN (open and
//      not merged) → `source: 'own'`.
//   2. ELSE INHERITED — the NEAREST ancestor with an open delivery in that
//      repository → `source: 'inherited'`, `fromKey` = that ancestor's key. That
//      is the story's `parent/…` branch a child's commit rides.
//   3. MERGED IS NOT IN-FLIGHT — an own merged delivery contributes to
//      `mergedRepos` instead, unless the repository still has an in-flight entry.
//
// Several open deliveries at ONE level in ONE repository resolve to the newest
// LINK (the last in the input's per-card link-age order), so the answer is a
// function of the rows and not of a tie.

/** One delivery row, reduced to what the derivation reads. */
export interface InFlightDeliveryFact {
  workItemId: string;
  /** `owner/name` — the `repoRef` `read_file` accepts. */
  repo: string;
  branch: string;
  headSha: string | null;
  prNumber: number;
  prUrl: string;
  draft: boolean;
  baseRef: string | null;
  /** Open AND not merged. */
  open: boolean;
  merged: boolean;
}

export interface InFlightCodeInput {
  itemId: string;
  /** The card's ancestors inside the token's project, NEAREST FIRST (parent,
   *  grandparent, …), each with the key an inherited entry names. */
  ancestors: ReadonlyArray<{ id: string; key: string }>;
  /** Every delivery of the card AND of its ancestors, in link-age order per card. */
  deliveries: readonly InFlightDeliveryFact[];
}

type EntryBase = Omit<InFlightCodeDto, 'source' | 'fromKey'>;

function toEntryBase(f: InFlightDeliveryFact): EntryBase {
  return {
    repo: f.repo,
    branch: f.branch,
    headSha: f.headSha,
    prNumber: f.prNumber,
    prUrl: f.prUrl,
    draft: f.draft,
    baseRef: f.baseRef,
  };
}

/** The newest-linked OPEN delivery per repository, for one card. */
function openByRepo(
  deliveries: readonly InFlightDeliveryFact[],
  workItemId: string,
): Map<string, InFlightDeliveryFact> {
  const out = new Map<string, InFlightDeliveryFact>();
  for (const f of deliveries) {
    if (f.workItemId === workItemId && f.open) out.set(f.repo, f);
  }
  return out;
}

export function deriveInFlightCode(input: InFlightCodeInput): AiInFlightCodeFields {
  const entries = new Map<string, InFlightCodeDto>();

  for (const [repo, f] of openByRepo(input.deliveries, input.itemId)) {
    entries.set(repo, { ...toEntryBase(f), source: 'own' });
  }
  // Nearest ancestor first, so the first one to claim a repository wins.
  for (const ancestor of input.ancestors) {
    for (const [repo, f] of openByRepo(input.deliveries, ancestor.id)) {
      if (!entries.has(repo)) {
        entries.set(repo, { ...toEntryBase(f), source: 'inherited', fromKey: ancestor.key });
      }
    }
  }

  const merged = new Set<string>();
  for (const f of input.deliveries) {
    if (f.workItemId === input.itemId && f.merged && !entries.has(f.repo)) merged.add(f.repo);
  }

  const byRepo = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    inFlightCode: [...entries.keys()].sort(byRepo).map((repo) => entries.get(repo)!),
    mergedRepos: [...merged].sort(byRepo),
  };
}
