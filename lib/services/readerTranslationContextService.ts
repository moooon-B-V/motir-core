import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { AutoTranslateContextDTO, AutoTranslateCreditState } from '@/lib/dto/autoTranslate';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';
import { isAiPaywallApplicable } from '@/lib/billing/aiEntitlement';
import type { Locale } from '@/lib/i18n/locales';
import {
  classifyTitles,
  type TitleCandidate,
  type TitleVerdict,
} from '@/lib/translation/titleVerdicts';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { billingService } from './billingService';
import { orgCanForWorkspace } from './organizationAccessService';
import { workItemTranslationReadService } from './workItemTranslationReadService';

// The reader's translation context (Story MOTIR-7738 · Subtask MOTIR-8828): one
// resolved answer to "does auto-translate apply to this reader on this project,
// into which language, may it be paid for, and which fields are already in the
// reader's language". It DECIDES and CARRIES — it translates nothing, renders
// nothing, bills nothing, writes no kept translation and calls no model.
//
// The locale is an INPUT (as on `TranslationOfferInput`), never read from a
// request, so the same resolver serves a server component, a route and a test.

/** The reader: a member's service context, or a Visitor's read context. */
export type TranslationReader = ServiceContext | VisitorReadContext;

function isVisitor(reader: TranslationReader): reader is VisitorReadContext {
  return 'kind' in reader && reader.kind === 'visitor';
}

/** The seams a test replaces. */
export interface ReaderTranslationContextDeps {
  /** The organisation's AI entitlement — crosses to motir-ai, so asked sparingly. */
  getAiAccess: (ctx: ServiceContext) => Promise<AiAccessDTO>;
  /** The ONE predicate the shipped Translate control's link already uses. */
  canManageBilling: (ctx: ServiceContext) => Promise<boolean>;
  /** The shipped per-field offer, for the item shape. */
  getReaderTranslation: (typeof workItemTranslationReadService)['getReaderTranslation'];
}

const defaultDeps: ReaderTranslationContextDeps = {
  getAiAccess: (ctx) =>
    billingService.getAiAccessForContext({
      actorUserId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
  canManageBilling: (ctx) => orgCanForWorkspace(ctx.userId, ctx.workspaceId, 'manageBilling'),
  getReaderTranslation: (...args) => workItemTranslationReadService.getReaderTranslation(...args),
};

interface ContextInput {
  project: Pick<ProjectDTO, 'autoTranslateWorkContent'>;
  reader: TranslationReader;
  readerLocale: Locale;
}

export interface ItemContextInput extends ContextInput {
  workItem: WorkItemDto;
  todos: readonly WorkItemTodoDto[];
}

export interface TitlesContextInput extends ContextInput {
  titles: readonly TitleCandidate[];
}

export interface ItemTranslationContext {
  context: AutoTranslateContextDTO;
  /** The SAME offer `workItemTranslationReadService.getReaderTranslation` produces. */
  offer: TranslationOfferDTO;
}

export interface TitlesTranslationContext {
  context: AutoTranslateContextDTO;
  /** Total over the titles handed in; EMPTY when the switch is off. */
  verdicts: Record<string, TitleVerdict>;
}

/**
 * `no_credit` iff the paywall applies AND the organisation is on no paid plan or
 * has no balance. The applicability guard is load-bearing: `notApplicableAiAccess()`
 * is an inert sentinel for a self-host build and for a `meta` organisation, and
 * reading `hasPaidAiPlan` / `balance` off it would answer a question never asked.
 */
function creditOf(access: AiAccessDTO): AutoTranslateCreditState {
  return isAiPaywallApplicable(access) && (!access.hasPaidAiPlan || access.balance <= 0)
    ? 'no_credit'
    : 'ok';
}

function context(
  input: ContextInput,
  credit: AutoTranslateCreditState,
  canAddCredit: boolean,
): AutoTranslateContextDTO {
  return {
    autoTranslateWorkContent: input.project.autoTranslateWorkContent,
    targetLanguage: input.readerLocale,
    credit,
    canAddCredit,
  };
}

export const readerTranslationContextService = {
  /**
   * The context for a whole surface, from the already-resolved project: no
   * project query, no entitlement read. A Visitor gets `null`. The credit half
   * is resolved by `resolveForItem` / `resolveForTitles`, once something is due.
   */
  resolveContext(input: ContextInput): AutoTranslateContextDTO | null {
    if (isVisitor(input.reader)) return null;
    return context(input, 'ok', false);
  },

  /** The context layered over the shipped per-field offer for one work item. */
  async resolveForItem(
    input: ItemContextInput,
    deps: ReaderTranslationContextDeps = defaultDeps,
  ): Promise<ItemTranslationContext | null> {
    const { reader, readerLocale, workItem, todos } = input;
    if (isVisitor(reader)) return null;
    const { offer, canAddCredits } = await deps.getReaderTranslation({
      workItem,
      todos,
      readerLocale,
      ctx: reader,
    });
    if (!input.project.autoTranslateWorkContent || !offer.anyNeedsTranslation) {
      return { context: context(input, 'ok', false), offer };
    }
    const credit = creditOf(await deps.getAiAccess(reader));
    return { context: context(input, credit, credit === 'no_credit' && canAddCredits), offer };
  },

  /**
   * The context and a verdict per title for a bounded set, in at most ONE
   * entitlement call (none when the switch is off or nothing needs translating).
   * No kept-translation lookup: the many-titles door serves kept copies and is
   * the single authority on spending.
   */
  async resolveForTitles(
    input: TitlesContextInput,
    deps: ReaderTranslationContextDeps = defaultDeps,
  ): Promise<TitlesTranslationContext | null> {
    const { reader, readerLocale, titles } = input;
    if (isVisitor(reader)) return null;
    if (!input.project.autoTranslateWorkContent) {
      return { context: context(input, 'ok', false), verdicts: {} };
    }
    const verdicts = classifyTitles(titles, readerLocale);
    if (!Object.values(verdicts).some((v) => v.needsTranslation)) {
      return { context: context(input, 'ok', false), verdicts };
    }
    const credit = creditOf(await deps.getAiAccess(reader));
    const canAddCredit = credit === 'no_credit' ? await deps.canManageBilling(reader) : false;
    return { context: context(input, credit, canAddCredit), verdicts };
  },
};
