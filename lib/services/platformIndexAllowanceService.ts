import { fetchIndexAllowanceSummary, fetchOrgTiers } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import {
  readRecalcThreshold,
  type IndexAllowanceSummary,
  type RecalcThreshold,
} from '@/lib/ciFleet/indexAllowance';
import { resolveDriftCount } from '@/lib/codeGraph/driftCount';
import type {
  IndexAllowanceSummaryDTO,
  IndexTierReading,
  PlatformIndexAllowanceDTO,
  StoppedOrgsDTO,
  StoppedReasonFilter,
} from '@/lib/dto/platformIndexAllowance';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// MONITORING · INDEX ALLOWANCE (MOTIR-4595 · Story MOTIR-4335; design Panel 13).
//
// ⚠️⚠️ MOTIR DOES NOT CHARGE FOR CODE INDEXING. This is Motir's internal accounting,
// read by platform staff; nothing it returns reaches a customer.
//
// ⚠️ TWO DATABASES, TWO FACTS, LABELLED APART. The per-tier table is motir-ai's
// (`GET /v1/admin/index-allowance/summary`, MOTIR-5340): how many orgs crossed a soft
// gate, how many Free orgs used their one-time allowance. The Stopped orgs list is
// motir-core's (`github_repo.index_paused_reason`, MOTIR-4593): orgs a dispatch was
// actually refused for. An exhausted org that has not tried to index since has no
// pause, so the Free row's EXHAUSTED count and the list's STOPPED count legitimately
// differ — neither is derived from the other.
//
// ⚠️ A READ THAT FAILED IS UNKNOWN, NEVER ZERO. motir-ai unreachable renders the
// table as unknown and the list's tier column as unknown; nothing becomes `0`.

export const STOPPED_ORGS_PAGE_SIZE = 25;

const REASON_BY_FILTER: Record<Exclude<StoppedReasonFilter, 'all'>, string> = {
  no_credit: 'paused_index_no_credit',
  allowance_exhausted: 'paused_index_allowance_exhausted',
};

/** Parse the URL's `reason` into a filter; anything unrecognised is `all`. */
export function parseStoppedFilter(value: string | undefined): StoppedReasonFilter {
  return value === 'no_credit' || value === 'allowance_exhausted' ? value : 'all';
}

/** How one tier reads. A one-time tier has no soft gate; an unconfigured tier has no
 *  gate at all; otherwise the rate is compared to the threshold. */
export function readingFor(
  tier: Pick<IndexAllowanceSummary['tiers'][number], 'cadence' | 'configured'>,
  ratePct: number | null,
  threshold: RecalcThreshold,
): IndexTierReading {
  if (!tier.configured) return 'unconfigured';
  if (tier.cadence === 'one_time') return 'hard_stop';
  return ratePct !== null && ratePct > threshold.pct ? 'recalculate' : 'holds';
}

function summaryDto(
  summary: IndexAllowanceSummary | null,
  threshold: RecalcThreshold,
): IndexAllowanceSummaryDTO {
  if (!summary) return { state: 'unknown' };
  const tiers = summary.tiers.map((tier) => {
    const numerator = tier.cadence === 'one_time' ? tier.exhausted : tier.crossed;
    const ratePct = tier.orgs > 0 && numerator !== null ? (numerator / tier.orgs) * 100 : null;
    return {
      tierKey: tier.tierKey,
      tierName: tier.tierName,
      cadence: tier.cadence,
      orgs: tier.orgs,
      crossed: tier.crossed,
      exhausted: tier.exhausted,
      ratePct,
      reading: readingFor(tier, ratePct, threshold),
      allotmentCredits: tier.allotmentCredits,
      grantedCreditsPerOrg: tier.grantedCreditsPerOrg,
    };
  });
  const softGated = tiers.filter((t) => t.cadence === 'monthly' && t.reading !== 'unconfigured');
  return {
    state: 'read',
    window: summary.window,
    tiers,
    softGatedTiers: softGated.length,
    tiersOverThreshold: softGated.filter((t) => t.reading === 'recalculate').length,
    oneTimeExhausted: tiers.reduce((sum, t) => sum + (t.exhausted ?? 0), 0),
  };
}

async function stoppedOrgs(args: {
  filter: StoppedReasonFilter;
  search: string | null;
  page: number;
}): Promise<StoppedOrgsDTO> {
  const counts = await withSystemContext((tx) =>
    githubRepoRepository.countIndexPausedOrgsByReason({ search: args.search }, tx),
  );
  const countOf = (reason: string) => counts.find((row) => row.reason === reason)?.orgs ?? 0;
  const all = counts.reduce((sum, row) => sum + row.orgs, 0);
  const total = args.filter === 'all' ? all : countOf(REASON_BY_FILTER[args.filter]);
  const pageCount = Math.max(1, Math.ceil(total / STOPPED_ORGS_PAGE_SIZE));
  const page = Math.min(Math.max(1, args.page), pageCount);

  const rows = await withSystemContext((tx) =>
    githubRepoRepository.listIndexPausedOrgs(
      {
        reason: args.filter === 'all' ? null : REASON_BY_FILTER[args.filter],
        search: args.search,
        limit: STOPPED_ORGS_PAGE_SIZE,
        offset: (page - 1) * STOPPED_ORGS_PAGE_SIZE,
      },
      tx,
    ),
  );
  const orgIds = rows.map((row) => row.organizationId);
  const [repos, tiers] = await Promise.all([
    withSystemContext((tx) => githubRepoRepository.listIndexPausedReposForOrgs(orgIds, tx)),
    fetchOrgTiers(orgIds),
  ]);

  // The graph's distance behind is `resolveDriftCount`'s answer per repository — the
  // one rule for "is this stored count still about this pair" — and an org shows its
  // most-behind paused repository.
  const behindByOrg = new Map<string, number>();
  for (const repo of repos) {
    const behind = resolveDriftCount(repo);
    if (behind === null) continue;
    behindByOrg.set(
      repo.organizationId,
      Math.max(behindByOrg.get(repo.organizationId) ?? 0, behind),
    );
  }

  return {
    filter: args.filter,
    search: args.search,
    counts: {
      all,
      noCredit: countOf(REASON_BY_FILTER.no_credit),
      allowanceExhausted: countOf(REASON_BY_FILTER.allowance_exhausted),
    },
    total,
    page,
    pageSize: STOPPED_ORGS_PAGE_SIZE,
    pageCount,
    rows: rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      tierKey: tiers === null ? 'unknown' : (tiers.get(row.organizationId) ?? null),
      reason: row.reason.replace(/^paused_index_/, ''),
      stoppedSince: row.stoppedSince.toISOString(),
      graphBehind: behindByOrg.get(row.organizationId) ?? null,
      pausedRepos: row.pausedRepos,
    })),
  };
}

export const platformIndexAllowanceService = {
  /**
   * The Monitoring section, for one platform principal. Re-asserts the staff ladder
   * (the `(admin)` layout gates the PAGE; a service trusting it would be one action
   * away from reachable without it) and records the read, which spans tenants.
   */
  async read(
    principal: PlatformPrincipal,
    input: { reason?: string | undefined; q?: string | undefined; page?: string | undefined } = {},
  ): Promise<PlatformIndexAllowanceDTO> {
    await requirePlatformStaff('support');
    await platformAuditService.record(principal, { action: 'estate.read', targetKind: 'platform' });

    // Off-cloud there is no fleet and no allowance: the section says so and reads nothing.
    if (!isCloudBilling()) return { meter: 'disabled' };

    const threshold = readRecalcThreshold();
    const search = input.q?.trim() ? input.q.trim().slice(0, 100) : null;
    const pageNumber = Number.parseInt(input.page ?? '1', 10);
    const [summary, stopped] = await Promise.all([
      fetchIndexAllowanceSummary(),
      stoppedOrgs({
        filter: parseStoppedFilter(input.reason),
        search,
        page: Number.isFinite(pageNumber) ? pageNumber : 1,
      }),
    ]);

    return { meter: 'enabled', threshold, summary: summaryDto(summary, threshold), stopped };
  },
};
