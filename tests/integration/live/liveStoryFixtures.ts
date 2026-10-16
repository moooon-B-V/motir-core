import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { formatWatchParams, type WatchedPlan } from '@/lib/workbench/planWatch';
import type { WorkbenchStreamTimers } from '@/lib/workbench/workbenchStreamSession';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';

// THE LIVE-PUSH STORY GATE'S FIXTURES (Story MOTIR-8542 · MOTIR-8733).
//
// One workspace, two members, two projects:
//   · the READER (the fixture's owner) and a second MEMBER, both active on P1, a
//     `workspace` project both may browse;
//   · P2, a `members` project the second member was never added to, holding plan B;
//   · plan G, generating in P1 — the plan a reader watches.
// So the second member's view and the project's population differ, which is what
// makes a shared or unscoped read fail the leak case rather than pass it.
//
// The stream is opened through the SHIPPED route handler with a real `Request`,
// and its body is pumped in the background into a frame log, each frame stamped
// with when it arrived — the commit-to-frame clock reads those stamps.

export type Reader = { userId: string; workspaceId: string };

export interface LiveFixture {
  fx: WorkItemFixture;
  reader: Reader;
  member: Reader;
  /** P2: `access_mode = members`, and the second member is not one. */
  closedProjectId: string;
  /** Generating, in P1. */
  planG: string;
  /** Generating, in P2. */
  planB: string;
}

export async function makeLiveFixture(identifier = 'LSG'): Promise<LiveFixture> {
  const fx = await makeWorkItemFixture({ identifier });
  const closed = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Members only',
    identifier: `${identifier}B`,
  });
  await adminDb.$executeRaw`UPDATE "project" SET "access_mode" = 'members' WHERE "id" = ${closed.id}`;
  const user = await createTestUser({
    email: `${identifier.toLowerCase()}-member@ex.com`,
    name: 'Second member',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const member = { userId: user.id, workspaceId: fx.workspaceId };
  // Both readers' streams are scoped to P1.
  for (const r of [fx.ctx, member]) {
    await projectsService.setActiveProject({ ...r, projectId: fx.projectId });
  }
  const g = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  const b = await plansService.createPlan(closed.id, { title: 'Closed plan' }, fx.ctx);
  return {
    fx,
    reader: fx.ctx,
    member,
    closedProjectId: closed.id,
    planG: g.id,
    planB: b.id,
  };
}

/** The version a reader holds for a plan right now (what a client presents). */
export async function heldVersion(planId: string, reader: Reader): Promise<string> {
  const reading = await planReviewService.readReviewVersionForReader(planId, reader);
  if (!reading) throw new Error(`reader cannot see plan ${planId}`);
  return reading.reviewVersion;
}

// ── the stream ──────────────────────────────────────────────────────────────

export interface WatermarkFrame {
  event: 'watermark';
  data: { moved: string[]; cursor: string };
  at: number;
}
export interface PlanFrame {
  event: 'plan';
  data: Record<string, unknown> & { planId: string; reviewVersion: string };
  at: number;
}
export type StreamFrame = WatermarkFrame | PlanFrame | { event: string; data: unknown; at: number };

export interface OpenStream {
  status: number;
  /** Every frame so far, in arrival order. */
  frames: StreamFrame[];
  /** `:` comment blocks (the heartbeat) — never frames. */
  comments: string[];
  /** Resolve with the first frame from `from` on that matches, or fail naming `what`. */
  next<F extends StreamFrame>(
    match: (f: StreamFrame) => f is F,
    what: string,
    opts?: { from?: number; budgetMs?: number },
  ): Promise<F>;
  /** Cancel the body — how a browser leaves. */
  close(): Promise<void>;
}

export const isWatermark = (f: StreamFrame): f is WatermarkFrame => f.event === 'watermark';
export const isPlan = (f: StreamFrame): f is PlanFrame => f.event === 'plan';
export const movedTab =
  (tab: string) =>
  (f: StreamFrame): f is WatermarkFrame =>
    isWatermark(f) && f.data.moved.includes(tab);
export const planFrameFor =
  (planId: string) =>
  (f: StreamFrame): f is PlanFrame =>
    isPlan(f) && f.data.planId === planId;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, or fail naming what was awaited. */
export async function until(condition: () => boolean, what: string, budgetMs = 8_000) {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * Build the opener for one test file: `GET` is the shipped route handler, `as`
 * points the stubbed cookie resolver at a reader. The resolver is read only
 * while the handler runs its gate, so it is safe to point it elsewhere once the
 * handler has returned.
 */
export function streamOpener(
  GET: (req: Request) => Promise<Response>,
  as: (reader: Reader) => void,
) {
  return async function open(
    reader: Reader,
    opts: { since?: string; watch?: WatchedPlan[] } = {},
  ): Promise<OpenStream> {
    const params: string[] = [];
    if (opts.since) params.push(`since=${encodeURIComponent(opts.since)}`);
    if (opts.watch?.length) params.push(formatWatchParams(opts.watch));
    as(reader);
    const res = await GET(
      new Request(
        `http://localhost:3000/api/workbench/stream${params.length ? `?${params.join('&')}` : ''}`,
      ),
    );
    const frames: StreamFrame[] = [];
    const comments: string[] = [];
    if (res.status !== 200 || !res.body) {
      return {
        status: res.status,
        frames,
        comments,
        next: async () => {
          throw new Error(`the stream answered ${res.status}`);
        },
        close: async () => {},
      };
    }
    const body = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await body.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (block.startsWith(':')) comments.push(block);
            else {
              const event = /^event: (.+)$/m.exec(block)?.[1];
              const data = /^data: (.+)$/m.exec(block)?.[1];
              if (event && data) frames.push({ event, data: JSON.parse(data), at: Date.now() });
            }
            sep = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Cancelled.
      }
    })();
    return {
      status: res.status,
      frames,
      comments,
      async next(match, what, o = {}) {
        const from = o.from ?? 0;
        let found: StreamFrame | undefined;
        await until(
          () => {
            found = frames.slice(from).find(match);
            return found !== undefined;
          },
          what,
          o.budgetMs ?? 8_000,
        );
        return found as never;
      },
      async close() {
        await body.cancel().catch(() => {});
        await pump;
      },
    };
  };
}

// ── the commit-to-frame clock ───────────────────────────────────────────────

export interface Latency {
  label: string;
  ms: number;
}

/**
 * Run `write` (committed when it resolves), then wait for the frame `match`
 * names on `stream`, and answer how long after the commit it arrived.
 */
export async function commitToFrame(
  stream: OpenStream,
  label: string,
  write: () => Promise<unknown>,
  match: (f: StreamFrame) => boolean,
): Promise<Latency> {
  const from = stream.frames.length;
  await write();
  const committedAt = Date.now();
  const frame = await stream.next(match as (f: StreamFrame) => f is StreamFrame, label, {
    from,
    budgetMs: 10_000,
  });
  return { label, ms: frame.at - committedAt };
}

/** The p95 of a set of latencies (nearest-rank). */
export function p95(latencies: Latency[]): number {
  const sorted = latencies.map((l) => l.ms).sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

// ── raw writes ──────────────────────────────────────────────────────────────

/** A fresh id for a raw INSERT, so a write never collides with a fixture row. */
export const rawId = (prefix: string) => `${prefix}-${randomUUID()}`;

// ── a timer seam the test drives by hand ────────────────────────────────────

export interface ManualTimers extends WorkbenchStreamTimers {
  /** The pending timers, by delay. */
  pending(): number[];
  /** Run every pending timer whose delay matches, and answer how many ran. */
  fire(match: (ms: number) => boolean): number;
}

export function manualTimers(): ManualTimers {
  const timers = new Map<object, { callback: () => void; ms: number }>();
  return {
    setTimeout(callback, ms) {
      const handle = { unref() {} };
      timers.set(handle, { callback, ms });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as object);
    },
    pending: () => [...timers.values()].map((t) => t.ms),
    fire(match) {
      const due = [...timers.entries()].filter(([, t]) => match(t.ms));
      for (const [handle] of due) timers.delete(handle);
      for (const [, t] of due) t.callback();
      return due.length;
    },
  };
}

/** A sanity line used by more than one case: a frame carries exactly these keys. */
export function expectPlanFrameShape(frame: PlanFrame, planId: string, notVersion: string) {
  expect(Object.keys(frame.data).sort()).toEqual(['planId', 'reviewVersion']);
  expect(frame.data.planId).toBe(planId);
  expect(frame.data.reviewVersion).not.toBe(notVersion);
}
