// DTOs for the require-2FA POLICY surface (Story MOTIR-1215 · Subtask
// MOTIR-3645) — what crosses from `twoFactorPolicyService` to the two admin
// panes (MOTIR-3646 / MOTIR-3647), the enforcement gate (MOTIR-3648) and the
// API gate (MOTIR-3653).
//
// Distinct from `lib/dto/twoFactor.ts`, which is the ACCOUNT's own two-factor
// state — what this person has enrolled in. These shapes are about what the
// person's ORGANISATION and WORKSPACES demand of them.

/**
 * An organization's own require-2FA setting.
 *
 * One field, and it stays a DTO rather than a bare boolean because the org pane
 * (MOTIR-3646) reads it beside the org identity and a bare boolean would give
 * the caller nowhere to put the next fact this pane needs.
 */
export interface OrganizationTwoFactorPolicyDTO {
  /** The organization this policy belongs to. */
  organizationId: string;
  /**
   * Whether this organization requires every member to hold a second factor.
   * The FLOOR: a workspace beneath it may raise the requirement, never lower it.
   */
  requiresTwoFactor: boolean;
}

/**
 * A workspace's require-2FA setting, together with the org setting above it.
 *
 * Both tiers cross, because the workspace control MOTIR-3642 draws has to
 * render a locked state that names the organization — and a control that knew
 * only its own value could not tell "off" from "off but overridden".
 */
export interface WorkspaceTwoFactorPolicyDTO {
  /** The workspace this policy belongs to. */
  workspaceId: string;
  /** The workspace's OWN setting, independent of the org's. */
  requiresTwoFactor: boolean;
  /** The owning organization's setting — the floor this workspace sits on. */
  organizationRequiresTwoFactor: boolean;
  /**
   * `true` when the organization already requires it, so the workspace control
   * renders locked ON and says who locked it.
   *
   * ⚠️ Derived, and it is NOT the same as `requiresTwoFactor`: a workspace can
   * be locked (`organizationRequiresTwoFactor: true`) while its own column is
   * still `false`, and the two must stay separable — turning the org policy off
   * must not silently drop a requirement a workspace admin set for themselves.
   * That is why MOTIR-3644 stores the two operands rather than the OR of them.
   */
  lockedByOrganization: boolean;
}

/** Which tenancy tier is demanding a second factor. */
export type TwoFactorMandateTier = 'organization' | 'workspace';

/**
 * WHO is asking. Carries the NAME, not only the id, because every surface that
 * renders this says *"required by your organization Acme"* — and a gate screen
 * that had to make a second query to name the organization would make it on
 * every page load.
 */
export interface TwoFactorMandateDTO {
  /** `organization` or `workspace`. */
  tier: TwoFactorMandateTier;
  /** The mandating row's id. */
  id: string;
  /** The mandating row's display name, as the person will read it. */
  name: string;
}

/**
 * The one answer the enforcement gate asks for (MOTIR-3648, MOTIR-3653): does
 * this person need a second factor right now, who is asking, and do they
 * already have one?
 */
export interface TwoFactorRequirementDTO {
  /**
   * `true` when ANY tier this person belongs to requires a second factor —
   * `org.requiresTwoFactor OR ANY(workspace.requiresTwoFactor)` over their own
   * memberships.
   *
   * ⚠️ It says NOTHING about whether they are allowed in: that is
   * `required && !compliant`. Keeping the two apart is what lets a compliant
   * person's page render without the gate having to re-derive anything.
   */
  required: boolean;
  /**
   * The tier being reported as the one demanding it, or `null` when nothing
   * does.
   *
   * ⚠️ THE ORGANIZATION WINS WHEN BOTH TIERS REQUIRE IT. It is the floor, and
   * naming the workspace would suggest that switching the workspace policy off
   * would help — which it would not.
   */
  mandatedBy: TwoFactorMandateDTO | null;
  /**
   * Whether the account holds at least one second factor —
   * `hasSecondFactor({ enabled, passkeyCount })`, the single predicate in
   * `lib/twoFactor/hasSecondFactor.ts`.
   *
   * ⚠️ A passkey counts even with `user.twoFactorEnabled` false. See that
   * module; it is the regression this story is most likely to reintroduce.
   */
  compliant: boolean;
}
