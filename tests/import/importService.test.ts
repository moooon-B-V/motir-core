import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { importService } from '@/lib/services/importService';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { LinearOAuthExchangeError } from '@/lib/import/linear/errors';
import { JiraOAuthExchangeError } from '@/lib/import/jira/errors';
import { PlaneOAuthExchangeError } from '@/lib/import/plane/errors';
import type { ImportConnectionConfig } from '@/lib/dto/import';
import type { ImportMapping } from '@/lib/import/engine/types';
import {
  ImportConnectionConfigError,
  ImportNotFoundError,
  ImportSourceNotConnectedError,
} from '@/lib/import/errors';
import { usersService } from '@/lib/services/usersService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture } from '../fixtures';

// Service-layer tests for the import RUN surface (MOTIR-941) — the ONE service
// the API routes call. Real Postgres; the CSV connector (credential-free) gives
// full create-draft → preview → run coverage end-to-end without live-source
// plumbing. The live-source path's credential gate is covered via its typed
// error.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}
beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const CSV_HEADER = 'Issue key,Summary,Type,Status,Priority,Assignee,Labels,Parent,Created';
function csvConnection(...rows: string[]): ImportConnectionConfig {
  return { source: 'csv', filename: 'export.csv', content: [CSV_HEADER, ...rows].join('\n') };
}
const CSV_MAPPING: ImportMapping = {
  defaultKind: 'task',
  typeToKind: { bug: 'bug', task: 'task' },
  statusToKey: { open: 'todo', done: 'done' },
};

describe('importService', () => {
  it('createDraft creates a draft import and getImport reads it back (status + zero counts)', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv', sourceRef: 'export.csv' },
      fx.ctx,
    );
    expect(draft.status).toBe('draft');
    expect(draft.counts).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0 });

    const read = await importService.getImport(draft.id, fx.ctx);
    expect(read.id).toBe(draft.id);
    expect(read.source).toBe('csv');
    expect(read.sourceRef).toBe('export.csv');
  });

  it('getImport is tenant-scoped — a foreign workspace id is a 404 (ImportNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ identifier: 'OTHER', name: 'Other' });
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    await expect(importService.getImport(draft.id, other.ctx)).rejects.toBeInstanceOf(
      ImportNotFoundError,
    );
  });

  it('preview classifies with no writes, then stores the mapping + a previewed status', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    const conn = csvConnection('ACME-1,First,Task,Open,,,,,', 'ACME-2,Second,Bug,Done,,,,,');

    const result = await importService.preview(
      draft.id,
      { mapping: CSV_MAPPING, connection: conn },
      fx.ctx,
    );
    expect(result.counts).toEqual({ create: 2, update: 0, skip: 0 });
    // No writes happened.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);

    const after = await importService.getImport(draft.id, fx.ctx);
    expect(after.status).toBe('previewed');
    expect(after.mapping).toMatchObject({ statusToKey: { open: 'todo', done: 'done' } });
  });

  it('run wires the connector into the persist engine — CSV rows become work items end-to-end', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    const conn = csvConnection('ACME-1,First,Task,Open,,,,,', 'ACME-2,Second,Bug,Done,,,,,');

    const gen = await importService.run(
      draft.id,
      { mapping: CSV_MAPPING, connection: conn },
      fx.ctx,
    );
    let summary: { created: number } | null = null;
    for await (const p of gen) if (p.type === 'summary') summary = p.counts;
    expect(summary?.created).toBe(2);

    const items = await db.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(items).toHaveLength(2);
    const finished = await importService.getImport(draft.id, fx.ctx);
    expect(finished.status).toBe('succeeded');
    expect(finished.counts.created).toBe(2);
  });

  it('run rejects when no mapping is supplied and none was stored', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    await expect(
      importService.run(
        draft.id,
        { connection: csvConnection('ACME-1,First,Task,Open,,,,,') },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ImportConnectionConfigError);
  });

  it('discoverFields — probes reachability and returns the field vocabulary (CSV, no writes)', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    const conn = csvConnection(
      'ACME-1,First,Task,Open,Medium,,,',
      'ACME-2,Second,Bug,Done,High,alice,,',
    );

    const result = await importService.discoverFields(draft.id, { connection: conn }, fx.ctx);

    expect(result.connect.sourceRef).toBe('export.csv');
    expect(result.connect.issueCount).toBe(2);
    expect(result.vocabulary.types).toContain('Task');
    expect(result.vocabulary.types).toContain('Bug');
    expect(result.vocabulary.statuses).toContain('Open');
    expect(result.vocabulary.statuses).toContain('Done');
    expect(result.vocabulary.priorities).toContain('Medium');
    expect(result.vocabulary.priorities).toContain('High');
    // No writes happened (read-only probe).
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('a live source with no connected identity is rejected (ImportSourceNotConnectedError)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      importService.buildConnector(
        'jira',
        { source: 'jira', baseUrl: 'https://x.atlassian.net' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ImportSourceNotConnectedError);
  });
});

// MOTIR-2434 — Linear expires every OAuth access token after 24 hours, so the
// connector must be built from a token that was RENEWED first. These assert the
// wiring at the seam the importer actually uses: the credential the built
// connector puts on the wire, not just what the OAuth service returns.
describe('importService.buildConnector — the Linear refresh path', () => {
  const LINEAR_CONNECTION = { source: 'linear', authScheme: 'bearer' } as const;
  const GRAPHQL = 'https://api.linear.app/graphql';

  interface LinearStub {
    tokenPosts: URLSearchParams[];
    graphqlAuth: string[];
  }

  /** Stub `fetch` for BOTH Linear endpoints: the OAuth token exchange (answered
   *  from `token`) and the GraphQL API the connector calls, recording the
   *  Authorization header each request carried. */
  function stubLinear(token: { status?: number; body: unknown }): LinearStub {
    const stub: LinearStub = { tokenPosts: [], graphqlAuth: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        if (url.includes('api.linear.app/oauth/token')) {
          stub.tokenPosts.push(new URLSearchParams(String(init?.body ?? '')));
          return json(token.body, token.status ?? 200);
        }
        if (url.startsWith(GRAPHQL)) {
          stub.graphqlAuth.push(String(new Headers(init?.headers).get('authorization')));
          return json({ data: { viewer: { id: 'u1', name: 'Member' } } });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
    return stub;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('rejects with ImportSourceNotConnectedError when Linear was never connected', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      importService.buildConnector('linear', LINEAR_CONNECTION, fx.ctx),
    ).rejects.toBeInstanceOf(ImportSourceNotConnectedError);
  });

  it('renews an EXPIRED token before the connector calls Linear (the day-two failure)', async () => {
    const fx = await makeWorkItemFixture();
    await importSourceIdentityService.upsertIdentity({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      source: 'linear',
      accessToken: 'stale_token',
      refreshToken: 'refresh_1',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    const stub = stubLinear({
      body: { access_token: 'fresh_token', refresh_token: 'refresh_2', expires_in: 86_399 },
    });

    const connector = await importService.buildConnector('linear', LINEAR_CONNECTION, fx.ctx);
    await connector.connect();

    // The refresh ran, and the connector went out with the RENEWED token — the
    // stale one never reached Linear.
    expect(stub.tokenPosts.map((p) => p.get('grant_type'))).toEqual(['refresh_token']);
    expect(stub.graphqlAuth).toEqual(['Bearer fresh_token']);
  });

  it('passes an unexpired token straight through (no refresh POST)', async () => {
    const fx = await makeWorkItemFixture();
    await importSourceIdentityService.upsertIdentity({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      source: 'linear',
      accessToken: 'live_token',
      refreshToken: 'refresh_1',
      expiresAt: new Date(Date.now() + 12 * 60 * 60_000),
    });
    const stub = stubLinear({ body: { access_token: 'should_not_be_used' } });

    const connector = await importService.buildConnector('linear', LINEAR_CONNECTION, fx.ctx);
    await connector.connect();

    expect(stub.tokenPosts).toHaveLength(0);
    expect(stub.graphqlAuth).toEqual(['Bearer live_token']);
  });

  it('turns a grant Linear will not refresh into the 422 not-connected error, not a 500', async () => {
    const fx = await makeWorkItemFixture();
    await importSourceIdentityService.upsertIdentity({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      source: 'linear',
      accessToken: 'stale_token',
      refreshToken: 'refresh_dead',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    stubLinear({ status: 400, body: { error: 'invalid_grant' } });

    const err = await importService
      .buildConnector('linear', LINEAR_CONNECTION, fx.ctx)
      .then(() => null)
      .catch((e: unknown) => e);

    // The member's remedy is to re-connect, which is what this code tells the
    // wizard to say; the vendor detail survives as the cause.
    expect(err).toBeInstanceOf(ImportSourceNotConnectedError);
    expect((err as Error).cause).toBeInstanceOf(LinearOAuthExchangeError);
  });
});

// MOTIR-2454 — the same defect MOTIR-2434 fixed for Linear, in the two
// connectors that were cited as its working precedent: `jiraOAuthService` and
// `planeImportOAuthService` each shipped a `getFreshConnection`, and NOTHING
// called it, so `buildConnector` replayed a Bearer the vendor had already
// expired. Jira is the sharpest case — an Atlassian 3LO access token lives ~60
// minutes, so the import broke about an hour after connect.
//
// These assert at the seam the importer actually uses (`notes.html` #208: a path
// is not verified from one end, only THROUGH): the credential the BUILT
// connector puts on the wire, and the host it puts it on — not what the OAuth
// service returns.
describe('importService.buildConnector — the Jira refresh path', () => {
  const JIRA_CONNECTION = {
    source: 'jira',
    baseUrl: 'https://acme.atlassian.net',
    projectKey: 'ACME',
  } as const;
  const CLOUD_ID = 'cloud-1';
  const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
  /** Where a 3LO Bearer is actually accepted — NOT the `*.atlassian.net` site. */
  const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;

  interface JiraStub {
    /** The JSON body of each POST to the token endpoint. */
    tokenPosts: Record<string, string>[];
    /** `{ url, auth }` for every REST call the connector made. */
    apiCalls: { url: string; auth: string }[];
  }

  function stubJira(token: { status?: number; body: unknown }): JiraStub {
    const stub: JiraStub = { tokenPosts: [], apiCalls: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        if (url === TOKEN_URL) {
          stub.tokenPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>);
          return json(token.body, token.status ?? 200);
        }
        if (url.startsWith(GATEWAY)) {
          stub.apiCalls.push({
            url,
            auth: String(new Headers(init?.headers).get('authorization')),
          });
          // `connect()` validates with /myself, then probes the count.
          return json(url.includes('/search') ? { total: 7 } : {});
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
    return stub;
  }

  async function connectJira(ctx: ServiceContext, args: { expiresAt: Date; accessToken: string }) {
    await importSourceIdentityService.upsertIdentity({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      source: 'jira',
      accessToken: args.accessToken,
      refreshToken: 'refresh_1',
      expiresAt: args.expiresAt,
      metadata: { cloudId: CLOUD_ID, siteUrl: 'https://acme.atlassian.net' },
    });
  }

  beforeEach(() => {
    // Jira is the one import OAuth app vitest.config.ts leaves unset (the
    // routes test sets it per-file too) — the exchange itself is stubbed.
    vi.stubEnv('JIRA_OAUTH_CLIENT_ID', 'test-jira-client-id');
    vi.stubEnv('JIRA_OAUTH_CLIENT_SECRET', 'test-jira-client-secret');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('renews an EXPIRED token before the connector calls Jira, and calls the api.atlassian.com GATEWAY', async () => {
    const fx = await makeWorkItemFixture();
    await connectJira(fx.ctx, {
      accessToken: 'stale_token',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    const stub = stubJira({
      body: { access_token: 'fresh_token', refresh_token: 'refresh_2', expires_in: 3_600 },
    });

    const connector = await importService.buildConnector('jira', JIRA_CONNECTION, fx.ctx);
    const result = await connector.connect();

    expect(stub.tokenPosts.map((p) => p['grant_type'])).toEqual(['refresh_token']);
    expect(stub.tokenPosts[0]?.['refresh_token']).toBe('refresh_1');
    // Every outbound REST call carried the RENEWED token, and went to the
    // gateway — a 3LO Bearer is rejected on `acme.atlassian.net`, so sending
    // the member's own site URL would renew a token only to waste it.
    expect(stub.apiCalls.map((c) => c.auth)).toEqual(['Bearer fresh_token', 'Bearer fresh_token']);
    expect(stub.apiCalls.every((c) => c.url.startsWith(GATEWAY))).toBe(true);
    expect(result.issueCount).toBe(7);
  });

  it('PERSISTS the rotated token — a second build finds it unexpired and refreshes nothing', async () => {
    // The round trip (`notes.html` #208): "the refresh returned a token" is a
    // claim about the OAuth service; that the NEXT import reads it back is the
    // claim worth making, and only a second build through the real path makes it.
    const fx = await makeWorkItemFixture();
    await connectJira(fx.ctx, {
      accessToken: 'stale_token',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    const first = stubJira({
      body: { access_token: 'fresh_token', refresh_token: 'refresh_2', expires_in: 3_600 },
    });
    await (await importService.buildConnector('jira', JIRA_CONNECTION, fx.ctx)).connect();
    expect(first.tokenPosts).toHaveLength(1);

    const second = stubJira({ body: { access_token: 'should_not_be_used' } });
    await (await importService.buildConnector('jira', JIRA_CONNECTION, fx.ctx)).connect();

    expect(second.tokenPosts).toHaveLength(0);
    expect(second.apiCalls.map((c) => c.auth)).toEqual([
      'Bearer fresh_token',
      'Bearer fresh_token',
    ]);
  });

  it('passes an unexpired token straight through (no refresh POST)', async () => {
    const fx = await makeWorkItemFixture();
    await connectJira(fx.ctx, {
      accessToken: 'live_token',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const stub = stubJira({ body: { access_token: 'should_not_be_used' } });

    await (await importService.buildConnector('jira', JIRA_CONNECTION, fx.ctx)).connect();

    expect(stub.tokenPosts).toHaveLength(0);
    expect(stub.apiCalls.map((c) => c.auth)).toEqual(['Bearer live_token', 'Bearer live_token']);
  });

  it('turns a grant Atlassian will not refresh into the 422 not-connected error, not a 500', async () => {
    const fx = await makeWorkItemFixture();
    await connectJira(fx.ctx, {
      accessToken: 'stale_token',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    stubJira({ status: 400, body: { error: 'invalid_grant' } });

    const err = await importService
      .buildConnector('jira', JIRA_CONNECTION, fx.ctx)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportSourceNotConnectedError);
    expect((err as Error).cause).toBeInstanceOf(JiraOAuthExchangeError);
  });
});

describe('importService.buildConnector — the Plane refresh path', () => {
  const PLANE_CONNECTION = {
    source: 'plane',
    workspaceSlug: 'acme',
    projectId: 'proj-1',
  } as const;
  const ORIGIN = 'https://api.plane.so';
  const TOKEN_URL = `${ORIGIN}/auth/o/token/`;
  const WORK_ITEMS = `${ORIGIN}/api/v1/workspaces/acme/projects/proj-1/work-items/`;

  interface PlaneStub {
    /** The form-encoded body of each POST to the token endpoint. */
    tokenPosts: URLSearchParams[];
    /** The `Authorization` header value on every REST call the connector made. */
    apiCredentials: string[];
    /** The `X-API-Key` header on each of those calls — must stay null (MOTIR-2457). */
    patHeaders: (string | null)[];
  }

  function stubPlane(token: { status?: number; body: unknown }): PlaneStub {
    const stub: PlaneStub = { tokenPosts: [], apiCredentials: [], patHeaders: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        if (url === TOKEN_URL) {
          stub.tokenPosts.push(new URLSearchParams(String(init?.body ?? '')));
          return json(token.body, token.status ?? 200);
        }
        if (url.startsWith(WORK_ITEMS)) {
          // Read off `authorization` — the ONE scheme the whole path now speaks
          // (MOTIR-2457). Plane's docs put an OAuth access token in
          // `Authorization: Bearer` and reserve `X-API-Key` for a `plane_api_*`
          // PAT; the connector shipped sending the OAuth token in the PAT
          // header, so this assertion moved here when that landed. Recording the
          // PAT header TOO is what makes this an end-to-end scheme check rather
          // than the connector agreeing with itself (`notes.html` #162).
          const headers = new Headers(init?.headers);
          stub.apiCredentials.push(String(headers.get('authorization')));
          stub.patHeaders.push(headers.get('x-api-key'));
          return json({ total_count: 3, results: [] });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
    return stub;
  }

  async function connectPlane(ctx: ServiceContext, args: { expiresAt: Date; accessToken: string }) {
    await importSourceIdentityService.upsertIdentity({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      source: 'plane',
      accessToken: args.accessToken,
      refreshToken: 'refresh_1',
      expiresAt: args.expiresAt,
      metadata: { baseUrl: ORIGIN, workspaceSlug: 'acme' },
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  it('renews an EXPIRED token before the connector calls Plane', async () => {
    const fx = await makeWorkItemFixture();
    await connectPlane(fx.ctx, {
      accessToken: 'stale_token',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    const stub = stubPlane({
      body: { access_token: 'fresh_token', refresh_token: 'refresh_2', expires_in: 3_600 },
    });

    const connector = await importService.buildConnector('plane', PLANE_CONNECTION, fx.ctx);
    const result = await connector.connect();

    expect(stub.tokenPosts.map((p) => p.get('grant_type'))).toEqual(['refresh_token']);
    expect(stub.tokenPosts[0]?.get('refresh_token')).toBe('refresh_1');
    // Stored identity → refresh → connector → wire: ONE credential, ONE scheme.
    expect(stub.apiCredentials).toEqual(['Bearer fresh_token']);
    expect(stub.patHeaders).toEqual([null]);
    expect(result.issueCount).toBe(3);
  });

  it('passes an unexpired token straight through (no refresh POST)', async () => {
    const fx = await makeWorkItemFixture();
    await connectPlane(fx.ctx, {
      accessToken: 'live_token',
      expiresAt: new Date(Date.now() + 12 * 60 * 60_000),
    });
    const stub = stubPlane({ body: { access_token: 'should_not_be_used' } });

    await (await importService.buildConnector('plane', PLANE_CONNECTION, fx.ctx)).connect();

    expect(stub.tokenPosts).toHaveLength(0);
    expect(stub.apiCredentials).toEqual(['Bearer live_token']);
    expect(stub.patHeaders).toEqual([null]);
  });

  it('turns a grant Plane will not refresh into the 422 not-connected error, not a 500', async () => {
    const fx = await makeWorkItemFixture();
    await connectPlane(fx.ctx, {
      accessToken: 'stale_token',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    stubPlane({ status: 400, body: { error: 'invalid_grant' } });

    const err = await importService
      .buildConnector('plane', PLANE_CONNECTION, fx.ctx)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportSourceNotConnectedError);
    expect((err as Error).cause).toBeInstanceOf(PlaneOAuthExchangeError);
  });
});

// The `import:run` GATE (Story MOTIR-2291 · Subtask MOTIR-2353) — the largest
// single revocation in the story: four of these five operations asserted
// `assertCanEdit`, so every project MEMBER could pull an entire external backlog
// into a project, and the fifth (`getImport`) asked nothing at all. Both mirrors
// put imports behind administration, so the key is admin-only. The member refusal
// IS the deliverable, so it is asserted rather than implied.
describe('importService — the import:run gate', () => {
  interface Actors {
    projectId: string;
    adminCtx: ServiceContext;
    memberCtx: ServiceContext;
    foreignCtx: ServiceContext;
  }

  let gateSeq = 0;
  async function makeActors(): Promise<Actors> {
    gateSeq += 1;
    const fx = await makeWorkItemFixture({ identifier: `IG${gateSeq}` });
    async function enroll(slug: string, role: 'admin' | 'member'): Promise<ServiceContext> {
      const user = await usersService.createUser({
        email: `import-${slug}-${gateSeq}@example.com`,
        password: 'hunter2hunter2',
        name: slug,
      });
      await db.workspaceMembership.create({
        data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
      });
      await projectMembersService.addMember({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        targetUserId: user.id,
        role,
      });
      return { userId: user.id, workspaceId: fx.workspaceId };
    }
    const foreign = await makeWorkItemFixture({ identifier: `IF${gateSeq}`, name: 'Foreign' });
    return {
      projectId: fx.projectId,
      adminCtx: await enroll('admin', 'admin'),
      memberCtx: await enroll('member', 'member'),
      foreignCtx: foreign.ctx,
    };
  }

  it('refuses a project MEMBER every one of the five — the revocation, stated', async () => {
    const a = await makeActors();
    // create is refused outright…
    await expect(
      importService.createDraft({ projectId: a.projectId, source: 'csv' }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // …and so is every operation on a draft an admin made.
    const draft = await importService.createDraft(
      { projectId: a.projectId, source: 'csv' },
      a.adminCtx,
    );
    const connection = csvConnection('K-1,One,task,open,,,,,2026-01-01');
    await expect(importService.getImport(draft.id, a.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      importService.discoverFields(draft.id, { connection }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      importService.preview(draft.id, { connection, mapping: CSV_MAPPING }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      importService.run(draft.id, { connection, mapping: CSV_MAPPING }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('admits a project ADMIN through the whole wizard', async () => {
    const a = await makeActors();
    const draft = await importService.createDraft(
      { projectId: a.projectId, source: 'csv' },
      a.adminCtx,
    );
    const connection = csvConnection('K-1,One,task,open,,,,,2026-01-01');
    await expect(importService.getImport(draft.id, a.adminCtx)).resolves.toBeTruthy();
    await expect(
      importService.preview(draft.id, { connection, mapping: CSV_MAPPING }, a.adminCtx),
    ).resolves.toBeTruthy();
  });

  it('keeps the non-browser refusal shaped as a 404, never a 403', async () => {
    // `createDraft` resolves the project itself, so a foreign id is
    // ProjectNotFoundError before the key is ever tested — the no-existence-leak
    // ordering, unchanged by this card.
    const a = await makeActors();
    await expect(
      importService.createDraft({ projectId: a.projectId, source: 'csv' }, a.foreignCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
