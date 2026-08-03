import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mintCodeGraphRunCredential, MOTIR_AI_REQUEST_TIMEOUT_MS } from '@/lib/ai/motirAiClient';
import {
  MotirAiConfigError,
  MotirAiUnavailableError,
  MotirAiBadRequestError,
} from '@/lib/ai/errors';

// The RUN-SCOPED CREDENTIAL mint (Story MOTIR-1981 · MOTIR-1989; motir-ai's half
// is MOTIR-1986) — `docs/decisions/code-graph-index-fleet.md` §4, "isolation
// comes from credential scope, not org count".
//
// What these tests protect is narrow and load-bearing: motir-core requests the
// credential, treats it as OPAQUE, and treats a failure to get one as FATAL.
// Every arm below exists because the alternative behaviour would be a silent
// widening of what a fleet container holds.

const INPUT = {
  coreOrganizationId: 'org_1',
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  repoRef: 'moooon/motir-core',
  runId: 'run_abc',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mintCodeGraphRunCredential', () => {
  it('POSTs the tenant triple + repoRef + runId and returns { credential, expiresAt }', async () => {
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credential: 'mrc1.payload.sig', expiresAt }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintCodeGraphRunCredential(INPUT)).resolves.toEqual({
      credential: 'mrc1.payload.sig',
      expiresAt,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/code-graph/run-credential');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(INPUT);
  });

  it('carries the SERVICE token — this is the one call in the flow that may', async () => {
    // The mint is `serviceAuth`-gated because motir-core is the caller. The
    // container-facing routes deliberately REFUSE this token; that refusal is
    // what turns a misconfigured dispatch into a loud failure instead of a
    // container holding a credential valid for every project.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credential: 'mrc1.a.b', expiresAt: new Date().toISOString() }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    await mintCodeGraphRunCredential(INPUT);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer svc-token' });
  });

  it('omits ttlSeconds when not given, and passes it through when it is', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credential: 'mrc1.a.b', expiresAt: new Date().toISOString() }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    const bodyOfCall = (index: number): Record<string, unknown> => {
      const [, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)) as Record<string, unknown>;
    };

    await mintCodeGraphRunCredential(INPUT);
    expect(bodyOfCall(0)).not.toHaveProperty('ttlSeconds');

    await mintCodeGraphRunCredential({ ...INPUT, ttlSeconds: 900 });
    expect(bodyOfCall(1)).toMatchObject({ ttlSeconds: 900 });
  });

  it('takes the ORDINARY deadline, never the index upload’s long one', async () => {
    // It is a few hundred bytes of JSON. Borrowing the 180s tarball deadline
    // would let a hung mint eat most of the boot step's budget.
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        seenSignal = init.signal as AbortSignal;
        return jsonResponse({ credential: 'mrc1.a.b', expiresAt: new Date().toISOString() }, 201);
      }),
    );
    await mintCodeGraphRunCredential(INPUT);
    expect(seenSignal).toBeDefined();
    expect(MOTIR_AI_REQUEST_TIMEOUT_MS).toBeLessThan(180_000);
  });

  it('maps a problem+json refusal to the typed error — never a falsy credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ code: 'invalid_request', detail: 'repoRef is required' }, 400),
      ),
    );
    await expect(mintCodeGraphRunCredential(INPUT)).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('THROWS on a 2xx whose body carries no credential', async () => {
    // ⚠️ The arm that matters most. A cast would return `{ credential: undefined }`
    // and the caller would put an empty MOTIR_INDEX_RUN_CREDENTIAL in a container
    // spec; the container then exits CONFIG, blaming the dispatch for a defect in
    // the response, one process away from anything that could see it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ expiresAt: 'x' }, 201)),
    );
    await expect(mintCodeGraphRunCredential(INPUT)).rejects.toBeInstanceOf(MotirAiUnavailableError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ credential: '' }, 201)),
    );
    await expect(mintCodeGraphRunCredential(INPUT)).rejects.toThrow(/no credential/);
  });

  it('THROWS on a 2xx whose body carries no expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ credential: 'mrc1.a.b' }, 201)),
    );
    await expect(mintCodeGraphRunCredential(INPUT)).rejects.toThrow(/no expiry/);
  });

  it('maps a transport failure to MotirAiUnavailableError (the retry budget absorbs it)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(mintCodeGraphRunCredential(INPUT)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('fails fast when motir-ai is not configured at all', async () => {
    delete process.env['MOTIR_AI_SERVICE_TOKEN'];
    await expect(mintCodeGraphRunCredential(INPUT)).rejects.toBeInstanceOf(MotirAiConfigError);
  });

  it('treats the credential as OPAQUE — it is returned verbatim, whatever its shape', async () => {
    // motir-ai signs it and motir-ai verifies it. If motir-core ever parsed the
    // token it would grow a second, drifting understanding of a format it does
    // not own — so a value that looks nothing like today's `mrc1.…` must still
    // pass through untouched.
    const weird = 'v9.something-else-entirely.++//==';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ credential: weird, expiresAt: 'later' }, 201)),
    );
    await expect(mintCodeGraphRunCredential(INPUT)).resolves.toEqual({
      credential: weird,
      expiresAt: 'later',
    });
  });
});
