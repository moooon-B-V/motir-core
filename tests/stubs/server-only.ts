// Empty stub for the `server-only` marker package under Vitest.
//
// `import 'server-only'` is a build-time guard: Next.js resolves it (to a no-op
// in a Server Component, to a throw in a Client Component bundle) so a
// server-only module can never be shipped to the browser. Plain-node Vitest has
// no such resolver, so importing a server-only module (e.g. lib/ai/motirAiClient)
// would fail with ERR_MODULE_NOT_FOUND. Aliasing `server-only` to this empty
// module in vitest.config.ts lets those modules import cleanly in tests while
// the real Next build keeps enforcing the boundary. (The standard Next.js +
// Vitest pattern.)
export {};
