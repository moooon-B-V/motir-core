import type {
  EnterpriseAgentPathValue,
  EnterpriseAutonomyValue,
  EnterpriseStartWhenValue,
  EnterpriseTeamSizeValue,
} from '@/lib/dto/billing';

// The operator console's view of Enterprise requests (Story MOTIR-7602 ·
// Subtask MOTIR-7608; design `platform-admin/design-notes.md` § Enterprise
// requests). Staff see the request's REAL state — `new` … `won` / `lost` — where
// the org sees the folded `EnterpriseRequestOrgStatus`.

/** Every state, in the lifecycle's order. */
export const ENTERPRISE_REQUEST_STATUSES = [
  'new',
  'contacted',
  'offer_sent',
  'won',
  'lost',
] as const;
export type EnterpriseRequestStatusValue = (typeof ENTERPRISE_REQUEST_STATUSES)[number];

/**
 * The list's state filter — the design's `Segmented`: **Open** (the default:
 * new, contacted or offer sent), each state on its own, and All.
 */
export const ENTERPRISE_REQUEST_FILTERS = ['open', ...ENTERPRISE_REQUEST_STATUSES, 'all'] as const;
export type EnterpriseRequestFilter = (typeof ENTERPRISE_REQUEST_FILTERS)[number];

/** The list's page size (design Panel 1: "Newest first · 50 a page"). */
export const ENTERPRISE_REQUEST_PAGE_SIZE = 50;

/** One request as staff see it. No price, ever — the offer lives outside the product. */
export interface PlatformEnterpriseRequestDTO {
  id: string;
  status: EnterpriseRequestStatusValue;
  organizationId: string;
  organizationName: string;
  /** The org's tier when it sent the request, or null when it had none. */
  tierKeyAtRequest: string | null;
  /** The member who sent it, or null once that account is deleted. */
  requester: { id: string; name: string; email: string } | null;
  contact: string;
  note: string;
  cardsPerDay: number | null;
  parallelAgents: number | null;
  agentPath: EnterpriseAgentPathValue | null;
  autonomy: EnterpriseAutonomyValue | null;
  startWhen: EnterpriseStartWhenValue | null;
  teamSize: EnterpriseTeamSizeValue | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 — set when the request reached `won` or `lost`. */
  closedAt: string | null;
}

/** One page of the list, newest first. */
export interface PlatformEnterpriseRequestPageDTO {
  filter: EnterpriseRequestFilter;
  requests: PlatformEnterpriseRequestDTO[];
  /** How many requests the current filter matches, across every page. */
  total: number;
  /** Each filter segment's count — the design draws one on every segment. */
  counts: Record<EnterpriseRequestFilter, number>;
  /** Pass back as `cursor` for the next (older) page; `null` on the last page. */
  nextCursor: string | null;
  pageSize: number;
}

/** One applied move, from its `enterprise_request.transition` audit row. */
export interface PlatformEnterpriseRequestMoveDTO {
  from: EnterpriseRequestStatusValue;
  to: EnterpriseRequestStatusValue;
  actorUserId: string;
  actorName: string;
  actorEmail: string;
  /** ISO 8601. */
  at: string;
}

/** The detail page: the request, every move oldest first, and what this viewer may do next. */
export interface PlatformEnterpriseRequestDetailDTO {
  request: PlatformEnterpriseRequestDTO;
  history: PlatformEnterpriseRequestMoveDTO[];
  /**
   * The legal next states for THIS viewer — empty for a closed request and for
   * a `support` viewer, who reads everything and moves nothing.
   */
  moves: EnterpriseRequestStatusValue[];
}
