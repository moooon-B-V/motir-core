import { describe, expect, it } from 'vitest';
import { APIError } from 'better-auth/api';
import { mcpOAuthPolicy } from '@/lib/auth/mcpOAuthPolicy';
import { seedResourcesLazily } from '@/lib/auth/lazyResourceSeed';
import { mcpResourceUrl } from '@/lib/oauth/config';

// The OAuth policy's hooks and the lazy resource seed, at the edges a real
// request cannot reach (Story MOTIR-7170 · Subtask MOTIR-7175): a request with no
// query or body at all, an error that is not the plugin's, a provider that is not
// mounted. The paths a real client takes are driven through the real route in
// `tests/integration/oauth/`.

type Hook = (ctx: Record<string, unknown>) => Promise<unknown>;

function hook(index: number): Hook {
  return mcpOAuthPolicy().hooks!.before![index]!.handler as unknown as Hook;
}
const authorizeHook = hook(1);
const consentHook = hook(2);

function context(over: Record<string, unknown> = {}) {
  return {
    baseURL: 'http://localhost:3000/api/auth',
    adapter: { findOne: async () => null },
    getPlugin: () => null,
    ...over,
  };
}

async function redirectOf(run: Promise<unknown>): Promise<URL> {
  const err = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { headers?: Headers; status?: unknown } | null;
  expect(err, 'expected a redirect').toBeTruthy();
  const at = err!.headers?.get('location');
  expect(at, `expected a location, got ${String(err!.status)}`).toBeTruthy();
  return new URL(at!, 'http://localhost:3000');
}

describe('the authorize hook, at its edges', () => {
  it('a request with no query at all is an unknown client', async () => {
    const to = await redirectOf(authorizeHook({ context: context() }));
    expect(to.pathname).toBe('/oauth/error');
    expect(to.searchParams.get('error')).toBe('invalid_client');
  });

  it('a URL client_id with no provider mounted resolves to no client', async () => {
    const to = await redirectOf(
      authorizeHook({
        query: { client_id: 'https://claude.ai/oauth/x', redirect_uri: 'https://claude.ai/cb' },
        context: context(),
      }),
    );
    expect(to.searchParams.get('error')).toBe('invalid_client');
  });

  it('a registered client with no redirect list matches no redirect', async () => {
    const to = await redirectOf(
      authorizeHook({
        query: { client_id: 'mcp_1', redirect_uri: 'https://claude.ai/cb' },
        context: context({ adapter: { findOne: async () => ({ clientId: 'mcp_1' }) } }),
      }),
    );
    expect(to.searchParams.get('error')).toBe('invalid_redirect');
  });

  it('an error that is not the plugin’s is rethrown, never turned into a refusal page', async () => {
    const boom = new Error('database unavailable');
    await expect(
      authorizeHook({
        query: { client_id: 'mcp_1' },
        context: context({
          adapter: {
            findOne: async () => {
              throw boom;
            },
          },
        }),
      }),
    ).rejects.toBe(boom);
  });

  it('a request naming the MCP resource and a listed redirect passes through', async () => {
    await expect(
      authorizeHook({
        query: {
          client_id: 'mcp_1',
          redirect_uri: 'https://claude.ai/cb',
          resource: mcpResourceUrl(),
        },
        context: context({
          adapter: {
            findOne: async () => ({ clientId: 'mcp_1', redirectUris: ['https://claude.ai/cb'] }),
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the consent hook, at its edges', () => {
  it('a request with no body records nothing and is let through', async () => {
    await expect(consentHook({ context: context() })).resolves.toBeUndefined();
  });

  it('an accept outside the Motir consent screen is refused', async () => {
    await expect(
      consentHook({ body: { accept: true }, context: context() }),
    ).rejects.toBeInstanceOf(APIError);
  });
});

describe('seedResourcesLazily', () => {
  it('leaves a plugin with no init, or no options, exactly as it was', () => {
    const bare = { id: 'x', options: undefined };
    expect(seedResourcesLazily(bare)).toBe(bare);
    const noOptions = { init: () => undefined };
    expect(seedResourcesLazily(noOptions)).toBe(noOptions);
  });

  it('hides the resource list from init, and restores it even when init throws', async () => {
    const options = { resources: ['r'] as unknown };
    let seen: unknown = 'unset';
    const ok = seedResourcesLazily({
      options,
      init: () => {
        seen = options.resources;
        return 'ok';
      },
    });
    expect(await (ok.init as (ctx: never) => unknown)({} as never)).toBe('ok');
    expect(seen).toBeUndefined();
    expect(options.resources).toEqual(['r']);

    const failing = seedResourcesLazily({
      options,
      init: () => {
        throw new Error('init failed');
      },
    });
    await expect((failing.init as (ctx: never) => Promise<unknown>)({} as never)).rejects.toThrow(
      'init failed',
    );
    expect(options.resources).toEqual(['r']);
  });
});
