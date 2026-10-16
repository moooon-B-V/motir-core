// THE SEED MANIFEST (Story MOTIR-8538 · MOTIR-8673).
//
// One JSON file every k6 scenario opens in its init context, the report reads, and
// the reset command rewrites. Its FIELD NAMES ARE A CONTRACT: the agent, run and
// reader scenario cards are written against them, so a rename here is a change to
// every one of those.
//
// ⚠️ IT HOLDS CREDENTIALS — every token's plaintext and every reader's session
// cookie. It is written mode 0600 under the gitignored `loadtest/.out/`, never
// printed, and leaves the operator's machine only through the run command's upload
// to the generator, which deletes it there after the run. Token plaintext is shown
// once and only its hash is stored, so a lost manifest is recovered by a re-seed,
// never by a reset.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentRole, SeedShape } from './shape';

export const MANIFEST_VERSION = 1;
export const DEFAULT_MANIFEST_PATH = resolve(process.cwd(), 'loadtest/.out/manifest.json');

/** A work item as the scenarios address it: its row id and its key (`LTA-12`). */
export interface ManifestCard {
  id: string;
  key: string;
}

export interface ManifestUser {
  id: string;
  /** Always `@loadtest.invalid` — non-deliverable even past a misconfigured sink. */
  email: string;
  /** The session cookie's NAME as Better-Auth's own config builds it (never hard-coded). */
  cookieName: string;
  /** The workspace this reader's requests are pinned to. */
  readerWorkspaceId: string;
  /** The project set active for this member in `readerWorkspaceId`. */
  readerProjectId: string;
  /** The full `Cookie` header: the signed session cookie plus `workspace_id=<readerWorkspaceId>`. */
  cookieHeader: string;
  /** Every workspace this user is a member of. */
  workspaceIds: string[];
}

export interface ManifestBurst {
  /** This agent's own `burstSize` cards — no other burst agent touches them. */
  cards: ManifestCard[];
  /** Its own two container parents; every card is seeded under the first. */
  parents: [ManifestCard, ManifestCard];
}

export interface ManifestAgent {
  /** The token row's id. */
  tokenId: string;
  /** The plaintext bearer. */
  token: string;
  role: AgentRole;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** Present only on a burst agent (a `write` agent). */
  burst?: ManifestBurst;
  /** The `generating` plans this agent appends to (`write` agents only). */
  scratchPlanIds: string[];
}

export interface ManifestWorkspace {
  id: string;
  name: string;
  ownerUserId: string;
  projectIds: string[];
  /** Agents bound to this workspace, by role — the per-workspace rate arithmetic reads it. */
  agentCounts: Record<AgentRole, number> & { total: number };
}

export interface ManifestProject {
  id: string;
  key: string;
  workspaceId: string;
  /** The stable backlog: stories and their subtasks. */
  content: { stories: ManifestCard[]; subtasks: ManifestCard[] };
  /** The consumable pools and the story each pool's cards sit under. */
  pools: {
    claim: ManifestCard[];
    run: ManifestCard[];
    write: ManifestCard[];
    parents: { claim: ManifestCard; run: ManifestCard; write: ManifestCard };
  };
  /** `planned` plans a reader reads; nothing appends to them. */
  readPlanIds: string[];
  /** `generating` plans the write agents append to; no reader reads them. */
  scratchPlanIds: string[];
}

export interface SeedManifest {
  version: typeof MANIFEST_VERSION;
  runTag: string;
  seededAt: string;
  /** The app origin the cookies were minted for (`MOTIR_BASE_URL`). */
  baseUrl: string;
  /** The endpoint host the seed wrote to. */
  databaseHost: string;
  /** How long a minted session lives (Better-Auth's `session.expiresIn`). */
  sessionLifetimeSeconds: number;
  sessionsExpireAt: string;
  shape: SeedShape;
  users: ManifestUser[];
  agents: ManifestAgent[];
  workspaces: ManifestWorkspace[];
  projects: ManifestProject[];
}

export class ManifestMissingError extends Error {
  constructor(readonly path: string) {
    super(
      `no seed manifest at ${path}. A reset cannot recover one: token plaintext is shown once ` +
        `and only its hash is stored. Re-seed with \`pnpm loadtest:seed\`.`,
    );
    this.name = 'ManifestMissingError';
  }
}

/** Write the manifest with mode 0600, creating its directory. */
export async function writeManifest(manifest: SeedManifest, path = DEFAULT_MANIFEST_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; a rewrite keeps the old bits.
  await chmod(path, 0o600);
}

/** Read the manifest the seed wrote — the reader the reset, the report and the tests share. */
export async function readManifest(path = DEFAULT_MANIFEST_PATH): Promise<SeedManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ManifestMissingError(path);
    throw err;
  }
  const parsed = JSON.parse(raw) as SeedManifest;
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(
      `seed manifest ${path} is version ${String(parsed.version)}, expected ${MANIFEST_VERSION}`,
    );
  }
  return parsed;
}

/** Every card id the manifest names, for a test that checks each one is still valid. */
export function manifestCardIds(manifest: SeedManifest): string[] {
  const ids: string[] = [];
  for (const p of manifest.projects) {
    for (const c of [
      ...p.content.stories,
      ...p.content.subtasks,
      ...p.pools.claim,
      ...p.pools.run,
      ...p.pools.write,
      p.pools.parents.claim,
      p.pools.parents.run,
      p.pools.parents.write,
    ]) {
      ids.push(c.id);
    }
  }
  for (const a of manifest.agents) {
    if (a.burst) for (const c of [...a.burst.cards, ...a.burst.parents]) ids.push(c.id);
  }
  return ids;
}
