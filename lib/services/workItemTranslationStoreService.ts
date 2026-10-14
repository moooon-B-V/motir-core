import type { Prisma } from '@/generated/prisma/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemTranslationRepository } from '@/lib/repositories/workItemTranslationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import {
  EmptyTranslationTextError,
  UnsupportedTargetLanguageError,
} from '@/lib/translation/errors';
import {
  hasTranslatableText,
  hashFieldText,
  type TranslatableField,
} from '@/lib/translation/fieldRevision';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { TenantReadContext } from '@/lib/workspaces/tenantRead';

// The kept-translation store (Story MOTIR-7735 · Subtask MOTIR-8114): one
// translated text per FIELD, per REVISION of that field's text, per TARGET
// LANGUAGE, shared by every reader in the organisation that owns the project.
//
// THE STALENESS RULE lives in `getKept`: a lookup always carries the field's
// CURRENT text, which is hashed here, and only a row with that exact hash is
// served. A translation of older text is therefore never returned, and no edit
// path has to know this store exists. Superseded rows are removed by `keep`
// when a fresh revision of the same field and language is stored, and by
// cascade when the work item goes.
//
// TENANCY is resolved from the work item's own project, never from the caller:
// the item is read inside the caller's bound workspace context, so an item in
// another workspace is simply not found (the 404-not-403 posture), and the
// organisation stamped on a row is the one that owns that project's workspace.
//
// This store is NOT the single-flight billing guard. `keep`'s insert-if-absent
// makes two racing writers agree on one row; deciding who pays for a
// translation is the translation door's (MOTIR-8120), which calls `keep` only
// after a successful, billed result.

/** The work item a lookup or a write is about — addressed by id alone. */
export interface TranslationSubject {
  id: string;
}

/** A field's kept translation, as the store hands it back. */
export interface KeptTranslation {
  fieldRef: string;
  translatedText: string;
}

interface ResolvedTenancy {
  workItemId: string;
  workspaceId: string;
  organizationId: string;
}

function assertTargetLanguage(targetLanguage: string): asserts targetLanguage is Locale {
  if (!isLocale(targetLanguage)) throw new UnsupportedTargetLanguageError(targetLanguage);
}

async function resolveTenancy(
  subject: TranslationSubject,
  ctx: TenantReadContext,
  tx: Prisma.TransactionClient,
): Promise<ResolvedTenancy> {
  const item = await workItemRepository.findById(subject.id, tx);
  // The explicit workspace check stays even though RLS hides a foreign row:
  // under a BYPASSRLS role the row comes back (`tenantRead.ts`).
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(subject.id);
  const project = await projectRepository.findById(item.projectId, tx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new WorkItemNotFoundError(subject.id);
  }
  const workspace = await workspaceRepository.findByIdInTx(project.workspaceId, tx);
  if (!workspace) throw new WorkItemNotFoundError(subject.id);
  return {
    workItemId: item.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
  };
}

export const workItemTranslationStoreService = {
  /**
   * `{ fieldRef → translatedText }` for each of `fields` that has a kept
   * translation of its CURRENT text in `targetLanguage`, and nothing for the
   * rest. A field whose text is empty or whitespace-only is never answered.
   */
  async getKept(
    subject: TranslationSubject,
    fields: readonly TranslatableField[],
    targetLanguage: string,
    ctx: TenantReadContext,
  ): Promise<Record<string, string>> {
    assertTargetLanguage(targetLanguage);
    const hashesByFieldRef = new Map<string, string>();
    for (const field of fields) {
      if (hasTranslatableText(field.text)) {
        hashesByFieldRef.set(field.fieldRef, hashFieldText(field.text));
      }
    }
    return withWorkspaceContext(ctx, async (tx) => {
      const tenancy = await resolveTenancy(subject, ctx, tx);
      if (hashesByFieldRef.size === 0) return {};
      const rows = await workItemTranslationRepository.findCurrent(
        tenancy.workItemId,
        targetLanguage,
        hashesByFieldRef,
        tx,
      );
      const kept: Record<string, string> = {};
      for (const row of rows) kept[row.fieldRef] = row.translatedText;
      return kept;
    });
  },

  /**
   * Keep one field's translation of its CURRENT text in `targetLanguage`, and
   * remove that field's rows in that language for every other revision. When a
   * row for this exact revision already exists (another writer won), that row
   * is kept and its text returned.
   */
  async keep(
    subject: TranslationSubject,
    field: TranslatableField,
    targetLanguage: string,
    translatedText: string,
    ctx: TenantReadContext,
  ): Promise<KeptTranslation> {
    assertTargetLanguage(targetLanguage);
    if (!hasTranslatableText(field.text) || !hasTranslatableText(translatedText)) {
      throw new EmptyTranslationTextError(field.fieldRef);
    }
    const sourceHash = hashFieldText(field.text);
    return withWorkspaceContext(ctx, async (tx) => {
      const tenancy = await resolveTenancy(subject, ctx, tx);
      const row = await workItemTranslationRepository.insertIfAbsent(
        {
          organizationId: tenancy.organizationId,
          workspaceId: tenancy.workspaceId,
          workItemId: tenancy.workItemId,
          fieldRef: field.fieldRef,
          sourceHash,
          targetLanguage,
          translatedText,
        },
        tx,
      );
      await workItemTranslationRepository.deleteSuperseded(
        tenancy.workItemId,
        field.fieldRef,
        targetLanguage,
        sourceHash,
        tx,
      );
      return { fieldRef: row.fieldRef, translatedText: row.translatedText };
    });
  },
};
