import 'server-only';

import {
  getAgentModels,
  type AgentModel,
  type AgentModelDefaultsByDifficulty,
} from '@/lib/ai/motirAiClient';
import {
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedNoModelOfferedError,
} from '@/lib/hostedRuns/errors';

// THE ONE ANSWER TO "WHICH MODELS MAY A HOSTED RUN USE?" (MOTIR-6483;
// `docs/decisions/hosted-agent-run.md` §7).
//
// The Run hosted picker reads it through `GET /api/hosted-runs/models`, and the
// start path (MOTIR-690) calls `assertOffered` before it opens, mints or boots
// anything. Both go through here, so a model can never appear in the picker and
// then be refused by a second, differently-built check — or the reverse.
//
// ⚠️ THE LIST IS motir-ai's, AND NOTHING HERE KEEPS A COPY. A hard-coded copy is
// the counter-example §7 names: the retired project planning picker kept one, and
// it went stale (it was removed with the setting, MOTIR-7228). So there is no constant list and NO CACHE —
// the start path must refuse a model withdrawn a minute ago, and a list stale
// for even one TTL is exactly the window that would let it through.
//
// ⚠️ "motir-ai IS DOWN" NEVER READS AS "NO MODELS EXIST". The client returns a
// typed `unavailable` for every failure, and it is carried through here as its
// own state, never flattened into an empty list.

/** What the picker is handed: the offered models and the preselected one. */
export type OfferedModels =
  | {
      state: 'ok';
      models: AgentModel[];
      default: string | null;
      /** motir-ai's platform default per difficulty level (MOTIR-6993). */
      defaultsByDifficulty: AgentModelDefaultsByDifficulty;
    }
  | { state: 'unavailable' };

/**
 * An offered model → the id OpenCode is started with: `<provider>/<bare id>`
 * (`docs/decisions/hosted-agent-run.md` §7, *one id, two spellings*, as amended
 * by MOTIR-7206). The provider comes from motir-ai's offered ENTRY, never from
 * parsing the id and never from a list kept here.
 *
 * THE ONE PLACE a provider prefix is written — `tests/hostedRuns/openCodeModelPrefix.test.ts`
 * holds every other module to never writing one. The gateway's allow-list,
 * `DispatchRun.model` and `implementationModel` all hold the BARE id; putting the
 * prefixed form on the key's allow-list gets every model call refused with 403.
 */
export function toOpenCodeModel(model: Pick<AgentModel, 'id' | 'provider'>): string {
  return `${model.provider}/${model.id}`;
}

export const hostedRunModelService = {
  /** The offered list, exactly as motir-ai answered it, or `unavailable`. */
  async listOfferedModels(): Promise<OfferedModels> {
    const read = await getAgentModels();
    if (read.state === 'unavailable') return { state: 'unavailable' };
    return {
      state: 'ok',
      models: read.models,
      default: read.default,
      defaultsByDifficulty: read.defaultsByDifficulty,
    };
  },

  /**
   * Resolves to the OFFERED ENTRY when `model` (a bare gateway id) is on the
   * offered list right now, so the start path has its provider without a second
   * read of motir-ai. Throws `HostedModelNotOfferedError` when it is not, and
   * `HostedModelsUnavailableError` when motir-ai cannot answer — an unanswered
   * question is never an acceptance.
   */
  async assertOffered(model: string): Promise<AgentModel> {
    const read = await getAgentModels();
    if (read.state === 'unavailable') throw new HostedModelsUnavailableError(read.reason);
    const offered = read.models.find((m) => m.id === model);
    if (!offered) throw new HostedModelNotOfferedError(model);
    return offered;
  },

  /**
   * The model a run with NOBODY TO CHOOSE takes — a REVIEW run (MOTIR-6820;
   * `hosted-agent-run.md` §7's pointer): the list's default, else the first model offered.
   * Resolves to the offered ENTRY, so its provider travels with it (MOTIR-7208).
   * Throws `HostedModelsUnavailableError` when motir-ai cannot answer, and
   * `HostedNoModelOfferedError` when it answers an empty list — either is a review that
   * could not run, reason _no model_.
   */
  async defaultOffered(): Promise<AgentModel> {
    const read = await getAgentModels();
    if (read.state === 'unavailable') throw new HostedModelsUnavailableError(read.reason);
    const chosen =
      (read.default ? read.models.find((m) => m.id === read.default) : undefined) ?? read.models[0];
    if (!chosen) throw new HostedNoModelOfferedError();
    return chosen;
  },

  toOpenCodeModel,
};
