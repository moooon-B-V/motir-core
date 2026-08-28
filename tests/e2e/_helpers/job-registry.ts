// ⚠️ THE PLAYWRIGHT RUNNER IS AN EMITTING PROCESS, SO IT HAS TO LOAD THE JOB
// REGISTRY EXPLICITLY (Story MOTIR-3418).
//
// Seed helpers in this directory call the shipped services directly — a gated
// `updateStatus` walk, a `createWorkItem`, a `createComment` — and those services
// emit POST-COMMIT (`work-item/transitioned`, `work-item/created`,
// `work-item/comment.created`). So the runner enqueues, and enqueuing needs the
// manifest: `dispatchEventToEngine` resolves an event's subscribers out of the
// tables `defineJob` fills as each definition module is evaluated.
//
// ⚠️ AND IT CANNOT LOAD ITSELF HERE, WHICH IS THE WHOLE REASON THIS FILE EXISTS.
// `lib/jobs/engine/subscribers.ts` reaches the registry through a DYNAMIC
// `import('@/lib/jobs/registry')`, deliberately: a static one closes a module
// cycle that broke `next build` outright (`docs/decisions/job-queue-foundation.md`
// §12). Every other process that emits has a bundler behind that import — webpack
// for the app server, esbuild for `scripts/worker.ts`, vite-node for Vitest — and
// the Playwright runner has none. Node receives a raw `.ts` path and refuses it:
//
//     lib/jobs/registry.ts:1
//     import { dailyHealthCheck } from './definitions/dailyHealthCheck';
//     ^^^^^^
//     SyntaxError: Cannot use import statement outside a module
//
// `sendEvent` is best-effort by contract, so that failure is SWALLOWED and logged
// and the seed carries on — with every event dropped. What a spec then sees is a
// derived status that never lands, twelve specs across five shards down, and not
// one of them naming a job. (Measured: PR #2392's first run.)
//
// ⚠️ THE SEAM USED TO BE HIDDEN BY THE CUTOVER SWITCH. `dispatchEventToEngine`
// returned before the load whenever `MOTIR_POSTGRES_JOB_IDS` named nothing, which
// in the runner was almost always — so the runner never reached the dynamic
// import, and its emits went to the vendor's dev server instead. Removing the
// switch is what made this process an engine emitter for the first time.
//
// ⚠️ A STATIC IMPORT IS THE FIX, AND IT IS THE SAME ONE `scripts/worker.ts` MAKES.
// Playwright transforms this file, so `@/lib/jobs/registry` resolves through the
// same tsconfig paths every spec's imports use, and evaluating it registers every
// job. `ensureJobManifestLoaded` then short-circuits on a populated manifest and
// never reaches the dynamic import at all.
//
// ⚠️ IT IS IMPORTED FROM `db-reset.ts` AND `shell-session.ts`, and between them
// they reach every spec that seeds — a spec resets the database or signs somebody
// in, usually both. Importing it here rather than in each seed helper keeps the
// reason in one place; a spec that emits and reaches neither would need its own
// import, and `tests/e2e/shell-a11y-tokens.spec.ts` is the only spec that touches
// neither, because it drives no service at all.
import '@/lib/jobs/registry';
