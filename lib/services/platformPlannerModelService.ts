import 'server-only';

import { getPlannerModelSettings, setPlannerModel } from '@/lib/ai/motirAiClient';
import { PLANNER_AUDIENCES, type PlannerAudience } from '@/lib/ai/types';
import type {
  PlatformPlannerModelSettingsDTO,
  PlatformPlannerModelWriteDTO,
} from '@/lib/dto/platformPlannerModel';
import {
  toPlatformPlannerModelSettingsDTO,
  toPlatformPlannerModelWriteDTO,
} from '@/lib/mappers/platformPlannerModelMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import { PlannerAudienceUnknownError, PlannerModelUnchangedError } from '@/lib/platform/errors';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * The platform PLANNING MODEL — Story MOTIR-7220 · MOTIR-7227, the console seam.
 *
 * Which model Motir plans with is one setting per audience (customer orgs, the
 * meta org, internal orgs), stored and validated in motir-ai
 * (`GET` / `PUT /v1/planner-model-settings`). This service is how the operator
 * console reads and changes it: any staff role reads, only a `superadmin`
 * writes, and every write appends one `PlatformAuditLog` row. No Prisma here —
 * the setting is motir-ai's and the audit row goes through `withPlatformRead`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUDIT ROW IS IN CORE AND THE SETTING IN MOTIR-AI
 * ---------------------------------------------------------------------------
 * The platform audit log is core's single append-only record of every staff
 * action (`docs/decisions/platform-staff-auth.md` §7: *"Every one of those
 * writes reuses this gate and this `PlatformAuditLog`"*), and the facts that
 * make a model acceptable — a servable catalogue row, a `planning` rate, a probe
 * that answered — are motir-ai's. So the REMOTE write runs INSIDE the audited
 * transaction: a refusal thrown by motir-ai rolls the audit row back with it,
 * and a refused write leaves no row.
 *
 * ⚠️ THE ONE RESIDUAL CASE, named rather than hidden: motir-ai applies the
 * change and core's commit then fails. The setting has moved and the trail has
 * no row for it. Nothing here can make a remote write and a local commit atomic;
 * the case is logged with both values so the row can be written by hand, and
 * motir-ai's own `updatedByCoreUserId` still names who did it.
 */

function isPlannerAudience(value: string): value is PlannerAudience {
  return (PLANNER_AUDIENCES as readonly string[]).includes(value);
}

export const platformPlannerModelService = {
  /**
   * The AI PLANNING page: three rows in `customer`, `meta`, `internal` order,
   * the offered models, and whether this principal may edit.
   *
   * Not audited: it reads no tenant row and no person's data — a platform
   * setting and the offered catalogue — and the ADR's read row is about crossing
   * the tenant boundary. The changer NAMES come from core's `User` table, which
   * is reference data here (`CLAUDE.md`: a read of unrelated reference data
   * needs no transaction).
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws MotirAiUnavailableError when motir-ai cannot answer — the page shows
   *   its error card rather than a guessed value.
   */
  async getSettings(principal: PlatformPrincipal): Promise<PlatformPlannerModelSettingsDTO> {
    await requirePlatformStaff('support');
    const read = await getPlannerModelSettings();
    const changers = [
      ...new Set(
        read.settings.map((s) => s.updatedByCoreUserId).filter((id): id is string => !!id),
      ),
    ];
    const users = await userRepository.findByIds(changers);
    return toPlatformPlannerModelSettingsDTO(
      read,
      users,
      platformRoleAtLeast(principal.role, 'superadmin'),
    );
  },

  /**
   * Set one audience's planning model.
   *
   * The ORDER is the contract, and each step is placed where it is so a refusal
   * leaves no audit row:
   *
   *   1. `superadmin`, before any remote call.
   *   2. The REASON, before the transaction — `withPlatformRead` writes the audit
   *      row as its first statement, so a reason checked later would be checked
   *      after its row existed (`setInternalBilling`'s ordering, for the same
   *      reason).
   *   3. The CURRENT model, read through the client, so the row can say from → to
   *      and a save to the model already held is refused as a non-change.
   *   4. The audited transaction, with motir-ai's write inside it: a
   *      `PlannerModelNotOfferedError` or `PlannerModelUnreachableError` thrown
   *      there rolls the row back.
   *
   * If motir-ai's `previousModel` (read under its own row lock) is not the
   * `fromModel` read in step 3, another write landed in between. The save still
   * succeeds — the new model is what the superadmin chose — and a warning
   * carries both, because the row's `fromModel` then names the model this
   * superadmin SAW, not the one the write replaced.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlannerAudienceUnknownError for an audience that is not one of the three.
   * @throws PlannerModelUnchangedError when the audience already holds `model`.
   * @throws PlannerModelNotOfferedError / PlannerModelUnreachableError from motir-ai.
   */
  async setModel(
    principal: PlatformPrincipal,
    audience: string,
    model: string,
    reason: string,
  ): Promise<PlatformPlannerModelWriteDTO> {
    await requirePlatformStaff('superadmin');
    if (!isPlannerAudience(audience)) throw new PlannerAudienceUnknownError(audience);
    const base = {
      action: 'ai.planner_model.set' as const,
      targetKind: 'platform' as const,
      targetId: audience,
      reason,
    };
    assertReasonSatisfied(base);

    const current = await getPlannerModelSettings();
    const fromModel = current.settings.find((s) => s.audience === audience)?.model ?? null;
    if (fromModel === model) throw new PlannerModelUnchangedError(audience, model);

    const entry: PlatformAuditEntry = {
      ...base,
      metadata: { audience, fromModel, toModel: model },
    };
    let applied = null as { previousModel: string; model: string } | null;
    try {
      const result = await withPlatformRead(principal, entry, async () => {
        const written = await setPlannerModel({
          audience,
          model,
          actorCoreUserId: principal.userId,
        });
        applied = written;
        return written;
      });
      if (result.previousModel !== fromModel) {
        console.warn(
          `[platform-planner-model] concurrent write on the ${audience} audience: this save read ` +
            `"${fromModel}" but replaced "${result.previousModel}" (now "${result.model}")`,
        );
      }
      return toPlatformPlannerModelWriteDTO(result, fromModel ?? result.previousModel);
    } catch (err) {
      if (applied) {
        // The residual case in this file's header: motir-ai moved the setting and
        // core's commit did not land, so the trail has no row for a real change.
        const { previousModel, model: toModel } = applied;
        console.error(
          `[platform-planner-model] motir-ai applied ${audience}: "${previousModel}" → ` +
            `"${toModel}" by ${principal.userId}, but the audit row did not commit`,
          err,
        );
      }
      throw err;
    }
  },
};
