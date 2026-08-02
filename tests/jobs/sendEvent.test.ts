import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inngest } from '@/lib/jobs/client';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { WorkItemTransitionedData } from '@/lib/jobs/types';

// `sendEvent` is the canonical post-commit event emit. Its transport (the
// Inngest enqueue) is BEST-EFFORT: every caller emits AFTER its transaction has
// committed, so a failed enqueue must never propagate — otherwise an
// already-committed mutation surfaces as a 500 and the caller's optimistic UI
// REVERTS a change the database kept (the board-drag / status inline-edit
// "snaps back but a refresh shows it moved" bug — PROD-443).

const PAYLOAD: WorkItemTransitionedData = {
  workspaceId: 'ws-1',
  workItemId: 'wi-1',
  actorId: 'user-1',
  fromStatusKey: 'in_progress',
  toStatusKey: 'in_review',
  revisionId: 'rev-1',
};

describe('sendEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enqueues the event through the inngest client on the happy path', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    await sendEvent('work-item/transitioned', PAYLOAD);
    expect(send).toHaveBeenCalledWith({ name: 'work-item/transitioned', data: PAYLOAD });
  });

  it('is BEST-EFFORT: a transport failure resolves (does NOT throw) and is logged', async () => {
    vi.spyOn(inngest, 'send').mockRejectedValue(
      new Error('Inngest API Error: 404 Event key not found'),
    );
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The committed mutation must not be undone — resolving (not throwing) is the contract.
    await expect(sendEvent('work-item/transitioned', PAYLOAD)).resolves.toBeUndefined();
    expect(errLog).toHaveBeenCalled();
  });

  it('still THROWS on a missing workspaceId — a programming error, not a transport one', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    await expect(
      sendEvent('work-item/transitioned', { ...PAYLOAD, workspaceId: '' }),
    ).rejects.toThrow(/requires an explicit workspaceId/);
    expect(send).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-1998 — the guard's RATIONALE, extended to the events it cannot see.
//
// `sendEvent` rejects `workspaceId: ''` above because an empty string is the one
// shape that reads as "provided" while naming no tenant. `system.*` events never
// go through `sendEvent` (they are cron / harness / `inngest.send` driven), so
// nothing enforced that reasoning for them — and `system.ci-runner-boot` shipped
// `''` for exactly as long as it took someone to look. The cost was invisible:
// `''` is not nullish, so it survives `defineJob`'s `?? null`, reaches
// `job_run.workspace_id`, trips the workspace FK, and `isVanishedRunError`
// swallows the P2003 as a vanished tenant. No error, no row, no trace.
//
// A type fixes the one event (`CiRunnerBootData.workspaceId` is now `null`).
// This fixes the CLASS: no source file names an empty-string workspace id at all.
// ─────────────────────────────────────────────────────────────────────────────
const SCANNED_ROOTS = ['lib', 'app', 'components'];
/** `workspaceId: ''` / `workspaceId: ""`, however it is spaced. */
const EMPTY_WORKSPACE_ID = /workspaceId:\s*(''|"")/;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.tsx?$/.test(full)) files.push(full);
  }
  return files;
}

function scan(roots: string[]): Array<{ file: string; line: string }> {
  const root = process.cwd();
  const hits: Array<{ file: string; line: string }> = [];
  for (const scanRoot of roots) {
    for (const file of walk(join(root, scanRoot))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (EMPTY_WORKSPACE_ID.test(line)) {
          hits.push({ file: relative(root, file), line: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return hits;
}

describe('no event anywhere ships an empty-string workspaceId', () => {
  it('the scanner actually works — it finds the deliberate empty-string payload in this suite', () => {
    // ⚠️ THE POSITIVE CONTROL. Without it, a "no matches" result is worthless:
    // a wrong root, a broken regex or a walker that silently returns [] all
    // produce a green test that has checked nothing.
    const control = scan([join('tests', 'jobs')]);
    expect(control.map((h) => h.file)).toContain(join('tests', 'jobs', 'sendEvent.test.ts'));
  });

  it('lib/, app/ and components/ carry none', () => {
    const hits = scan(SCANNED_ROOTS);
    // The failure message names the file and the line, so a hit is fixed rather
    // than merely reported.
    expect(
      hits,
      `empty-string workspaceId in:\n${hits.map((h) => `  ${h.file}: ${h.line}`).join('\n')}`,
    ).toEqual([]);
  });
});
