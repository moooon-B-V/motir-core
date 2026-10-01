// better-auth 1.7's OAuth provider seeds its `resources` option into
// `oauth_resource` from the plugin's `init` — and `init` runs inside the ONE
// context promise `betterAuth()` builds at module load (MOTIR-7171). Two costs
// follow, neither acceptable on Motir's hot path:
//
//   1. Every process makes a database round-trip the moment `@/lib/auth` is
//      imported, including the anonymous request MOTIR-2453 keeps free of one
//      (`tests/auth/session-request-memo.test.ts`).
//   2. A seed that throws — the database briefly unreachable at boot — REJECTS
//      that promise, and a rejected context is never rebuilt: every auth call
//      in the process fails until it is restarted.
//
// The provider already carries the cure: `getResource` runs the same seed
// lazily, once per process, coalesced, and RETRYING after a failure — written
// for deployments that migrate after init. So `init` is run with the resource
// list hidden, and the first `resource` lookup seeds it instead. Every other
// thing `init` does (its session-delete hooks, the JWT issuer check) is kept.
//
// The list is hidden by swapping it on the plugin's own options object, which
// is the object the seed reads: the provider exposes it as `plugin.options`.

interface ResourceSeedingPlugin {
  options?: { resources?: unknown } | undefined;
  init?: (ctx: never) => unknown;
}

export function seedResourcesLazily<P extends ResourceSeedingPlugin>(plugin: P): P {
  const { init, options } = plugin;
  if (!init || !options) return plugin;
  return {
    ...plugin,
    init: async (ctx: never) => {
      const resources = options.resources;
      options.resources = undefined;
      try {
        return await init(ctx);
      } finally {
        options.resources = resources;
      }
    },
  };
}
