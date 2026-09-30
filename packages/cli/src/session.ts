import {
  MotirClient,
  type ReadyContainerSummary,
  type ReadyItemSummary,
  type SearchItemSummary,
} from './client.js';
import { sprintFilter } from './render.js';
import { CliError } from './errors.js';
import { requireLink, type FoundLink } from './config/linkConfig.js';
import { resolveServerUrl } from './serverResolve.js';
import { normalizeServerUrl, resolveCredential } from './config/userConfig.js';
import { claimAgentRunScratch, prepareHostedRun } from './hostedGit.js';
import {
  agentRunWorkspace,
  hostedLink,
  hostedWorkspace,
  isAgentRun,
  readAdoptedRun,
  readAgentRunAccess,
  type AdoptedRun,
} from './hostedMode.js';

// Shared plumbing for the commands that talk to a linked project: resolve the
// `.motir.json` binding (walked up from cwd), resolve the server + its
// credential through the shared ladders, and open ONE connected MCP client.
// Every read/dispatch command runs inside a session so the connect + close (and
// the not-linked / not-logged-in errors) live in one place.
//
// The link supplies the PROJECT; the SERVER goes through `resolveServerUrl` so
// `MOTIR_SERVER` can point a linked checkout at another instance without
// rewriting `.motir.json` (with no env set, the link is the next rung down, so
// this resolves to exactly what it always did).

export interface ProjectSession {
  link: FoundLink;
  serverUrl: string;
  projectKey: string;
  client: MotirClient;
}

/** Resolve the linked project + token and build a client for it. Throws
 * {@link CliError} (NotLinked / not-logged-in) before any network call.
 *
 * ⚠️ NOTHING IS OPENED. A client is a base URL and a bearer, so there is no
 * handshake to perform here and nothing for the caller to close — the MCP
 * session this function used to open went with the SDK (11.5.6). It stays
 * `async` because every caller awaits it and the signature is not this card's
 * to change. */
export async function openProjectSession(): Promise<ProjectSession> {
  const link = requireLink();
  const serverUrl = resolveServerUrl();
  const cred = resolveCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: 'Run `motir auth login`, or set MOTIR_TOKEN.',
    });
  }
  const client = new MotirClient({ serverUrl, token: cred.token });
  return { link, serverUrl, projectKey: link.config.project, client };
}

/** Run `fn` against the linked project's session — the entry point every
 *  project-scoped command goes through, so the link/credential resolution and
 *  its error wording live in exactly one place. */
export async function withProjectSession<T>(
  fn: (session: ProjectSession) => Promise<T>,
): Promise<T> {
  return fn(await openProjectSession());
}

/**
 * Run `fn` inside a HOSTED run's session (MOTIR-6558): the run the server opened
 * is read and checked BEFORE anything else, its project is taken from its own
 * cards, and the link is the workspace's — synthesised when the container has no
 * `.motir.json`, which is the ordinary case.
 *
 * ⚠️ THE SAME CREDENTIAL LADDER AS A LOCAL SESSION. The hosted names
 * (`MOTIR_API_URL`, `MOTIR_RUN_TOKEN`) are rungs on it, not a second resolver, so
 * a person who exports `MOTIR_TOKEN` into a container still gets what they asked
 * for.
 */
export async function withHostedProjectSession<T>(
  runId: string,
  fn: (session: ProjectSession, run: AdoptedRun) => Promise<T>,
  /** The card the command was given — what the run's pull requests link (MOTIR-6559). */
  targetKey?: string,
): Promise<T> {
  if (isAgentRun()) return withAgentRunSession(runId, fn, targetKey);
  const serverUrl = resolveServerUrl();
  const cred = resolveCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: 'A hosted run is booted with MOTIR_RUN_TOKEN; set it, or MOTIR_TOKEN.',
    });
  }
  const client = new MotirClient({ serverUrl, token: cred.token });
  const run = await readAdoptedRun(client, runId);
  // ⚠️ GITHUB ACCESS BEFORE ANY CHECKOUT (MOTIR-6559). The run's git config —
  // the credential helper, the App's identity per repository — and its `gh`
  // shim must exist before the first clone, and the run's credentials read here
  // are also where the pull requests' `dispatchedBy` comes from.
  await prepareHostedRun({
    serverUrl,
    token: cred.token,
    runId,
    targetKey: targetKey ?? (run.legs[0] as string),
    client,
  });
  const link = hostedLink(hostedWorkspace(), serverUrl, run.projectKey);
  return fn({ link, serverUrl, projectKey: run.projectKey, client }, run);
}

/**
 * The AGENT-MODE twin (MOTIR-7024, `agent-instance-run.md` §2): the same adopt,
 * the same GitHub setup, with the run's address and token from the launcher's
 * `run.json` (never the credential ladder, which in a developer's agent is the
 * developer's own), checkouts under a run-private workspace, a link that is
 * ALWAYS synthesised there (a `.motir.json` somewhere above it is the
 * developer's, not the run's), and both directories removed however it ends.
 */
async function withAgentRunSession<T>(
  runId: string,
  fn: (session: ProjectSession, run: AdoptedRun) => Promise<T>,
  targetKey: string | undefined,
): Promise<T> {
  const access = readAgentRunAccess(runId);
  const workspace = agentRunWorkspace(runId);
  const release = claimAgentRunScratch({ stateDir: access.stateDir, workspace });
  try {
    const serverUrl = normalizeServerUrl(access.apiUrl);
    const client = new MotirClient({ serverUrl, token: access.token });
    const run = await readAdoptedRun(client, runId);
    await prepareHostedRun({
      serverUrl,
      token: access.token,
      runId,
      targetKey: targetKey ?? (run.legs[0] as string),
      client,
      stateDir: access.stateDir,
      agentMode: true,
    });
    const link = hostedLink(workspace, serverUrl, run.projectKey, () => null);
    return await fn({ link, serverUrl, projectKey: run.projectKey, client }, run);
  } finally {
    release();
  }
}

/** The list_ready page size cap (server clamps `limit` to 200). We page at the
 * cap so collecting the whole ready set costs the fewest round-trips. */
export const READY_PAGE_SIZE = 200;

export interface ReadyFilter {
  kinds?: string[];
  assigneeId?: string | null;
  /** Which ready ROW lane — the leaves (default) or the bugs (MOTIR-6837). */
  lane?: 'leaf' | 'bug';
}

/**
 * Page through the ENTIRE ready set with the tool's cursor, accumulating every
 * row. Renders all pages for the table but never asks for more than the server
 * page size in a single call (the 7.9.2 acceptance contract). The ready set is
 * the actionable subset, so this stays small in practice.
 */
export async function collectReady(
  client: MotirClient,
  projectKey: string,
  filter: ReadyFilter = {},
): Promise<ReadyItemSummary[]> {
  const all: ReadyItemSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listReady({
      projectKey,
      lane: filter.lane ?? 'leaf',
      kinds: filter.kinds,
      assigneeId: filter.assigneeId,
      cursor,
      limit: READY_PAGE_SIZE,
    });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

/** Page through the WHOLE containers lane (MOTIR-6837) — `motir ready --parent`. */
export async function collectReadyContainers(
  client: MotirClient,
  projectKey: string,
  filter: { assigneeId?: string | null } = {},
): Promise<ReadyContainerSummary[]> {
  const all: ReadyContainerSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listReadyContainers({
      projectKey,
      assigneeId: filter.assigneeId,
      cursor,
      limit: READY_PAGE_SIZE,
    });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

/** The `search_work_items` page size cap (the List's own server cap — the tool
 * clamps `limit` to 50). Paging at the cap costs the fewest round-trips. */
export const SEARCH_PAGE_SIZE = 50;

export interface SprintItemsResult {
  items: SearchItemSummary[];
  /**
   * How many were collected.
   *
   * It used to be the SERVER's total for the query, checked against the rows in
   * hand so an early stop was visible rather than silent. The v1 collection
   * publishes no total (ADR Amendment 11 Q3), and there is nothing left to
   * check: this walk runs until `nextCursor` is null, so every matching row IS
   * in `items`. Asking `…/work-items/count` for a second opinion would be one
   * more request answering a question the page walk has already answered.
   */
  total: number;
}

/**
 * Page through ONE sprint's ENTIRE work-item set with the tool's cursor.
 *
 * A sprint is a BOUNDED set (tens to low hundreds), so collecting it fully is
 * the correct read: stopping at one page and printing 50 of 120 rows would be
 * a silent truncation, which the completeness rule forbids. The `total` comes
 * back with the rows so the caller can state the collected count against it —
 * any cap this ever grows must be VISIBLE in the output, never silent.
 */
export async function collectSprintItems(
  client: MotirClient,
  projectKey: string,
  sprintId: string,
  filter: { kinds?: string[] } = {},
): Promise<SprintItemsResult> {
  const items: SearchItemSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.searchWorkItems({
      projectKey,
      filter: sprintFilter(sprintId, filter.kinds),
      cursor,
      limit: SEARCH_PAGE_SIZE,
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { items, total: items.length };
}
