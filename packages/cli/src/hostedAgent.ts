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
  enabled_providers: ['anthropic'],
  provider: {
    anthropic: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
  },
  share: 'disabled',
  autoupdate: false,
} as const;

/** The egress contract's document, as OpenCode reads it (`OPENCODE_CONFIG_CONTENT`). */
export function egressConfig(): string {
  return JSON.stringify(EGRESS_DOCUMENT);
}

/**
 * The agent's allow-listed environment: the keys above, taken from `env`, plus
 * OpenCode's configuration. Nothing else — the run credential cannot be in it.
 */
export function hostedAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {
    ...env,
    OPENCODE_CONFIG_CONTENT: egressConfig(),
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
export function hostedOpenCodeAgent(env: NodeJS.ProcessEnv = process.env): ParsedAgentCommand {
  const model = env[HOSTED_MODEL_ENV]?.trim() ?? '';
  const missing = [HOSTED_MODEL_ENV, HOSTED_GATEWAY_URL_ENV, HOSTED_RUN_KEY_ENV].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new CliError(`A hosted run is missing ${missing.join(', ')}.`, {
      hint: 'The hosted image is booted with the run model, the gateway URL and the run key.',
    });
  }
  // Only the anthropic provider is enabled (egress contract §2), and the start
  // path adds the `anthropic/` prefix to the bare gateway id (decision §7).
  if (!/^anthropic\/[A-Za-z0-9._-]+$/.test(model)) {
    throw new CliError(`${HOSTED_MODEL_ENV} must be "anthropic/<model id>", got "${model}".`);
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
      const addendum = hostedPromptAddendum();
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
