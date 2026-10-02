import type { ParsedAgentCommand } from './agentProfiles.js';
import { CliError } from './errors.js';
import { hostedPromptAddendum } from './hostedAttribution.js';

// THE HOSTED RUN'S AGENT — OpenCode, launched by the CLI (Story MOTIR-683 ·
// MOTIR-6559). `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1: the
// hosted container runs `motir run`, and what the bespoke entrypoint did that
// the CLI did not — launching OpenCode on the run's model through the gateway
// key, configured exactly as the egress contract says — moves here.
//
// ⚠️ ONLY THE MODEL CREDENTIAL REACHES THE AGENT. OpenCode is spawned with an
// ALLOW-LISTED environment (`HOSTED_AGENT_ENV_KEYS`) that REPLACES the CLI's:
// the run credential (`MOTIR_RUN_TOKEN`) is never in it, and the gateway key is
// there only as `MOTIR_RUN_KEY`, the one name the egress document's provider
// configuration reads (`{env:MOTIR_RUN_KEY}`). git and `gh` reach GitHub through
// `hostedGit.ts`, so no git token is in it either.

/** The env vars the hosted launcher reads. */
export const HOSTED_MODEL_ENV = 'MOTIR_MODEL';
export const HOSTED_GATEWAY_URL_ENV = 'MOTIR_GATEWAY_URL';
export const HOSTED_RUN_KEY_ENV = 'MOTIR_RUN_KEY';

/**
 * The ONLY environment the agent receives (moved from the hosted entrypoint).
 * `GIT_CONFIG_GLOBAL` / `GIT_TERMINAL_PROMPT` carry the run's git setup and
 * `PATH` its `gh` shim; `runAgent` adds the prompt, report and design paths.
 */
export const HOSTED_AGENT_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  HOSTED_GATEWAY_URL_ENV,
  HOSTED_RUN_KEY_ENV,
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_DISABLE_AUTOUPDATE',
  'OPENCODE_DISABLE_MODELS_FETCH',
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'CODEGRAPH_TELEMETRY',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
  // A hosted REPAIR's push lock (MOTIR-6929, `lockHostedRunToBranches`): the run's hooks
  // directory in the command scope. Unset in every other run, so absent from the agent's.
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
] as const;

/**
 * A prompt longer than this is attached as a file rather than passed as an
 * argument — Linux refuses a single argv string past 128 KiB (MAX_ARG_STRLEN).
 */
const MAX_ARGV_PROMPT_BYTES = 100 * 1024;

/**
 * The gateway's egress contract §2 document (`motir-gateway`
 * `docs/hosted-run-egress.md`), verbatim — MOVED here from the hosted
 * entrypoint's `opencode.egress.json`, which MOTIR-6560 deleted with the
 * entrypoint's own OpenCode launch. This is the only copy; `test/hostedAgent.test.ts`
 * pins it to the contract.
 */
export const EGRESS_DOCUMENT = {
  $schema: 'https://opencode.ai/config.json',
  enabled_providers: ['anthropic', 'deepseek', 'z-ai', 'qwen', 'moonshotai'],
  provider: {
    anthropic: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    deepseek: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    'z-ai': {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    qwen: {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    moonshotai: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
  },
  share: 'disabled',
  autoupdate: false,
} as const;

/**
 * The providers a hosted run may name in `MOTIR_MODEL` — DERIVED from the document
 * above, never a second hand-typed list (MOTIR-7208), so the CLI accepts exactly
 * what the OpenCode it launches has enabled.
 */
export const HOSTED_MODEL_PROVIDERS: readonly string[] = EGRESS_DOCUMENT.enabled_providers;

/**
 * The providers whose block the egress contract §2 calls a TEMPLATE: the run's ONE
 * model must be declared in the block at launch, because at OpenCode `1.18.32` the
 * model resolves under none of them otherwise. The rule is one sentence of the
 * contract — *a provider whose model ids the gateway catalog can list before the
 * binary's frozen snapshot does* — and it covers two cases:
 *
 * - `z-ai` and `qwen` are CUSTOM providers (not in OpenCode's bundled catalog), so
 *   a block with no `models` is dropped altogether (MOTIR-7243).
 * - `moonshotai` IS a bundled provider, but its snapshot holds only the Kimi ids
 *   known when `1.18.32` was built, and the gateway catalog refreshes daily: an id
 *   outside the snapshot fails `ProviderModelNotFoundError` unless declared, and a
 *   declared one is merged over the snapshot (observed on the released binary,
 *   MOTIR-7357). So it takes the same write.
 *
 * `anthropic` and `deepseek` are not on it: the contract leaves their models to the
 * bundled catalog. Pinned to the contract by `test/hostedAgent.test.ts`.
 */
export const LAUNCH_DECLARED_MODEL_PROVIDERS: readonly string[] = ['z-ai', 'qwen', 'moonshotai'];

/**
 * The egress contract's document, as OpenCode reads it (`OPENCODE_CONFIG_CONTENT`).
 *
 * ⚠️ For a provider in `LAUNCH_DECLARED_MODEL_PROVIDERS` the contract's document is a
 * TEMPLATE (egress contract §2): the run's ONE model is written into that provider's
 * `models` here, and nothing else is. For `anthropic` and `deepseek` — and with no
 * model — this is the static document verbatim.
 */
export function egressConfig(model?: string): string {
  const slash = model ? model.indexOf('/') : -1;
  const provider = slash > 0 ? model!.slice(0, slash) : '';
  const id = slash > 0 ? model!.slice(slash + 1) : '';
  const block = (EGRESS_DOCUMENT.provider as Record<string, object>)[provider];
  if (!block || !LAUNCH_DECLARED_MODEL_PROVIDERS.includes(provider) || !id) {
    return JSON.stringify(EGRESS_DOCUMENT);
  }
  return JSON.stringify({
    ...EGRESS_DOCUMENT,
    provider: { ...EGRESS_DOCUMENT.provider, [provider]: { ...block, models: { [id]: {} } } },
  });
}

/**
 * The agent's allow-listed environment: the keys above, taken from `env`, plus
 * OpenCode's configuration. Nothing else — the run credential cannot be in it.
 */
export function hostedAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {
    ...env,
    OPENCODE_CONFIG_CONTENT: egressConfig(env[HOSTED_MODEL_ENV]?.trim()),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
  };
  // Filter a COPY rather than build up from `{}` — the same allow-list, and a
  // shape every `ProcessEnv` declaration in the repository accepts.
  const allowed = new Set<string>(HOSTED_AGENT_ENV_KEYS);
  const out: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(out)) {
    if (!allowed.has(key) || out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * OpenCode as the hosted run's agent: `opencode run --model <provider/id> --auto`
 * with the prompt as its message, on the allow-listed environment.
 *
 * ⚠️ READ AT LAUNCH, not at import: the model and the gateway are the run's, and
 * the environment is the one `prepareHostedRun` has pointed at the run's git.
 */
export function hostedOpenCodeAgent(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    /**
     * What the agent is told on top of the server's prompt. Defaults to the BUILD run's
     * addendum (git is the App, how its pull requests end). A REVIEW run (MOTIR-6824)
     * passes its own: it opens no pull request and pushes nothing, so the build
     * addendum would tell it the opposite of its rules.
     */
    addendum?: () => string;
  } = {},
): ParsedAgentCommand {
  const model = env[HOSTED_MODEL_ENV]?.trim() ?? '';
  const missing = [HOSTED_MODEL_ENV, HOSTED_GATEWAY_URL_ENV, HOSTED_RUN_KEY_ENV].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new CliError(`A hosted run is missing ${missing.join(', ')}.`, {
      hint: 'The hosted image is booted with the run model, the gateway URL and the run key.',
    });
  }
  // `<provider>/<bare id>`, the provider one the egress document enables (egress
  // contract §2); the start path builds it from the offered entry (decision §7).
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : '';
  const id = slash > 0 ? model.slice(slash + 1) : '';
  if (!HOSTED_MODEL_PROVIDERS.includes(provider) || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new CliError(
      `${HOSTED_MODEL_ENV} must be "<provider>/<model id>" with provider one of ${HOSTED_MODEL_PROVIDERS.join(', ')}, got "${model}".`,
    );
  }
  const args = ['run', '--model', model, '--auto'];
  return {
    command: `opencode ${args.join(' ')}`,
    binary: 'opencode',
    args,
    env: hostedAgentEnv(env),
    // OpenCode appends a piped stdin to its message — the prompt goes on argv only.
    promptOnStdin: false,
    promptArgs: (prompt, promptFile) => {
      const addendum = (opts.addendum ?? hostedPromptAddendum)();
      if (Buffer.byteLength(prompt) > MAX_ARGV_PROMPT_BYTES) {
        return [
          '--file',
          promptFile,
          `Carry out the task described in the attached file.\n${addendum}`,
        ];
      }
      return [`${prompt}\n${addendum}`];
    },
  };
}
