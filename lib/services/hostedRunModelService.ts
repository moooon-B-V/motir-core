import 'server-only';

import { getAgentModels, type AgentModel } from '@/lib/ai/motirAiClient';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';

// THE ONE ANSWER TO "WHICH MODELS MAY A HOSTED RUN USE?" (MOTIR-6483;
// `docs/decisions/hosted-agent-run.md` §7).
//
// The Run hosted picker reads it through `GET /api/hosted-runs/models`, and the
// start path (MOTIR-690) calls `assertOffered` before it opens, mints or boots
// anything. Both go through here, so a model can never appear in the picker and
// then be refused by a second, differently-built check — or the reverse.
//
// ⚠️ THE LIST IS motir-ai's, AND NOTHING HERE KEEPS A COPY. The planning picker's
// hard-coded copy (`lib/projectAiSettings/plannerModels.ts`) is the counter-
// example §7 names: it went stale. So there is no constant list and NO CACHE —
// the start path must refuse a model withdrawn a minute ago, and a list stale
// for even one TTL is exactly the window that would let it through.
//
// ⚠️ "motir-ai IS DOWN" NEVER READS AS "NO MODELS EXIST". The client returns a
// typed `unavailable` for every failure, and it is carried through here as its
// own state, never flattened into an empty list.

/** What the picker is handed: the offered models and the preselected one. */
export type OfferedModels =
  | { state: 'ok'; models: AgentModel[]; default: string | null }
  | { state: 'unavailable' };

/**
 * The provider prefix OpenCode's `--model` flag needs (§7, *one id, two
 * spellings*). The gateway's allow-list, `DispatchRun.model` and
 * `implementationModel` all hold the BARE id; putting the prefixed form on the
 * key's allow-list gets every model call refused with 403.
 */
const OPENCODE_PROVIDER_PREFIX = 'anthropic/';

/**
 * The bare gateway id → the id OpenCode is started with. THE ONE PLACE the
 * `anthropic/` prefix is added — `tests/hostedRuns/openCodeModelPrefix.test.ts`
 * holds every other module to never writing it.
 */
export function toOpenCodeModel(id: string): string {
  return `${OPENCODE_PROVIDER_PREFIX}${id}`;
}

export const hostedRunModelService = {
  /** The offered list, exactly as motir-ai answered it, or `unavailable`. */
  async listOfferedModels(): Promise<OfferedModels> {
    const read = await getAgentModels();
    if (read.state === 'unavailable') return { state: 'unavailable' };
    return { state: 'ok', models: read.models, default: read.default };
  },

  /**
   * Resolves when `model` (a bare gateway id) is on the offered list right now.
   * Throws `HostedModelNotOfferedError` when it is not, and
   * `HostedModelsUnavailableError` when motir-ai cannot answer — an unanswered
   * question is never an acceptance.
   */
  async assertOffered(model: string): Promise<void> {
    const read = await getAgentModels();
    if (read.state === 'unavailable') throw new HostedModelsUnavailableError(read.reason);
    if (!read.models.some((m) => m.id === model)) throw new HostedModelNotOfferedError(model);
  },

  toOpenCodeModel,
};
