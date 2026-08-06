import { AGENT_PROFILES } from '../../packages/cli/src/agentProfiles';
import type { GuideBlock } from '@/lib/apiDocs/guide';

// The agent sandbox setup guide, AS DATA (Story MOTIR-2268 · Subtask
// MOTIR-2271 · design `design/agent-sandbox/`).
//
// ── Why data, and why the table is DERIVED ──────────────────────────────────
// Same argument as `guide.ts`, one level sharper. This page's most likely
// failure is not being wrong the day it ships — it is being right that day and
// wrong three months later. That has already happened twice to this exact
// artifact: the published image was PRIVATE while the docs told everyone to
// pull it (MOTIR-2010), and it was later eleven CLI commits stale while the docs
// described newer behaviour (MOTIR-2131). Both were found by a person.
//
// So the profile table is not typed here. It is DERIVED from `AGENT_PROFILES`,
// the CLI's own record, at build time — a profile added there appears here with
// no edit to this file, and a profile that loses its mount cannot keep one in
// the published table.
//
// ── The cross-package import ────────────────────────────────────────────────
// ADR `public-api-conventions.md` Amendment 9 Q3 permits exactly one module
// under `app/` or `lib/` to import from `packages/cli/**`, and this is it. Three
// invariants make that safe, all asserted by the story's vitest gate:
//
//   1. this file is the ONLY such importer;
//   2. `agentProfiles.ts` imports nothing but `node:` builtins, so the CLI's
//      dependency graph cannot arrive here through a documentation page;
//   3. what this module EXPORTS is plain serializable data — no functions, no
//      `node:path` values — so a page may hand a row to a client component.
//
// The `@/*` alias is rooted at the app and cannot express a path outside it, so
// the relative climb is the honest spelling and is greppable as the one seam.
//
// ── English, per ADR Amendment 4 Q4 ─────────────────────────────────────────
// Long-form documentation prose is localized in principle and lives here rather
// than in `messages/*.json` for the reason `guide.ts` records: a catalog entry
// per paragraph makes a document unreadable to edit and puts shell commands
// inside a localization file. The page CHROME is localized in the catalogs.

/** The published image, without a tag. Tags are per profile. */
export const SANDBOX_IMAGE = 'ghcr.io/moooon-b-v/motir-sandbox';

/** The agent-less tag — an IMAGE, not a profile, and drawn beside the table. */
export const SANDBOX_BASE_TAG = 'base';

/** The container name the guide tells the reader to use, so step 2 and the
 *  come-back-to-it line cannot disagree about it. */
export const SANDBOX_CONTAINER_NAME = 'motir-sandbox';

/**
 * One row of the profile table, flattened for rendering.
 *
 * Every field is READ from `AGENT_PROFILES`; none is authored here. `mounts` is
 * `sandboxMounts` — what the image BINDS — and deliberately not
 * `credentialPaths`, which is `motir doctor`'s probe and diverges from the mount
 * on four of the eight profiles (Amendment 9 Q3).
 */
export interface SandboxProfileRow {
  id: string;
  label: string;
  tier: 1 | 2;
  /** The canonical binary, which is `binaries[0]` by that field's own contract. */
  binary: string;
  installSource: string;
  /** `~`-relative, in mount order. Empty for a profile that mounts nothing. */
  mounts: readonly string[];
}

/**
 * The profile table, derived. Source order is preserved because
 * `AGENT_PROFILES` is already ordered tier-1-first, which is the order a reader
 * wants — re-sorting here would be a second opinion about someone else's list.
 */
export function sandboxProfileRows(): SandboxProfileRow[] {
  return AGENT_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    tier: profile.tier,
    binary: profile.binaries[0] ?? profile.id,
    installSource: profile.installSource,
    mounts: [...profile.sandboxMounts],
  }));
}

/** The `docker run` for one profile, as the page prints it filled in. */
export function sandboxRunCommand(row: SandboxProfileRow): string {
  const mounts = row.mounts.map(
    (mount) =>
      `  -v "$HOME/${mount.replace(/^~\//, '')}:/home/node/${mount.replace(/^~\//, '')}:ro" \\`,
  );
  return [
    `docker run -it --name ${SANDBOX_CONTAINER_NAME} \\`,
    '  -v "$PWD:/workspace" \\',
    ...mounts,
    `  ${SANDBOX_IMAGE}:${row.id}`,
  ].join('\n');
}

/** One numbered step of the setup. */
export interface SandboxStep {
  id: string;
  title: string;
  /**
   * Commands this step tells the reader to run INSIDE the container, in the
   * form the truth test checks against the CLI's registered command list — so
   * the page cannot instruct a command that does not exist.
   */
  cliCommands?: string[];
  /** `true` when the step renders the derived profile table. */
  rendersProfileTable?: boolean;
  /** `true` when the step renders the `docker run`. */
  rendersRunCommand?: boolean;
  blocks: GuideBlock[];
}

/** The two context sections above the numbered steps. */
export const SANDBOX_INTRO: readonly SandboxStep[] = [
  {
    id: 'what-it-confines',
    title: 'What it confines — and what it does not',
    blocks: [
      {
        kind: 'table',
        columns: ['Surface', ''],
        rows: [
          [
            '`Filesystem`',
            '**Confined.** The only host surfaces inside the container are a writable `/workspace` and your agent’s own credential, mounted read-only. No docker socket, no other host bind.',
          ],
          [
            '`Network`',
            '**Open, by design.** Every agent needs its provider API, and every dispatched item needs git remotes. This image confines the filesystem blast radius, not egress — reach for docker’s own `--network` controls if your threat model needs more.',
          ],
          [
            '`Privileges`',
            'Runs as the unprivileged `node` user (uid 1000), so files written into the mount stay owned by you rather than by root.',
          ],
        ],
      },
    ],
  },
  {
    id: 'before-you-start',
    title: 'Before you start',
    blocks: [
      {
        kind: 'prose',
        text: 'Two things, and neither is a Motir account detail — you sign in **inside** the container in step 4, so there is nothing to mint or copy first. You do not need the Motir CLI on this machine either; it ships in the image.',
      },
      {
        kind: 'table',
        columns: ['What you need', 'How to get it'],
        rows: [
          [
            '`Docker`, running',
            'Docker Desktop or any engine. The images are built for `linux/amd64` **and** `linux/arm64`, so Apple Silicon is a first-class machine and nothing is emulated. There is no build step — you pull.',
          ],
          [
            'Your agent’s own sign-in, on this machine',
            'Sign in to your coding agent once, here, before you start — or have its API key in your environment. Its credential mount is **read-only**, so the container can use a sign-in and can never perform one.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'A Motir project usually spans several repositories and the work loop runs across all of them — so what you mount is the folder that **contains** your checkouts, not any one of them. Start the container from there:',
      },
      {
        kind: 'code',
        caption: 'your machine',
        code: `~/work/                 ← start the container from HERE
├── motir-core/         ← a checkout
└── motir-ai/           ← another`,
      },
    ],
  },
];

/** The six numbered steps, in order. */
export const SANDBOX_STEPS: readonly SandboxStep[] = [
  {
    id: 'pick-your-profile',
    title: 'Pick your profile',
    rendersProfileTable: true,
    blocks: [
      {
        kind: 'prose',
        text: 'One image per agent, each layer fetching that CLI from its own official source at build time. Find the row for the agent you already use — you need its **tag** and its **credential mount** in step 2.',
      },
      {
        kind: 'prose',
        text: '**Tier is how closely we track the vendor, not whether it works.** Every profile here is published, and every one is built and smoke-tested before a release ships. Tier 1 means we pin both the install source and the credential location and verify them on every change. Tier 2 installs from a vendor endpoint we do not control, so day-to-day breakage there is reported rather than blocking — it is caught at release, not necessarily the hour it happens.',
      },
    ],
  },
  {
    id: 'start-the-container',
    title: 'Start the container',
    rendersRunCommand: true,
    blocks: [
      {
        kind: 'prose',
        text: 'Two of its parts come from the row you just picked; everything else is the same for every profile. It drops you into a shell in `/workspace`.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        text: 'Note there is **no `--rm`**, and the container has a name. The sign-in in step 4 is written inside the container, so a `--rm` run would throw it away the moment you exit. Set it up once and come back to it with `docker start -ai motir-sandbox`.',
      },
      {
        kind: 'callout',
        tone: 'info',
        text: '**Self-hosting?** The CLI talks to `https://app.motir.co` unless told otherwise, so nothing here names a server. Point it at your own instance by adding `-e MOTIR_SERVER=https://motir.example.com` — Motir is open-core and self-hostable, and that variable is the whole difference.',
      },
    ],
  },
  {
    id: 'or-from-vs-code',
    title: 'Or start it from VS Code instead',
    blocks: [
      {
        kind: 'prose',
        text: 'The same confined image, as a dev container: VS Code opens `/workspace` inside it with the same mounts, so your editor, terminal and agent all run behind the same boundary. Three sub-steps, and they **replace step 2** rather than following it — steps 4 onwards are the same either way.',
      },
      {
        kind: 'prose',
        text: '**1 · Install the Dev Containers extension.** From the Extensions view, or the command palette’s **Extensions: Install Extensions**. It is what starts the container on your behalf, and it drives the same Docker engine step 2 uses.',
      },
      {
        kind: 'prose',
        text: '**2 · Add `.devcontainer/devcontainer.json`** to the folder you are mounting — the same one step 2 would have started from. It pins the published image and passes the mount your profile needs:',
      },
      {
        kind: 'code',
        caption: '.devcontainer/devcontainer.json',
        copyable: true,
        code: `{
  "name": "Motir sandbox (Claude Code)",
  "image": "${SANDBOX_IMAGE}:claude",
  "workspaceFolder": "/workspace",
  "workspaceMount": "source=\${localWorkspaceFolder},target=/workspace,type=bind",
  "mounts": [
    "source=\${localEnv:HOME}/.claude,target=/home/node/.claude,type=bind,readonly"
  ],
  "remoteUser": "node",
  "overrideCommand": true
}`,
      },
      {
        kind: 'prose',
        text: 'Swap `:claude` and the `mounts` entry for your row from step 1. A dev container is not torn down when you close the window, so the sign-in in step 4 persists here without any extra flag.',
      },
      {
        kind: 'prose',
        text: '**3 · Reopen in Container.** Command palette → **Dev Containers: Reopen in Container**. VS Code pulls the image and attaches; its terminal is the same shell step 2 would have dropped you into.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        text: 'The `devcontainer.json` files inside the motir-core repository are **not** this file. They carry a `build` block pointing at that repository’s own `Dockerfile`, because they are its dev containers and a checkout is what those are for. For your own workspace, pin the image as above.',
      },
    ],
  },
  {
    id: 'sign-in',
    title: 'Sign in',
    cliCommands: ['login'],
    blocks: [
      {
        kind: 'prose',
        text: 'From the shell inside the container. It prints a code and a URL, you approve it in a browser on any device, and the container polls until the token is minted — a device grant, headless by construction, which is exactly what a container is.',
      },
      {
        kind: 'code',
        caption: 'inside the container',
        copyable: true,
        code: 'motir login',
      },
      {
        kind: 'callout',
        tone: 'info',
        text: '**Two other ways in, for the machines that need them.** A CI runner or a brand-new box has no browser to approve anything, so pass a token straight through: `-e MOTIR_TOKEN` on step 2’s command, minted under Settings → Account → API tokens. And a laptop that has already run `motir login` can mount its credential read-only — but then `motir login` has nowhere to write, and says so.',
      },
    ],
  },
  {
    id: 'link-your-project',
    title: 'Link the folder to your project',
    cliCommands: ['link'],
    blocks: [
      {
        kind: 'prose',
        text: 'Still inside the container. This binds `/workspace` — the folder you mounted — to a Motir project, so every command knows what it is working on:',
      },
      {
        kind: 'code',
        caption: 'inside the container',
        copyable: true,
        code: 'motir link',
      },
      {
        kind: 'prose',
        text: '**If your workspace has exactly one project, that is the whole step** — it is chosen for you and nothing is asked. With more than one, the command lists them and asks which; pass `--project <key>` to answer up front, which is also what a non-interactive shell needs.',
      },
    ],
  },
  {
    id: 'check-it',
    title: 'Check it',
    cliCommands: ['doctor'],
    blocks: [
      {
        kind: 'prose',
        text: 'The last thing, and the one that tells you the setup actually took:',
      },
      {
        kind: 'code',
        caption: 'inside the container',
        copyable: true,
        code: 'motir doctor',
      },
      {
        kind: 'table',
        columns: ['It checks', 'Which tells you'],
        rows: [
          [
            'the workspace',
            '`/workspace` is writable and the link from step 5 resolves — so you mounted the right folder, not a checkout inside it.',
          ],
          [
            'the Motir credential',
            'Step 4’s sign-in landed, and it names where the credential came from.',
          ],
          [
            'your agent',
            'The binary is on `PATH`, and its own credential is present where that profile keeps it — step 2’s read-only mount actually landed.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'All three green is the end of this page: you have a confined container that can see your work and hold your credentials, and nothing else on your machine.',
      },
    ],
  },
];

/**
 * The hand-off. Deliberately NOT a seventh step — it is the boundary.
 *
 * Setting the sandbox up and using it are different things and this page owns
 * only the first, so the work loop is named once and delegated. The `--agent`
 * flags in particular CANNOT live here: they drift between vendor releases, and
 * Amendment 9 Q2's rule is that a fact belongs on this page only when a test can
 * hold it true.
 */
export const SANDBOX_WHAT_NEXT: readonly GuideBlock[] = [
  {
    kind: 'prose',
    text: '**Setting the sandbox up and using it are different things, and this page only owns the first.** Inside the container the CLI behaves exactly as it does on a host — `motir next` to take one item, `motir run <key>` for a specific one, or `motir auto` to drain the ready set unattended, which is what the confinement is really for. All three are documented with the CLI, because none of them is about the container.',
  },
  {
    kind: 'callout',
    tone: 'info',
    text: 'The unattended loop takes your agent’s own non-interactive and auto-approve flags (`motir auto --agent "<your agent’s command>"`). Those drift between vendor releases, so the current set lives beside the image in `packages/cli/sandbox/README.md` — which is also where the digests to pin, the confinement proof, the validation harness and the escape hatch for an unlisted agent live.',
  },
];
