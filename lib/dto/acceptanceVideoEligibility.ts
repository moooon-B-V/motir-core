// The story-acceptance-video eligibility verdict (Story MOTIR-1627 · Subtask
// MOTIR-1630) — the single computed source the acceptance panel, the publish
// endpoint, and the project's Approvals room all read, so they never disagree.
// Encodes the ADR decision-1 table: eligible IFF the org holds a paid AI plan
// (Axis A) AND the PROJECT's switch is ON (MOTIR-4925); off-cloud / meta orgs are
// `applicable:false`.

/**
 * Why the org is (in)eligible — drives the panel's THREE states:
 *   - `eligible`        → the player / pending state.
 *   - `toggle_off`      → admin sees "Turn on"; non-admin sees "ask an admin".
 *   - `no_plan`         → the Upgrade CTA.
 *   - `not_applicable`  → nothing gated (self-host / meta org): render nothing.
 */
export type AcceptanceVideoEligibilityReason =
  | 'eligible'
  | 'no_plan'
  | 'toggle_off'
  | 'not_applicable';

export interface AcceptanceVideoEligibilityDTO {
  /** False off-cloud / for the meta org / with no resolvable org — never gate. */
  applicable: boolean;
  /** The org may generate acceptance video (paid AI plan AND toggle ON). */
  eligible: boolean;
  reason: AcceptanceVideoEligibilityReason;
  hasPaidAiPlan: boolean;
  toggleEnabled: boolean;
  /** Org OWNER — the Upgrade CTA acts for them (mirrors AiAccess.canManageBilling). */
  canManageBilling: boolean;
  /** Holds `workflow:manage` on the story's project — may flip the switch (the
   *  panel's admin-vs-non-admin OFF split). Was org owner/admin until MOTIR-5172
   *  moved the switch's write to the project tier. */
  canManageToggle: boolean;
  organizationId: string | null;
}
