import { basename, join } from 'node:path';

// The per-agent PROFILE TABLE — what the BYOK preflight knows about the coding
// agents Motir supports first-class: the binary a profile runs, where that
// agent's CLI is installed FROM (so a missing binary can name its install
// source), and WHERE the agent keeps its own credential (so `motir doctor` can
// assert the credential is PRESENT without ever reading it).
//
// `sandbox/README.md`'s profile matrix is the VERIFIED SOURCE for both columns
// this table restates — the binary each agent installs as, and where that agent
// keeps its credential. Every value here was re-checked against that matrix (and
// against `sandbox/install-agent.sh`, which does the installing);
// `test/sandbox.test.ts` pins the two together so they cannot drift apart again.
// A profile whose credential the matrix does not pin is left UNKNOWN rather than
// guessed, because an unverified path would make `doctor` FAIL a correctly-
// configured machine. (Same reason 7.9.7b treats the agents' auto-approve flags
// as verify-at-build rather than asserted-from-memory.)
//
// The matrix pins a MOUNT, which is not always proof of AUTH — the two diverge
// wherever the mounted location also exists on a machine that never signed in.
// Where they diverge the profile tests the narrower thing (opencode's `auth.json`
// rather than its config dir) or declines to test a path at all (cursor, whose
// matrix path is also the install tree), with the reason written beside the
// entry. **A false PASS is worse than a false FAIL**: it tells the user their
// unattended run is ready when it will stop at a sign-in prompt.
//
// `binaries` is a LOOKUP KEY LIST, not a claim: the binary actually probed always
// comes from the user's own agent command (`--agent` / `MOTIR_AGENT` / config),
// and a name that matches nothing here simply falls through to the tier-3
// generic path. Motir is agent-agnostic — an unlisted agent is supported, just
// not enriched with a remediation hint.

/**
 * The directories a credential path is resolved against. Passed as one object
 * so a profile names the dir it means (`xdgDataHome`) instead of depending on
 * argument order — the shape the opencode entry got wrong when the data dir and
 * the config dir were conflated.
 */
export interface CredentialDirs {
  /** The user's home directory. */
  home: string;
  /** `XDG_CONFIG_HOME`, or `~/.config`. Configuration — not always credentials. */
  xdgConfigHome: string;
  /** `XDG_DATA_HOME`, or `~/.local/share`. Where opencode + cursor keep auth. */
  xdgDataHome: string;
}

export interface AgentProfile {
  /** Profile id — also the sandbox `AGENT=` selector and the docs' name for it. */
  id: string;
  /** Human label used in report lines. */
  label: string;
  /** 1 = pinned by the sandbox matrix; 2 = also-supported. */
  tier: 1 | 2;
  /**
   * Every binary name this profile is matched by, canonical one FIRST. A list
   * rather than a single name because an agent's own installer can link several
   * (Cursor links both `agent` and `cursor-agent`), and because a user may have
   * aliased the profile id — matching only one name silently drops such a user
   * onto the tier-3 generic path, with no remediation hint.
   */
  binaries: readonly string[];
  /** Where the agent's own CLI comes from (the missing-binary remediation). */
  installSource: string;
  /**
   * Credential locations to test for PRESENCE — a directory the agent creates
   * on sign-in, or the credential FILE itself where the directory alone would
   * not prove authentication.
   */
  credentialPaths: (dirs: CredentialDirs) => string[];
  /**
   * Env vars whose PRESENCE also satisfies the credential check. Only ever
   * passed to a presence predicate — the VALUE is never read (see doctor.ts).
   */
  credentialEnv: string[];
  /**
   * False when this profile has nowhere it can honestly look — no pinned path
   * and no env var. It is NOT "the matrix has no row": a matrix mount that
   * proves installation rather than authentication buys nothing.
   */
  credentialKnown: boolean;
  /** How the user provides the credential (the missing-credential remediation). */
  credentialHint: string;
  /**
   * The `codegraph install --target <id>` id that wires the code-graph MCP
   * server for this agent, or null when codegraph has no target for it
   * (7.9.7d). Read off `codegraph install --print-config` against the version
   * the sandbox ships — never assumed: the known set is
   * `claude, cursor, codex, opencode, hermes, gemini, antigravity, kiro`, which
   * covers five of the eight profiles here. A profile with no target is left
   * null rather than pointed at a near-miss id, for the same reason
   * `credentialKnown` is left false: a wrong id would claim a wiring the image
   * does not have.
   */
  codegraphTarget: string | null;
  /**
   * Where that wiring LANDS inside the sandbox image, and how it is kept clear
   * of the profile's own read-only credential mount (7.9.7f). null when the
   * profile has no codegraph target at all.
   */
  codegraphConfig: CodegraphConfigPlacement | null;
}

/**
 * The image-owned config home the sandbox redirects a SHADOWED agent to —
 * `<home>/.motir-sandbox/agent-config`. It is deliberately OUTSIDE every
 * credential mount (all of which are `~/.<agent>`-shaped or XDG paths), so a
 * config file written here can never be masked by a `:ro` bind mount.
 *
 * `sandbox/install-agent.sh` and `sandbox/entrypoint.sh` carry the same literal
 * path; `test/sandbox.test.ts` pins the three together.
 */
export const sandboxAgentConfigHome = (home: string): string =>
  join(home, '.motir-sandbox', 'agent-config');

/**
 * Where a profile's codegraph MCP wiring is written, split by the ROLE each
 * file plays — because the two roles fail differently when a read-only mount
 * shadows them. Every path below was read off the REAL `codegraph install`
 * (v1.5.0) writing into a scratch HOME, not off its documentation.
 */
export interface CodegraphConfigPlacement {
  /**
   * The file the agent reads the codegraph MCP SERVER from. Shadowing THIS is
   * the total failure: the agent has no code-graph tools at all. It must never
   * resolve inside one of the profile's read-only mounts.
   */
  mcpServers: (dirs: CredentialDirs) => string;
  /**
   * The separate file holding the auto-allow permission list `--yes` writes,
   * for an agent that keeps it apart from the server list. null when the server
   * file carries the permissions too (codex's `config.toml`, opencode's
   * `opencode.jsonc`) — verified, not assumed.
   */
  autoAllow: ((dirs: CredentialDirs) => string) | null;
  /**
   * The env var the sandbox EXPORTS so the agent reads `mcpServers` from the
   * image-owned home instead of its default location, with the reason. null
   * when the default is already clear of every mount this profile takes.
   */
  redirect: { env: string; why: string } | null;
  /**
   * Set ONLY when `autoAllow` still resolves inside a read-only mount: the
   * declared, NARROWER gap — the agent HAS the tools but its auto-allow list is
   * the host's, so an unattended run stops to ask before calling them. Carries
   * the tracking reference so the condition is visible rather than silent.
   */
  knownAutoAllowGap: string | null;
}

/**
 * Tier-1: the four profiles the sandbox matrix makes first-class. Tier-2:
 * also-supported agents. Every `binaries` and `credentialPaths` value below is
 * the sandbox matrix's, narrowed only where a mount is not proof of auth.
 */
export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    tier: 1,
    binaries: ['claude'],
    installSource: 'npm install -g @anthropic-ai/claude-code',
    credentialPaths: ({ home }) => [join(home, '.claude')],
    credentialEnv: ['ANTHROPIC_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `claude` once to sign in, or set ANTHROPIC_API_KEY.',
    codegraphTarget: 'claude',
    codegraphConfig: {
      // Claude Code reads its MCP servers from <CLAUDE_CONFIG_DIR>/.claude.json
      // — by default ~/.claude/.claude.json, INSIDE the `:ro` mount. (The
      // ~/.claude.json codegraph writes is a legacy path the shipped 2.x CLI no
      // longer reads at all — verified, which is why this profile had no tools
      // rather than merely no permission list.) The entrypoint redirects
      // CLAUDE_CONFIG_DIR to the image-owned home, seeds it from the mount and
      // merges codegraph's stanza into the copy.
      mcpServers: ({ home }) => join(sandboxAgentConfigHome(home), '.claude', '.claude.json'),
      // The auto-allow list is a SEPARATE file from the server list here, and
      // it moves with the same redirect.
      autoAllow: ({ home }) => join(sandboxAgentConfigHome(home), '.claude', 'settings.json'),
      redirect: {
        env: 'CLAUDE_CONFIG_DIR',
        why: 'CLAUDE_CONFIG_DIR governs the state file, settings.json, CLAUDE.md AND .credentials.json, so the redirected dir is seeded from the read-only mount before codegraph merges into it.',
      },
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    tier: 1,
    binaries: ['codex'],
    installSource: 'npm install -g @openai/codex',
    credentialPaths: ({ home }) => [join(home, '.codex')],
    credentialEnv: ['OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `codex` once to sign in, or set OPENAI_API_KEY.',
    codegraphTarget: 'codex',
    codegraphConfig: {
      // codegraph's default target is ~/.codex/config.toml — INSIDE the `:ro`
      // mount, so the host copy shadowed it and the agent saw no tools at all.
      // The entrypoint redirects CODEX_HOME to the image-owned home, seeds it
      // from the mount and lets codegraph merge its stanza into the copy.
      mcpServers: ({ home }) => join(sandboxAgentConfigHome(home), '.codex', 'config.toml'),
      // config.toml carries the server AND its trust/approval settings.
      autoAllow: null,
      redirect: {
        env: 'CODEX_HOME',
        why: 'CODEX_HOME governs config.toml AND auth.json, so the redirected home is seeded from the read-only mount before codegraph merges into it.',
      },
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 1,
    binaries: ['opencode'],
    installSource: 'npm, or the OpenCode install script (opencode.ai)',
    // OpenCode SPLITS the two: `~/.config/opencode` holds configuration, while
    // the credential is `auth.json` under the XDG DATA home — which is why the
    // sandbox mounts both dirs. Testing the config dir passed on any machine
    // that had ever run opencode, signed in or not; the check is the auth FILE.
    credentialPaths: ({ xdgDataHome }) => [join(xdgDataHome, 'opencode', 'auth.json')],
    credentialEnv: [],
    credentialKnown: true,
    credentialHint: 'Run `opencode auth login` to sign in — it writes auth.json.',
    codegraphTarget: 'opencode',
    codegraphConfig: {
      // codegraph's default target is ~/.config/opencode/opencode.jsonc —
      // INSIDE the `:ro` config mount. OPENCODE_CONFIG is MERGED on top of the
      // global config rather than replacing it (verified), so pointing it at the
      // image-owned copy adds the codegraph stanza while the host's own config
      // keeps applying, and the credential (XDG data dir) is untouched.
      mcpServers: ({ home }) =>
        join(sandboxAgentConfigHome(home), '.config', 'opencode', 'opencode.jsonc'),
      autoAllow: null,
      redirect: {
        env: 'OPENCODE_CONFIG',
        why: 'OPENCODE_CONFIG merges over the global config, so no credential is copied and the host config still applies.',
      },
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'kimi',
    label: 'Kimi Code CLI',
    tier: 1,
    binaries: ['kimi'],
    installSource: 'npm (@moonshot-ai/kimi-code) — needs Node ≥ 22.19',
    credentialPaths: ({ home }) => [join(home, '.kimi-code')],
    credentialEnv: [],
    credentialKnown: true,
    credentialHint: 'Run `kimi` once to sign in — it writes ~/.kimi-code.',
    codegraphTarget: null,
    codegraphConfig: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    tier: 2,
    // The installer links `agy`, not `antigravity`; the profile id is kept as a
    // tolerated alias for anyone who aliased it that way.
    binaries: ['agy', 'antigravity'],
    installSource: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // `agy` keeps its token in the OS KEYRING, with no documented portable
    // file — the one profile with genuinely nowhere to look (the sandbox
    // mounts no credential for it either).
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Sign in with `agy` (its token lives in the OS keyring, not a file).',
    codegraphTarget: 'antigravity',
    codegraphConfig: {
      // This profile mounts NO credential directory at all, so nothing can
      // shadow the wiring.
      mcpServers: ({ home }) => join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      autoAllow: null,
      redirect: null,
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    tier: 2,
    // The installer symlinks the executable as `agent`, keeping `cursor-agent`
    // as the legacy alias — `cursor` is neither, and matched nothing until the
    // list arrived. It stays last so a user who aliased it keeps a profile.
    binaries: ['agent', 'cursor-agent', 'cursor'],
    installSource: 'curl https://cursor.com/install -fsS | bash',
    // The matrix's `~/.local/share/cursor-agent` mount is also where the
    // installer unpacks the CLI itself, so its presence proves an INSTALL, not
    // a sign-in. The API key is the one unambiguous signal, so it is the only
    // one tested.
    credentialPaths: () => [],
    credentialEnv: ['CURSOR_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `cursor-agent login` to sign in, or set CURSOR_API_KEY.',
    codegraphTarget: 'cursor',
    codegraphConfig: {
      // Cursor's credential mount is ~/.local/share/cursor-agent, which does not
      // contain ~/.cursor — the wiring is clear of it without a redirect.
      mcpServers: ({ home }) => join(home, '.cursor', 'mcp.json'),
      autoAllow: null,
      redirect: null,
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'aider',
    label: 'Aider',
    tier: 2,
    binaries: ['aider'],
    installSource: 'pip (Python) — PyPI `aider-chat`',
    // Aider's credential IS the model key it reads from the environment. Its
    // `~/.aider.conf.yml` is configuration, and the sandbox asks the user to
    // create it (even empty) so docker can bind it — so its presence would
    // prove nothing at all.
    credentialPaths: () => [],
    credentialEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Give Aider a model key: set ANTHROPIC_API_KEY or OPENAI_API_KEY.',
    codegraphTarget: null,
    codegraphConfig: null,
  },
  {
    id: 'goose',
    label: 'Goose',
    tier: 2,
    binaries: ['goose'],
    installSource: 'the Goose installer (Block)',
    // Goose stores provider secrets in the OS KEYRING by default and only falls
    // back to a file under `~/.config/goose` when the keyring is disabled (as
    // the sandbox does). Neither state is testable from outside: an existing
    // config dir need not hold a key, and a keyring-backed key leaves no file.
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Run `goose configure` to store a provider key.',
    codegraphTarget: null,
    codegraphConfig: null,
  },
];

/** The parsed form of an agent command string: the binary plus its flags. */
export interface ParsedAgentCommand {
  /** The command as given (binary + flags). */
  command: string;
  /** The executable to look for on PATH — the first whitespace-separated token. */
  binary: string;
  /** The remaining tokens (e.g. `--dangerously-skip-permissions`). */
  args: string[];
}

/**
 * Split an agent command (`claude --dangerously-skip-permissions`) into the
 * binary to probe and its flags. The tier-3 escape hatch passes a full command,
 * so the binary is always the FIRST token — never the whole string.
 * Returns null for an empty/blank command.
 */
export function parseAgentCommand(command: string | undefined): ParsedAgentCommand | null {
  const trimmed = (command ?? '').trim();
  if (!trimmed) return null;
  // Split at the FIRST whitespace rather than destructuring the split array:
  // the binary is then a string by construction, with no unreachable
  // "empty first token" branch to carry.
  const boundary = trimmed.search(/\s/);
  if (boundary === -1) return { command: trimmed, binary: trimmed, args: [] };
  return {
    command: trimmed,
    binary: trimmed.slice(0, boundary),
    args: trimmed
      .slice(boundary + 1)
      .trim()
      .split(/\s+/),
  };
}

/**
 * Find the profile for a binary, matching ANY of its names (`agent` resolves
 * Cursor just as `cursor-agent` does). Matches on the basename (so an absolute
 * path like `/usr/local/bin/claude` still resolves), case-insensitively,
 * ignoring a Windows `.exe`/`.cmd` suffix. An unmatched binary is the tier-3
 * case → null.
 */
export function findAgentProfile(binary: string): AgentProfile | null {
  const name = basename(binary)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  return AGENT_PROFILES.find((p) => p.binaries.includes(name)) ?? null;
}

/** Every profile id, for help text / docs (`claude, codex, …`). */
export function agentProfileIds(): string[] {
  return AGENT_PROFILES.map((p) => p.id);
}

/**
 * The profiles whose agent the sandbox image wires the code-graph MCP server
 * into at build time (7.9.7d) — i.e. those codegraph has an install target for.
 * The sandbox suite drives its per-profile guards off this, so a profile that
 * gains (or loses) a codegraph target cannot leave the image's install seam
 * behind.
 */
export function codegraphWiredProfiles(): { id: string; target: string }[] {
  return AGENT_PROFILES.filter(
    (p): p is AgentProfile & { codegraphTarget: string } => p.codegraphTarget !== null,
  ).map((p) => ({ id: p.id, target: p.codegraphTarget }));
}
