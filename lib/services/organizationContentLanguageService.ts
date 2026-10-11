import type {
  ContentLanguageChangeDTO,
  ContentLanguageLatestChangeDTO,
  OrganizationDTO,
} from '@/lib/dto/organizations';
import { isLocale } from '@/lib/i18n/locales';
import {
  toContentLanguageChangeDTO,
  toContentLanguageLatestChangeDTO,
  toOrganizationDTO,
} from '@/lib/mappers/organizationMappers';
import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import { withOrgContext } from '@/lib/organizations/context';
import { InvalidContentLanguageError, OrganizationNotFoundError } from '@/lib/organizations/errors';
import { organizationContentLanguageChangeRepository } from '@/lib/repositories/organizationContentLanguageChangeRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertOrgCapability } from '@/lib/services/organizationAccessService';

// An organisation's CONTENT language — the language new work in it is written in
// (Story MOTIR-7731 · MOTIR-8094). This service is the only writer of
// `Organization.contentLanguage` after creation, and the only writer of its
// attributed history. Changing it is `manageOrgSettings` (owner and admin), the
// same cell that governs the org's name; a member is refused 403, a non-member
// 404 (no existence leak). It changes what NEW writing is labelled; nothing
// already written is relabelled.

export const organizationContentLanguageService = {
  /**
   * Set the content language and record who changed it, from what, to what.
   *
   * The current value is read UNDER the organisation's row lock, so two changes
   * racing each other serialise: the second reads the first's result as its
   * `from`, and the history chains (`en`→`ja`, `ja`→`ko`) rather than recording
   * two changes both from `en`. Setting the value it already has is a success
   * that writes no history row.
   */
  async changeContentLanguage(input: {
    organizationId: string;
    actorUserId: string;
    language: string;
  }): Promise<OrganizationDTO> {
    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgCapability(input.actorUserId, input.organizationId, 'manageOrgSettings', tx);
        await assertOrgNotClosing(input.organizationId, tx);
        const language = input.language;
        if (!isLocale(language)) throw new InvalidContentLanguageError(language);

        await organizationRepository.lockByIdForUpdate(input.organizationId, tx);
        const current = await organizationRepository.findByIdInTx(input.organizationId, tx);
        if (!current) throw new OrganizationNotFoundError(input.organizationId);
        if (current.contentLanguage === language) return current;

        const updated = await organizationRepository.update(
          input.organizationId,
          { contentLanguage: language },
          tx,
        );
        await organizationContentLanguageChangeRepository.insert(
          {
            organizationId: input.organizationId,
            changedByUserId: input.actorUserId,
            fromLanguage: current.contentLanguage,
            toLanguage: language,
          },
          tx,
        );
        return updated;
      },
    );
    return toOrganizationDTO(org);
  },

  /** The history, newest first — to an owner or admin only. */
  async listContentLanguageChanges(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<ContentLanguageChangeDTO[]> {
    const rows = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgCapability(input.actorUserId, input.organizationId, 'manageOrgSettings', tx);
        return organizationContentLanguageChangeRepository.listByOrganization(
          input.organizationId,
          tx,
        );
      },
    );
    return rows.map(toContentLanguageChangeDTO);
  },

  /**
   * The newest change with the person who made it — the General card's
   * attribution line (MOTIR-8095). Owner or admin only, like the history; null
   * when the language was never changed (registration writes no row).
   */
  async getLatestContentLanguageChange(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<ContentLanguageLatestChangeDTO | null> {
    return withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgCapability(input.actorUserId, input.organizationId, 'manageOrgSettings', tx);
        const row = await organizationContentLanguageChangeRepository.findLatestByOrganization(
          input.organizationId,
          tx,
        );
        if (!row) return null;
        const user = row.changedByUserId
          ? await userRepository.findById(row.changedByUserId, tx)
          : null;
        return toContentLanguageLatestChangeDTO(row, user);
      },
    );
  },
};
