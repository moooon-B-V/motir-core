import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type {
  ReaderTranslationDTO,
  TranslationOfferDTO,
  TranslationOfferFieldDTO,
} from '@/lib/dto/workItemTranslation';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { detectLocale } from '@/lib/translation/detectLanguage';
import { classifyFields, type FieldClassification } from '@/lib/translation/needsTranslation';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { assembleFields, type DoorField } from '@/lib/translation/itemFields';
import { orgCanForWorkspace } from './organizationAccessService';
import { workItemTranslationStoreService } from './workItemTranslationStoreService';

// The page-read half of on-demand translation (Story MOTIR-7735 · Subtask
// MOTIR-8121): for the reader's interface language, which of the item's fields
// need translating and which already have a kept translation — computed per
// request from the item's CURRENT text, never stored, and with no AI call. The
// page uses it to decide whether to draw Translate; it puts no translated text
// in the page (the original is what renders until a press).

export interface TranslationOfferInput {
  workItem: WorkItemDto;
  todos: readonly WorkItemTodoDto[];
  readerLocale: Locale;
  ctx: ServiceContext;
}

/** The seam a test replaces: the store's lookup. */
export interface TranslationOfferDeps {
  getKept: (typeof workItemTranslationStoreService)['getKept'];
  canManageBilling?: (ctx: ServiceContext) => Promise<boolean>;
}

const defaultDeps: TranslationOfferDeps = {
  getKept: (...args) => workItemTranslationStoreService.getKept(...args),
  canManageBilling: (ctx) => orgCanForWorkspace(ctx.userId, ctx.workspaceId, 'manageBilling'),
};

/** The language a differing field is in: recorded, else detected, else unknown. */
function sourceLanguageOf(field: DoorField, verdict: FieldClassification): Locale | null {
  if (verdict.basis === 'recorded') {
    const primary = field.language!.trim().split(/[-_]/)[0]!.toLowerCase();
    return isLocale(primary) ? primary : null;
  }
  return verdict.basis === 'detected' ? detectLocale(field.text) : null;
}

/** One entry per field, keyed by fieldRef, with `kept` from the store's answer. */
function toOfferFields(
  fields: readonly DoorField[],
  verdicts: readonly FieldClassification[],
  kept: Readonly<Record<string, string>>,
): Record<string, TranslationOfferFieldDTO> {
  const out: Record<string, TranslationOfferFieldDTO> = {};
  fields.forEach((field, i) => {
    const verdict = verdicts[i]!;
    out[field.fieldRef] = verdict.needsTranslation
      ? {
          needsTranslation: true,
          kept: kept[field.fieldRef] !== undefined,
          sourceLanguage: sourceLanguageOf(field, verdict),
        }
      : { needsTranslation: false, kept: false, sourceLanguage: null };
  });
  return out;
}

export const workItemTranslationReadService = {
  /**
   * The reader's translation offer for one item. Calls the store ONCE, only for
   * the fields that need translating, and only when at least one does.
   */
  async getTranslationOffer(
    input: TranslationOfferInput,
    deps: TranslationOfferDeps = defaultDeps,
  ): Promise<TranslationOfferDTO> {
    const { workItem, todos, readerLocale, ctx } = input;
    const fields = assembleFields(workItem, todos);
    const verdicts = classifyFields(
      fields.map((f) => ({ id: f.fieldRef, text: f.text, language: f.language })),
      readerLocale,
    );
    const needing = fields.filter((_f, i) => verdicts[i]!.needsTranslation);
    const kept =
      needing.length > 0 ? await deps.getKept({ id: workItem.id }, needing, readerLocale, ctx) : {};
    return {
      targetLanguage: readerLocale,
      anyNeedsTranslation: needing.length > 0,
      fields: toOfferFields(fields, verdicts, kept),
    };
  },
  /**
   * The offer plus whether the no-credit message may link to adding credit
   * (MOTIR-8122). The billing question is asked only when there is something to
   * translate, so an item already in the reader's language costs no extra read.
   */
  async getReaderTranslation(
    input: TranslationOfferInput,
    deps: TranslationOfferDeps = defaultDeps,
  ): Promise<ReaderTranslationDTO> {
    const offer = await this.getTranslationOffer(input, deps);
    const canAddCredits =
      offer.anyNeedsTranslation && deps.canManageBilling
        ? await deps.canManageBilling(input.ctx)
        : false;
    return { offer, canAddCredits };
  },
};
