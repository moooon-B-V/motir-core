import { Inngest } from 'inngest';
import { inngestEventKey, isInngestDev } from '@/lib/env';

// The Inngest client singleton (Story 1.6 · Subtask 1.6.2). The one place the
// raw SDK client is constructed; everything else composes `defineJob` /
// `sendEvent` on top of it. `id` is the app id Inngest uses to namespace this
// service's functions in its dashboard.
//
// `eventKey` authenticates `inngest.send()` against the cloud event API
// (undefined in dev / the test harness — see lib/env.ts). `isDev` forces dev
// mode locally when INNGEST_DEV=1, so the serve route doesn't 500 in cloud mode
// (finding #30 sharp edge #2); it's left `undefined` in preview/prod so the SDK
// auto-detects cloud. The signing key is read automatically by the SDK from
// INNGEST_SIGNING_KEY (it's not a settable option here).
export const inngest = new Inngest({
  id: 'prodect-core',
  eventKey: inngestEventKey(),
  isDev: isInngestDev() || undefined,
});
