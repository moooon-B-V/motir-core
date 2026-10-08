import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

/**
 * STORY MOTIR-7602's INTEGRATION GATE (MOTIR-7610) — Contact sales reaches
 * platform staff, assembled, on the real Postgres.
 *
 * Each feature card proved its half with the other halves stubbed. This file
 * drives the lifecycle through the REAL doors on both sides of the seam — the
 * org route (`POST` / `GET /api/organizations/[orgId]/billing/enterprise-request`),
 * the staff email's queued `email.send` event, and the console service and
 * actions — so what an org sends is shown to be what staff see, closing a request
 * is shown to free the org to ask again, and the email's link is shown to land on
 * the console's detail route:
 *
 *   create → notify → list → transition → close → create again.
 *
 * Then the RACE the story's one-open-per-org rule exists for — an org's new
 * request against staff closing its previous one, with every legitimate order
 * accepted — and three GUARDS (cross-tenant, audit, no price), each written as a
 * function that returns its violations so it can be shown to FAIL on a planted
 * violation (a fixture case) as well as to pass on the shipped code.
 *
 * The one mock is `getSession` (CLAUDE.md's single allowance). It answers from
 * an AsyncLocalStorage so the two racers can each act as their own person at
 * the same moment; outside a racer it answers the ambient `signedIn` user.
 */

type SessionUser = { id: string; email: string };
const sessionStore = new AsyncLocalStorage<SessionUser | null>();
let signedIn: SessionUser | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => {
    const scoped = sessionStore.getStore();
    const user = scoped === undefined ? signedIn : scoped;
    return user ? { user: { id: user.id, email: user.email } } : null;
  }),
}));

const { GET, POST } =
  await import('@/app/api/organizations/[orgId]/billing/enterprise-request/route');
const {
  getEnterpriseRequestAction,
  listEnterpriseRequestsAction,
  transitionEnterpriseRequestAction,
} = await import('@/app/(admin)/admin/enterprise-requests/actions');
const { platformEnterpriseRequestService } =
  await import('@/lib/services/platformEnterpriseRequestService');
const { enterpriseRequestService } = await import('@/lib/services/enterpriseRequestService');
const { enterpriseRequestReceivedEmail } =
  await import('@/lib/emailTemplates/enterpriseRequestReceived');
const { enterpriseRequestRepository } =
  await import('@/lib/repositories/enterpriseRequestRepository');
const { withOrgContext } = await import('@/lib/organizations/context');
const { requirePlatformStaff } = await import('@/lib/platform/auth');
const { EnterpriseRequestStaleError, NotPlatformStaffError } =
  await import('@/lib/platform/errors');
const { OrganizationNotFoundError } = await import('@/lib/organizations/errors');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { db } = await import('@/lib/db');

type EnterpriseRequestDTO = import('@/lib/dto/billing').EnterpriseRequestDTO;
type PlatformEnterpriseRequestDTO =
  import('@/lib/dto/platformEnterpriseRequest').PlatformEnterpriseRequestDTO;

const ROOT = process.cwd();
let seq = 0;

// ── fixtures ─────────────────────────────────────────────────────────────────

function url(orgId: string) {
  return `http://localhost:3000/api/organizations/${orgId}/billing/enterprise-request`;
}

type Handlers = {
  GET: (req: Request, ctx: { params: Promise<{ orgId: string }> }) => Promise<Response>;
  POST: (req: Request, ctx: { params: Promise<{ orgId: string }> }) => Promise<Response>;
};
const ROUTE: Handlers = { GET, POST };

function postVia(h: Handlers, orgId: string, body: unknown) {
  return h.POST(
    new Request(url(orgId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

function getVia(h: Handlers, orgId: string) {
  return h.GET(new Request(url(orgId)), { params: Promise.resolve({ orgId }) });
}

/** Run `fn` as `user`, whatever the ambient session is (the racers' door). */
function as<T>(user: SessionUser | null, fn: () => Promise<T>): Promise<T> {
  return sessionStore.run(user, fn);
}

async function makeOrg(name = 'Acme Robotics') {
  const owner = await createTestUser({
    email: `owner-gate-${++seq}@example.com`,
    name: 'Ada Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return { organizationId: workspace.organizationId, owner: { id: owner.id, email: owner.email } };
}

async function makeStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+gate-${role}-${++seq}@moooon.net` });
  await adminDb.user.update({
    where: { id: user.id },
    data: { platformRole: role, emailVerified: true },
  });
  const session = { id: user.id, email: user.email };
  // The principal the console resolves for this session — the REAL gate.
  const principal = await as(session, () => requirePlatformStaff('support'));
  return { session, principal };
}

const FULL_ANSWERS = {
  cardsPerDay: 40,
  parallelAgents: 8,
  agentPath: 'both',
  autonomy: 'autonomous_lead',
  startWhen: 'within_quarter',
  teamSize: 'size_51_200',
  contact: 'buyer@acme.example',
  note: 'We want Motir to run our three product repositories overnight.',
} as const;

async function openRows(organizationId: string) {
  return adminDb.enterpriseRequest.findMany({
    where: { organizationId, status: { in: ['new', 'contacted', 'offer_sent'] } },
  });
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  signedIn = null;
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the writer → consumer seams ──────────────────────────────────────────────

/** The org's folded words for each of staff's states (`billingMappers.ORG_STATUS`). */
const ORG_WORD = {
  new: 'received',
  contacted: 'in_conversation',
  offer_sent: 'offer_sent',
  won: 'closed',
  lost: 'closed',
} as const;

/**
 * Resolve a URL PATH against the app router's tree the way Next does: route
 * groups `(x)` add no segment, `[param]` matches one segment. Returns the
 * matched `page.tsx` (relative to the repo) and its params, or null.
 */
type ResolvedRoute = { page: string; params: Record<string, string> };

function resolveAppRoute(pathname: string): ResolvedRoute | null {
  const segments = pathname.split('/').filter(Boolean);
  function walk(dir: string, rest: string[], params: Record<string, string>): ResolvedRoute | null {
    const entries = readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
    // A route group is transparent: try it without consuming a segment.
    for (const group of entries.filter((e) => /^\(.+\)$/.test(e))) {
      const hit = walk(join(dir, group), rest, params);
      if (hit) return hit;
    }
    if (rest.length === 0) {
      const page = join(dir, 'page.tsx');
      return existsSync(page) ? { page: relative(ROOT, page), params } : null;
    }
    const [head, ...tail] = rest;
    if (entries.includes(head!)) {
      const hit = walk(join(dir, head!), tail, params);
      if (hit) return hit;
    }
    for (const dyn of entries.filter((e) => /^\[[^.\]]+\]$/.test(e))) {
      const hit = walk(join(dir, dyn), tail, { ...params, [dyn.slice(1, -1)]: head! });
      if (hit) return hit;
    }
    return null;
  }
  return walk(join(ROOT, 'app'), segments, {});
}

describe('the seams (writer → consumer)', () => {
  it('a request created through the org route is the row the console lists — both DTOs agree on id, state and needs', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('operator');

    const res = await as(owner, () => postVia(ROUTE, organizationId, FULL_ANSWERS));
    expect(res.status).toBe(201);
    const orgDto = (await res.json()) as EnterpriseRequestDTO;

    const page = await as(staff, () => platformEnterpriseRequestService.list(principal));
    const row = page.requests.find((r) => r.id === orgDto.id);
    expect(row).toBeDefined();
    const staffDto = row as PlatformEnterpriseRequestDTO;

    expect(staffDto.organizationId).toBe(organizationId);
    expect(staffDto.organizationName).toBe('Acme Robotics');
    expect(staffDto.requester?.id).toBe(owner.id);
    // The state: staff's real `new` is the org's folded `received`.
    expect(staffDto.status).toBe('new');
    expect(orgDto.status).toBe(ORG_WORD[staffDto.status]);
    // The needs, field by field — what the org sent is what staff read.
    for (const field of [
      'cardsPerDay',
      'parallelAgents',
      'agentPath',
      'autonomy',
      'startWhen',
      'teamSize',
      'contact',
      'note',
      'createdAt',
    ] as const) {
      expect(staffDto[field], field).toEqual(orgDto[field]);
    }

    // And the detail read agrees with the list row.
    const detail = await as(staff, () =>
      platformEnterpriseRequestService.get(principal, orgDto.id),
    );
    expect(detail.request).toEqual(staffDto);
    expect(detail.moves).toEqual(['contacted', 'lost']);
  });

  it("the staff email's link path resolves to the console's detail route, for this request", async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('support');

    const created = (await (
      await as(owner, () => postVia(ROUTE, organizationId, FULL_ANSWERS))
    ).json()) as EnterpriseRequestDTO;

    // The REAL emit path: `sendEvent` wrote the queued `email.send` event.
    const events = await adminDb.jobEvent.findMany({
      where: {
        name: 'email.send',
        idempotencyKey: { startsWith: `enterprise-request:${created.id}:` },
      },
    });
    expect(events).toHaveLength(1);
    const event = events[0]!.data as unknown as {
      template: string;
      to: string;
      workspaceId: string | null;
      data: Parameters<typeof enterpriseRequestReceivedEmail>[0];
    };
    const data = event.data;
    expect(event.workspaceId).toBeNull();
    expect(event.template).toBe('enterprise-request-received');
    expect(event.to).toBe(staff.email);

    const link = new URL(data.requestUrl);
    expect(link.origin).toBe('https://app.test');
    const route = resolveAppRoute(link.pathname);
    expect(route).toEqual({
      page: join('app', '(admin)', 'admin', 'enterprise-requests', '[id]', 'page.tsx'),
      params: { id: created.id },
    });

    // The param the route hands its page reads this very request.
    const detail = await as(staff, () =>
      platformEnterpriseRequestService.get(principal, route!.params['id']!),
    );
    expect(detail.request.id).toBe(created.id);

    // And the rendered email carries that link verbatim (text and html).
    const email = await enterpriseRequestReceivedEmail(data);
    expect(email.text).toContain(data.requestUrl);
    expect(email.html).toContain(data.requestUrl);
  });

  it('the route resolver itself refuses a path with no page (so the seam above can fail)', () => {
    expect(resolveAppRoute('/admin/enterprise-requests/abc/extra')).toBeNull();
    expect(resolveAppRoute('/admin/enterprise-request/abc')).toBeNull();
    expect(resolveAppRoute('/admin/enterprise-requests')?.page).toBe(
      join('app', '(admin)', 'admin', 'enterprise-requests', 'page.tsx'),
    );
  });

  it('a console transition to won makes the org GET return null, and a new POST succeed', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('operator');

    const first = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'First ask.' }))
    ).json()) as EnterpriseRequestDTO;

    // While it is open the org reads it back, and a second ask is refused.
    expect(await (await as(owner, () => getVia(ROUTE, organizationId))).json()).toEqual(first);
    const twice = await as(owner, () => postVia(ROUTE, organizationId, { note: 'Again.' }));
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({
      code: 'ENTERPRISE_REQUEST_OPEN',
      openRequestId: first.id,
    });

    // Staff walk it to won through the console's service — the server
    // action's one call (its transport is pinned in its own suite).
    for (const [from, to] of [
      ['new', 'contacted'],
      ['contacted', 'offer_sent'],
      ['offer_sent', 'won'],
    ] as const) {
      await as(staff, () =>
        platformEnterpriseRequestService.transition(principal, first.id, {
          organizationId,
          from,
          to,
        }),
      );
      // Each step the org sees, in its own words.
      const seen = await (await as(owner, () => getVia(ROUTE, organizationId))).json();
      expect(seen === null ? 'closed' : seen.status).toBe(ORG_WORD[to]);
    }

    const after = await as(owner, () => getVia(ROUTE, organizationId));
    expect(after.status).toBe(200);
    expect(await after.json()).toBeNull();

    const again = await as(owner, () => postVia(ROUTE, organizationId, { note: 'Second ask.' }));
    expect(again.status).toBe(201);
    const second = (await again.json()) as EnterpriseRequestDTO;
    expect(second.id).not.toBe(first.id);
    expect(await (await as(owner, () => getVia(ROUTE, organizationId))).json()).toEqual(second);

    // The console's History shows the three moves; the closed one is read-only.
    const detail = await as(staff, () => platformEnterpriseRequestService.get(principal, first.id));
    expect(detail.request.status).toBe('won');
    expect(detail.request.closedAt).not.toBeNull();
    expect(detail.moves).toEqual([]);
    expect(detail.history.map((m) => `${m.from}→${m.to}`)).toEqual([
      'new→contacted',
      'contacted→offer_sent',
      'offer_sent→won',
    ]);
  });
});

// ── concurrency, end to end ──────────────────────────────────────────────────

describe('the race: a new POST against staff closing the previous open request', () => {
  it('either order ends with at most one open request, and every loser gets its typed refusal', async () => {
    const { session: staff, principal } = await makeStaff('operator');
    const outcomes = new Set<string>();

    for (let round = 0; round < 6; round++) {
      const { organizationId, owner } = await makeOrg(`Race ${round}`);
      const previous = (await (
        await as(owner, () => postVia(ROUTE, organizationId, { note: `Round ${round}, first.` }))
      ).json()) as EnterpriseRequestDTO;

      // Real concurrency: both doors in flight at once, on separate connections.
      const [posted, closed] = await Promise.allSettled([
        as(owner, () => postVia(ROUTE, organizationId, { note: `Round ${round}, second.` })),
        as(staff, () =>
          platformEnterpriseRequestService.transition(principal, previous.id, {
            organizationId,
            from: 'new',
            to: 'lost',
          }),
        ),
      ]);

      // The staff move has no rival for its row, so it always applies.
      expect(closed.status, `round ${round}: the close`).toBe('fulfilled');
      expect(posted.status).toBe('fulfilled');
      const res = (posted as PromiseFulfilledResult<Response>).value;
      const body = await res.json();

      const open = await openRows(organizationId);
      const prev = await adminDb.enterpriseRequest.findUniqueOrThrow({
        where: { id: previous.id },
      });
      expect(prev.status).toBe('lost');
      expect(prev.closedAt).not.toBeNull();
      // THE INVARIANT, in every order.
      expect(open.length).toBeLessThanOrEqual(1);

      if (res.status === 201) {
        // The close committed first: the new request stands, and is the open one.
        outcomes.add('post-after-close');
        expect(open.map((r) => r.id)).toEqual([body.id]);
      } else {
        // The POST met the still-open request: it is the loser, refused by
        // type — naming the request that blocked it, or null when that one
        // closed before the refusal re-read it — and nothing was written.
        outcomes.add('post-refused');
        expect(res.status).toBe(409);
        expect(body.code).toBe('ENTERPRISE_REQUEST_OPEN');
        expect([previous.id, null]).toContain(body.openRequestId);
        expect(open).toEqual([]);
        expect(await adminDb.enterpriseRequest.count({ where: { organizationId } })).toBe(1);
      }
      // Exactly one move recorded per applied transition — never a phantom.
      const moves = (await auditRows()).filter(
        (r) =>
          r.action === 'enterprise_request.transition' &&
          (r.metadata as { requestId?: string }).requestId === previous.id,
      );
      expect(moves).toHaveLength(1);
    }

    // Every round ended in one of the two legitimate outcomes (asserted above);
    // which ones a given run sees is the scheduler's business, not the test's.
    expect([...outcomes].every((o) => ['post-after-close', 'post-refused'].includes(o))).toBe(true);
  });

  it('two staff closing the same request at once: one applies, the loser gets STALE naming the winner', async () => {
    const { organizationId, owner } = await makeOrg();
    const a = await makeStaff('operator');
    const b = await makeStaff('superadmin');
    const req = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'Race me.' }))
    ).json()) as EnterpriseRequestDTO;

    const move = (who: typeof a, to: 'lost' | 'contacted') =>
      as(who.session, () =>
        platformEnterpriseRequestService.transition(who.principal, req.id, {
          organizationId,
          from: 'new',
          to,
        }),
      );
    const results = await Promise.allSettled([move(a, 'lost'), move(b, 'contacted')]);

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const final = await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } });
    const refusal = losers[0]!.reason as InstanceType<typeof EnterpriseRequestStaleError>;
    expect(refusal).toBeInstanceOf(EnterpriseRequestStaleError);
    expect(refusal.currentStatus).toBe(final.status);
    const winnerEmail = final.status === 'lost' ? a.session.email : b.session.email;
    expect(refusal.movedBy?.email).toBe(winnerEmail);
    // One move recorded — the loser's audit row rolled back with it.
    const moves = (await auditRows()).filter((r) => r.action === 'enterprise_request.transition');
    expect(moves).toHaveLength(1);
    expect((await openRows(organizationId)).length).toBeLessThanOrEqual(1);
  });
});

// ── guard: cross-tenant ──────────────────────────────────────────────────────

interface TenantScenario {
  /** An org the actor is NOT a member of, holding an open request. */
  foreignOrgId: string;
  foreignRequestId: string;
  /** The actor's OWN org. */
  ownOrgId: string;
  /** Owner of `ownOrgId`, a stranger to `foreignOrgId`. */
  stranger: SessionUser;
  /** Owner of `ownOrgId` too, but a plain MEMBER of `foreignOrgId`. */
  memberOfForeign: SessionUser;
}

/**
 * Every way the org route could read or create across a tenant line, as a list
 * of violations — empty when the route holds. The `orgId` in the path is the
 * only scope: a non-member is a 404 (no existence leak), a member without
 * `manageBilling` a 403, and a body naming another org is refused, not obeyed.
 */
async function crossTenantViolations(h: Handlers, s: TenantScenario): Promise<string[]> {
  const v: string[] = [];
  const foreignCount = () =>
    adminDb.enterpriseRequest.count({ where: { organizationId: s.foreignOrgId } });
  const before = await foreignCount();

  const leaks = async (label: string, res: Response, expected: number[]) => {
    const text = await res.text();
    if (!expected.includes(res.status)) v.push(`${label}: status ${res.status}, want ${expected}`);
    if (text.includes(s.foreignRequestId)) v.push(`${label}: body carries the foreign request id`);
  };

  await leaks('stranger GET', await as(s.stranger, () => getVia(h, s.foreignOrgId)), [404]);
  await leaks(
    'stranger POST',
    await as(s.stranger, () => postVia(h, s.foreignOrgId, { note: 'cross' })),
    [404],
  );
  await leaks('member GET', await as(s.memberOfForeign, () => getVia(h, s.foreignOrgId)), [403]);
  await leaks(
    'member POST',
    await as(s.memberOfForeign, () => postVia(h, s.foreignOrgId, { note: 'cross' })),
    [403],
  );
  // Its OWN org reads its own (nothing open) — never the foreign row.
  await leaks('own GET', await as(s.stranger, () => getVia(h, s.ownOrgId)), [200]);
  // A body that names the foreign org is refused by the strict schema.
  await leaks(
    'own POST naming another org',
    await as(s.stranger, () =>
      postVia(h, s.ownOrgId, { note: 'cross', organizationId: s.foreignOrgId }),
    ),
    [400],
  );

  if ((await foreignCount()) !== before) v.push('a request was created in the foreign org');
  return v;
}

async function tenantScenario(): Promise<TenantScenario> {
  const foreign = await makeOrg('Globex');
  const own = await makeOrg('Initech');
  const second = await makeOrg('Hooli');
  await organizationsService.addMember({
    organizationId: foreign.organizationId,
    userId: second.owner.id,
    role: 'member',
    actorUserId: foreign.owner.id,
  });
  const foreignReq = (await (
    await as(foreign.owner, () => postVia(ROUTE, foreign.organizationId, { note: 'Ours.' }))
  ).json()) as EnterpriseRequestDTO;
  return {
    foreignOrgId: foreign.organizationId,
    foreignRequestId: foreignReq.id,
    ownOrgId: own.organizationId,
    stranger: own.owner,
    memberOfForeign: second.owner,
  };
}

describe('guard: cross-tenant', () => {
  it('passes on the shipped route — no read or create crosses an org', async () => {
    const s = await tenantScenario();
    expect(await crossTenantViolations(ROUTE, s)).toEqual([]);
  });

  it('FAILS on a planted route that scopes by the row rather than the membership (fixture)', async () => {
    const s = await tenantScenario();
    // A planted GET that trusts the path's orgId with no membership check — it
    // reads the org's open request through the trusted client — and a planted
    // POST that writes wherever it is told.
    const leaky: Handlers = {
      GET: async (_req, { params }) => {
        const { orgId } = await params;
        const row = await adminDb.enterpriseRequest.findFirst({
          where: { organizationId: orgId, status: 'new' },
        });
        return Response.json(row ? { id: row.id } : null);
      },
      POST: async (req, { params }) => {
        const { orgId } = await params;
        const body = (await req.json()) as { note: string; organizationId?: string };
        const row = await adminDb.enterpriseRequest.create({
          data: {
            organizationId: body.organizationId ?? orgId,
            // Closed, so the planted write is not stopped by the one-open index.
            status: 'lost',
            contact: 'x@x.test',
            note: body.note,
          },
        });
        return Response.json({ id: row.id }, { status: 201 });
      },
    };
    const violations = await crossTenantViolations(leaky, s);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^stranger GET: status 200/),
        'stranger GET: body carries the foreign request id',
        expect.stringMatching(/^member POST: status 201/),
        'a request was created in the foreign org',
      ]),
    );
  });
});

// ── guard: audit ─────────────────────────────────────────────────────────────

type StaffPath = {
  label: string;
  run: () => Promise<unknown>;
  action: string;
  requestId: string | null;
};

/**
 * Run each staff path and report the ones that left no audit row of the
 * expected action naming the request. Every staff read and move of a request
 * must write one (ADR `platform-staff-auth.md` §7) — the row IS the evidence.
 */
async function unauditedStaffPaths(paths: StaffPath[]): Promise<string[]> {
  const missing: string[] = [];
  for (const p of paths) {
    const before = (await auditRows()).length;
    await p.run();
    const added = (await auditRows()).slice(before);
    const hit = added.some(
      (r) =>
        r.action === p.action &&
        (p.requestId === null ||
          (r.metadata as { requestId?: string } | null)?.requestId === p.requestId),
    );
    if (!hit) missing.push(p.label);
  }
  return missing;
}

/**
 * The same rule read STATICALLY from a service's source: every
 * `enterpriseRequestRepository.` call inside an exported method sits inside a
 * `withPlatformRead(` callback, and no other context opener appears. Returns
 * the offending method names.
 */
function staticAuditViolations(source: string): string[] {
  const body = source.slice(source.indexOf('export const platformEnterpriseRequestService'));
  const methods = [...body.matchAll(/\n {2}async (\w+)\(/g)];
  const offenders: string[] = [];
  methods.forEach((m, i) => {
    const text = body.slice(m.index, methods[i + 1]?.index ?? body.length);
    const opener = text.indexOf('withPlatformRead(');
    const firstRepo = text.indexOf('enterpriseRequestRepository.');
    const otherContext =
      /\b(withOrgContext|withSystemContext|withSystemAdmin|db\.\$transaction|dbRead\.|\bdb\.)/.test(
        text,
      );
    if (firstRepo !== -1 && (opener === -1 || firstRepo < opener || otherContext)) {
      offenders.push(m[1]!);
    }
  });
  return offenders;
}

describe('guard: audit', () => {
  it('passes on the shipped console: every read and move writes its row', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('operator');
    const req = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'Audit me.' }))
    ).json()) as EnterpriseRequestDTO;

    const paths: StaffPath[] = [
      {
        label: 'list',
        run: () => as(staff, () => platformEnterpriseRequestService.list(principal)),
        action: 'estate.read',
        requestId: null,
      },
      {
        label: 'list (action)',
        run: () => as(staff, () => listEnterpriseRequestsAction('all', null)),
        action: 'estate.read',
        requestId: null,
      },
      {
        label: 'get',
        run: () => as(staff, () => platformEnterpriseRequestService.get(principal, req.id)),
        action: 'estate.read',
        requestId: req.id,
      },
      {
        label: 'get (action)',
        run: () => as(staff, () => getEnterpriseRequestAction(req.id)),
        action: 'estate.read',
        requestId: req.id,
      },
      {
        label: 'transition',
        run: () =>
          as(staff, () =>
            platformEnterpriseRequestService.transition(principal, req.id, {
              organizationId,
              from: 'new',
              to: 'contacted',
            }),
          ),
        action: 'enterprise_request.transition',
        requestId: req.id,
      },
    ];
    expect(await unauditedStaffPaths(paths)).toEqual([]);

    // The move's row names the org it targets and the edge it applied.
    const move = (await auditRows()).find((r) => r.action === 'enterprise_request.transition')!;
    expect(move).toMatchObject({ targetKind: 'organization', targetId: organizationId });
    expect(move.metadata).toMatchObject({ requestId: req.id, from: 'new', to: 'contacted' });
    expect(move.actorUserId).toBe(principal.userId);
  });

  it('a refused move leaves NO audit row — the row rolls back with it', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('operator');
    const req = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'x' }))
    ).json()) as EnterpriseRequestDTO;
    const other = await makeOrg('Elsewhere');

    const before = (await auditRows()).length;
    await expect(
      as(staff, () =>
        platformEnterpriseRequestService.transition(principal, req.id, {
          organizationId: other.organizationId,
          from: 'new',
          to: 'contacted',
        }),
      ),
    ).rejects.toThrow();
    expect((await auditRows()).length).toBe(before);
    expect(
      (await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
    ).toBe('new');
  });

  it('FAILS on a planted service path that reads a request without the audit (fixture)', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('operator');
    const req = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'x' }))
    ).json()) as EnterpriseRequestDTO;

    const planted: StaffPath = {
      label: 'planted get',
      // Reads the row under an ORG context — the RLS arm lets it through, and
      // nothing records that staff looked.
      run: () =>
        withOrgContext({ userId: owner.id, organizationId }, (tx) =>
          enterpriseRequestRepository.findById(req.id, tx),
        ),
      action: 'estate.read',
      requestId: req.id,
    };
    const real: StaffPath = {
      label: 'get',
      run: () => as(staff, () => platformEnterpriseRequestService.get(principal, req.id)),
      action: 'estate.read',
      requestId: req.id,
    };
    expect(await unauditedStaffPaths([real, planted])).toEqual(['planted get']);
  });

  it('statically: every repository call in the console service sits inside withPlatformRead', () => {
    const source = readFileSync(
      join(ROOT, 'lib/services/platformEnterpriseRequestService.ts'),
      'utf8',
    );
    expect(staticAuditViolations(source)).toEqual([]);
    // The scanner sees all three methods (so a pass is not vacuous).
    expect([...source.matchAll(/\n {2}async (\w+)\(/g)].map((m) => m[1])).toEqual([
      'list',
      'get',
      'transition',
    ]);

    // Planted (fixture): a method that reads before — or without — the audited context.
    const planted = `${source}
export const platformEnterpriseRequestServiceX = 1;`.replace(
      'export const platformEnterpriseRequestService = {',
      `export const platformEnterpriseRequestService = {
  async peek(id: string) {
    return withOrgContext(scope, (tx) => enterpriseRequestRepository.findById(id, tx));
  },`,
    );
    expect(staticAuditViolations(planted)).toEqual(['peek']);
  });
});

// ── guard: no price ──────────────────────────────────────────────────────────

/** A currency figure in a string: a symbol beside a number, or a number beside a currency word. */
const CURRENCY_FIGURE =
  /(?:[$€£¥₹]|US\$|CA\$|A\$)\s?\d|\d[\d,.]*\s?(?:(?:USD|EUR|GBP|CNY|JPY|RMB|dollars?|euros?)\b|元|美元|欧元)/i;
/** A DTO key that would carry a price. */
const PRICE_KEY = /price|amount|cost|currency|fee|discount|invoice/i;

function priceViolations(surfaces: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (label: string, value: unknown) => {
    if (typeof value === 'string') {
      const m = CURRENCY_FIGURE.exec(value);
      if (m) out.push(`${label}: "${m[0]}"`);
    } else if (typeof value === 'number' || value === null || typeof value === 'boolean') {
      // A bare number is a count, not a price — its KEY says which.
    } else if (Array.isArray(value)) {
      value.forEach((x, i) => visit(`${label}[${i}]`, x));
    } else if (typeof value === 'object' && value !== undefined) {
      for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
        if (PRICE_KEY.test(k)) out.push(`${label}.${k}: a price-shaped key`);
        visit(`${label}.${k}`, x);
      }
    }
  };
  for (const [label, value] of Object.entries(surfaces)) visit(label, value);
  return out;
}

/** The story's own surface files — what it added, read as text. */
const SURFACE_FILES = [
  'lib/dto/platformEnterpriseRequest.ts',
  'lib/emailTemplates/enterpriseRequestReceived.tsx',
  'lib/billing/enterpriseRequestClient.ts',
  'lib/services/enterpriseRequestService.ts',
  'lib/services/platformEnterpriseRequestService.ts',
  'app/(authed)/settings/organization/billing/_components/ContactSalesDialog.tsx',
  'app/(admin)/admin/enterprise-requests/page.tsx',
  'app/(admin)/admin/enterprise-requests/[id]/page.tsx',
  ...readdirSync(join(ROOT, 'app/(admin)/admin/enterprise-requests/_components')).map(
    (f) => `app/(admin)/admin/enterprise-requests/_components/${f}`,
  ),
];

describe('guard: no price', () => {
  it('passes on the shipped surface: DTOs, the email, the catalogues and the source carry no currency figure', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('operator');
    const orgDto = (await (
      await as(owner, () => postVia(ROUTE, organizationId, FULL_ANSWERS))
    ).json()) as EnterpriseRequestDTO;
    const page = await as(staff, () => platformEnterpriseRequestService.list(principal));
    const detail = await as(staff, () =>
      platformEnterpriseRequestService.get(principal, orgDto.id),
    );
    const event = await adminDb.jobEvent.findFirstOrThrow({
      where: { idempotencyKey: { startsWith: `enterprise-request:${orgDto.id}:` } },
    });
    const data = (
      event.data as unknown as { data: Parameters<typeof enterpriseRequestReceivedEmail>[0] }
    ).data;
    const emails = await Promise.all(
      (['en', 'zh'] as const).map((locale) => enterpriseRequestReceivedEmail({ ...data, locale })),
    );

    const en = (await import('@/messages/en.json')).default as Record<
      string,
      Record<string, unknown>
    >;
    const zh = (await import('@/messages/zh.json')).default as Record<
      string,
      Record<string, unknown>
    >;
    const catalogue = (m: typeof en) => ({
      contactSales: (m['billing'] as Record<string, unknown>)['contactSales'],
      console: (m['platformAdmin'] as Record<string, unknown>)['enterpriseRequests'],
      email: (m['email'] as Record<string, unknown>)['enterpriseRequestReceived'],
    });

    const surfaces: Record<string, unknown> = {
      orgDto,
      staffPage: page,
      staffDetail: detail,
      emailEvent: data,
      emails,
      catalogueEn: catalogue(en),
      catalogueZh: catalogue(zh),
      ...Object.fromEntries(SURFACE_FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')])),
    };
    expect(priceViolations(surfaces)).toEqual([]);
    // Not vacuous: the surface really holds the copy it claims to scan.
    expect(SURFACE_FILES.length).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(surfaces['catalogueEn'])).toContain('Contact sales');
  });

  it('FAILS on planted prices — in a string, a catalogue, an email and a DTO key (fixture)', () => {
    const violations = priceViolations({
      clean: 'Work items a day: about 40 · 8 agents in parallel',
      copy: 'Enterprise starts at $2,000/month.',
      zh: '每月 9999 元起',
      email: { text: 'Your offer: 1,200 USD per seat' },
      dto: { id: 'r1', cardsPerDay: 40, priceCents: 199900 },
    });
    expect(violations).toEqual([
      'copy: "$2"',
      'zh: "9999 元"',
      'email.text: "1,200 USD"',
      'dto.priceCents: a price-shaped key',
    ]);
  });
});

// ── the remaining branches of the story's doors ──────────────────────────────

describe('the doors, at their edges', () => {
  it('the route rethrows an error it does not own (a genuine 500), on both verbs', async () => {
    const { organizationId, owner } = await makeOrg();
    vi.spyOn(enterpriseRequestService, 'create').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(enterpriseRequestService, 'getOpen').mockRejectedValueOnce(new Error('bang'));
    await expect(as(owner, () => postVia(ROUTE, organizationId, { note: 'x' }))).rejects.toThrow(
      'boom',
    );
    await expect(as(owner, () => getVia(ROUTE, organizationId))).rejects.toThrow('bang');
  });

  it("the sender's display name falls back to their email, then to null", async () => {
    const { organizationId, owner } = await makeOrg();
    await adminDb.user.update({ where: { id: owner.id }, data: { name: '' } });
    await makeStaff('support');
    const sent = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'x' }))
    ).json()) as EnterpriseRequestDTO;
    expect(sent.requestedByName).toBe(owner.email);
    // The staff email names them by their email too.
    const event = await adminDb.jobEvent.findFirstOrThrow({
      where: { idempotencyKey: { startsWith: `enterprise-request:${sent.id}:` } },
    });
    expect((event.data as { data: { requesterName: string } }).data.requesterName).toBe(
      owner.email,
    );

    // An account with neither reads as no name at all.
    await adminDb.user.update({ where: { id: owner.id }, data: { email: '' } });
    const open = await enterpriseRequestService.getOpen(
      { userId: owner.id, email: owner.email },
      organizationId,
    );
    expect(open?.requestedByName).toBeNull();
  });

  it('the form context refuses a stranger (404) rather than answering null', async () => {
    const { organizationId } = await makeOrg();
    const stranger = await makeOrg('Elsewhere');
    await expect(
      enterpriseRequestService.getFormContext(
        { userId: stranger.owner.id, email: stranger.owner.email },
        organizationId,
      ),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('the console actions answer NOT_PERMITTED and FAILED as their own codes', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff } = await makeStaff('operator');
    const req = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'x' }))
    ).json()) as EnterpriseRequestDTO;

    // Not staff at all.
    expect(await as(owner, () => getEnterpriseRequestAction(req.id))).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await as(null, () => listEnterpriseRequestsAction(null, null))).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });

    // Anything unexpected is FAILED, logged, never thrown at the page.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(platformEnterpriseRequestService, 'list').mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(platformEnterpriseRequestService, 'get').mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(platformEnterpriseRequestService, 'transition').mockRejectedValueOnce(
      new Error('db down'),
    );
    expect(await as(staff, () => listEnterpriseRequestsAction(null, null))).toEqual({
      ok: false,
      code: 'FAILED',
    });
    expect(await as(staff, () => getEnterpriseRequestAction(req.id))).toEqual({
      ok: false,
      code: 'FAILED',
    });
    expect(
      await as(staff, () =>
        transitionEnterpriseRequestAction(req.id, organizationId, 'new', 'contacted'),
      ),
    ).toEqual({ ok: false, code: 'FAILED' });
    expect(logged).toHaveBeenCalledTimes(3);

    // And the service's own gate refuses a support principal handed to a move.
    const support = await makeStaff('support');
    await expect(
      as(staff, () =>
        platformEnterpriseRequestService.transition(support.principal, req.id, {
          organizationId,
          from: 'new',
          to: 'contacted',
        }),
      ),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('a request whose requester was deleted still lists, with no requester', async () => {
    const { organizationId, owner } = await makeOrg();
    const { session: staff, principal } = await makeStaff('support');
    const req = (await (
      await as(owner, () => postVia(ROUTE, organizationId, { note: 'x' }))
    ).json()) as EnterpriseRequestDTO;
    await adminDb.enterpriseRequest.update({
      where: { id: req.id },
      data: { requestedById: null },
    });
    const page = await as(staff, () =>
      platformEnterpriseRequestService.list(principal, { status: 'all' }),
    );
    expect(page.requests.find((r) => r.id === req.id)?.requester).toBeNull();
    const open = await enterpriseRequestService.getOpen(
      { userId: owner.id, email: owner.email },
      organizationId,
    );
    expect(open?.requestedByName).toBeNull();
  });
});
