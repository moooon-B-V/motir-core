import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createToken,
  revokeToken,
} from '@/app/(authed)/settings/account/_components/apiTokensClient';

// The tokens pane's fetch layer (Story MOTIR-2572 · Subtask MOTIR-2580).
//
// Thin, and worth testing anyway for one reason: it is where the modal's field
// NAMES become the wire, and where a route's typed `code` becomes something the
// island can branch on. A rename on either side passes every other test in the
// story and fails here.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('createToken', () => {
  it('POSTs the grant and its bound project as JSON, and returns the secret', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'mtr_x', dto: { id: 't' } }),
    });
    const result = await createToken({
      label: 'CI',
      expiresInDays: 90,
      workspaceId: 'ws-1',
      permissions: ['project:browse', 'work_item:edit'],
      projectId: 'p-1',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/me/api-tokens');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      label: 'CI',
      expiresInDays: 90,
      workspaceId: 'ws-1',
      permissions: ['project:browse', 'work_item:edit'],
      projectId: 'p-1',
    });
    expect(result.token).toBe('mtr_x');
  });

  it('carries "never" through as a null expiry rather than dropping the field', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ token: 'x', dto: {} }) });
    await createToken({
      label: 'Forever',
      expiresInDays: null,
      workspaceId: 'ws-1',
      permissions: ['project:browse'],
      projectId: 'p-1',
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect('expiresInDays' in body).toBe(true);
    expect(body.expiresInDays).toBeNull();
  });

  it('raises the route’s typed code, so the island can branch on it', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'API_TOKEN_INVALID_BINDING' }),
    });
    await expect(
      createToken({
        label: 'Bad',
        expiresInDays: 30,
        workspaceId: 'ws-1',
        permissions: [],
        projectId: 'p-1',
      }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'API_TOKEN_INVALID_BINDING' });
  });

  it('falls back to UNKNOWN when the error body is not JSON at all', async () => {
    // A 502 from in front of the app returns HTML. The island must still get an
    // ApiError it can render, not a JSON parse error thrown from the catch path.
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    const err = await createToken({
      label: 'Gateway',
      expiresInDays: 30,
      workspaceId: 'ws-1',
      permissions: ['project:browse'],
      projectId: 'p-1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNKNOWN');
  });
});

describe('revokeToken', () => {
  it('DELETEs the encoded id and returns the updated row', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: { id: 'tok 1', revokedAt: '2026-08-10T00:00:00.000Z' } }),
    });
    const row = await revokeToken('tok 1');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/me/api-tokens/tok%201');
    expect(fetchMock.mock.calls[0]![1]).toEqual({ method: 'DELETE' });
    // The response is UNWRAPPED — the island stores the row, not the envelope.
    expect(row).toMatchObject({ id: 'tok 1' });
  });

  it('raises the typed code on refusal', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'API_TOKEN_NOT_FOUND' }) });
    await expect(revokeToken('nope')).rejects.toMatchObject({ code: 'API_TOKEN_NOT_FOUND' });
  });
});
