import { inngest } from '@/lib/jobs/client';

// Global Inngest-send stub for the whole test suite (Story 6.6 · Subtask
// 6.6.2). As of 6.6.2 `workItemsService.createWorkItem` emits `work-item/
// created` on EVERY commit (the automation engine's trigger), and
// `updateWorkItem` emits `work-item/field.changed` on every automatable-field
// edit — both via `sendEvent` → `inngest.send`. In the test environment there
// is no event key, so a real `inngest.send` THROWS ("we couldn't find an event
// key"). Production treats the send as fire-and-forget; tests must too, or
// every create/update across the suite fails.
//
// We REPLACE `inngest.send` with a no-op at module load (a plain assignment,
// NOT a `vi.spyOn`) on purpose: many test files call `vi.restoreAllMocks()` in
// their own `beforeEach`, which would undo a spy installed here and re-expose
// the throwing real `send`. A plain reassignment is invisible to
// `restoreAllMocks`, so the no-op survives. Tests that ASSERT on emitted
// events (captureJobEvents / captureEmailEvents) `vi.spyOn(inngest, 'send')`
// ON TOP of this no-op and `mockRestore()` back down to it — so their captures
// work and their cleanup lands on the no-op, never the throwing original.

inngest.send = (async () => ({ ids: [] })) as typeof inngest.send;
